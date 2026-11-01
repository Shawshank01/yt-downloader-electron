# Project status and handoff

Snapshot of where the project stands, why it is built the way it is, what has and has not been verified, and what to do next. Written so that a new contributor, or another AI assistant, can continue without the earlier conversation.

Last updated: 2026-11-01 (app version 4.1.6 plus unreleased AI mode work).

## 1. What this project is

A desktop app (Electron 45, JavaScript ES modules, pnpm) that downloads videos with **yt-dlp** and processes them with **FFmpeg**. Release builds **bundle both tools**: `pnpm prepare-tools` (`scripts/prepare-tools.mjs`, versions pinned in `tools-versions.json`) downloads them into `build-tools/<os>-<arch>`, and electron-builder copies them to `Resources/tools` (`extraResources`). At run time `dependencies.js` prefers the bundled copy and falls back to the system `PATH` (the dev run uses system tools; on macOS the app can install them via Homebrew).

It originally had only a form-based UI ("Classic mode"). The goal of the current work is:

> Let users do everything by describing it in plain language ("Help me download this video `link`"), using the Gemini API (default, free tier) or other providers including a local Ollama model, and eventually expose everything yt-dlp and FFmpeg can do through prompts, while keeping Classic mode as a no-LLM fallback.

## 2. What has been achieved

| Phase | Result | Status |
| --- | --- | --- |
| 1. Refactor | `src/main.js` split into Electron-free modules in `src/core/`. `main.js` is thin IPC handlers. Classic behaviour unchanged. | Done, user-verified |
| 2. AI backend | `src/llm/`: 12 tools, input validation, agent loop, four provider adapters, system prompt. | Done |
| 3A. Main-process integration | Encrypted API-key storage, chat service (settings, conversation, confirmations, cancel), IPC and preload API (`window.electronAPI.ai`). | Done, user-verified (key save, connection test) |
| 3B. UI | Classic / AI switch, chat panel, AI settings dialog, Allow/Deny dialog, live progress, streamed replies, auto-scroll, shared Browser / Download Folder / SOCKS5 context controls. | Done, user-verified |
| Follow-ups | Gemini `thinkingLevel`, streamed Markdown replies, retries on HTTP 503 and similar, xAI Responses provider, Ollama streaming, empty-parameter tool schema fix, diagnostic `[ai]` log lines. | Done |
| Code-review pass (2026-11) | Correctness, duplication, security and smaller smells from a full review (see section 4 and 8). Includes the packaged-build fix for bundled tool lookup. | Done; **only unit-tested, not yet run in a real Electron window** |

Confirmed working by the user with Gemini (`gemini-3.8-flash`) before the review pass: saving a key, Test connection, chat, tool calling, downloading through the assistant using Brave cookies, error explanation and retry, rendering of replies.

## 3. Architecture

```text
Renderer (window)                          Main process (Node)
-----------------                          -------------------
renderer.js   Classic UI  ---IPC--->       main.js  (thin handlers, per-request event routing)
ai-ui.js      AI UI       ---IPC--->         |-- settings-store.js / settings-schema.js
markdown.js   safe render                    |-- core/tools.js  <-----------------+
                                             |     (yt-dlp / ffmpeg operations)    |
                                             |-- llm/chat-service.js               |
                                             |     |-- ai-settings.js              |
                                             |     |-- conversation.js             |
                                             |     |-- confirmations.js            |
                                             |     '-- agent.js (loop)             |
                                             |           |-- providers/*           |
                                             |           '-- tool-registry.js ----+
                                             |                 '-- tools/*
                                             '-- llm/key-store.js (safeStorage)
```

### Layout

```text
src/main.js              Window, IPC handlers (Classic + ai-* channels). 'ai-send' routes events to the
                         requesting window and cancels the request if that window closes or reloads.
src/preload.cjs          contextBridge: window.electronAPI and .ai (must stay CommonJS)
src/renderer.js          Classic UI (classic script, not a module; large and untested, see section 8)
src/ai-ui.js             AI UI (classic script, IIFE, uses window.electronAPI.ai)
src/markdown.js          Safe Markdown renderer (classic script, exposes window.MarkdownLite)
src/settings-store.js    user-settings.json: queued merges, atomic writes, explicit first-run defaults
src/settings-schema.js   Allow-list for the generic 'set-settings' IPC channel
src/dependencies.js      PATH setup (login-shell PATH is cached), bundled-tool lookup, dependency checks
src/core/                Electron-free: tools.js, task-manager.js, ffmpeg.js, media-files.js,
                         log-filter.js, logger.js (redacts proxy credentials)
src/llm/                 Electron-free:
  chat-service.js          Coordinates one request (settings, conversation, confirmations, agent)
  ai-settings.js           AI settings, API key slots, provider construction
  provider-settings.js     Validation (AiSettingsError, sanitizeProviderConfig, allowed browsers, proxy pattern)
  context.js               Single definition of a valid request context; requireFolder()
  conversation.js          History, trimming, repair after a failed turn
  confirmations.js         Pending Allow/Deny prompts with timeout
  agent.js, agent-events.js  Model/tool loop; log + event routing
  provenance.js            Is a URL one the user typed?
  tool-registry.js         Assembles tools/ ; getTool, getRisk, getToolDeclarations
  tools/                   names.js (TOOL_NAMES), common.js (defineTool, helpers),
                           info.js, download.js, media.js, files.js, control.js
  providers/               gemini, xai, ollama, openai-compatible, index (PROVIDER_TYPES capabilities),
                           http.js (requestJson/requestStream, retries), stream.js (SSE / NDJSON readers)
  prompt.js, messages.js, limits.js, redact.js, validate.js, errors.js, key-store.js
test/                    node:test suite (130 tests)
```

`core/` and `llm/` never import Electron. Anything Electron-specific (safeStorage, userData path, windows) is injected from `main.js`.

### Tools the model can call (`src/llm/tools/`)

`get_video_info`, `list_formats`, `list_subtitles` (info.js); `download_video` (max_height / format_code / container / playlist), `download_audio` (mp3, m4a, opus, flac, wav, best), `download_thumbnail`, `download_subtitles` (download.js); `download_with_hardsub`, `reencode_mp4` (media.js); `list_downloads`, `delete_files` (files.js); `cancel_task` (control.js).

Tools are declared with `defineTool()` using names from `TOOL_NAMES`; the system prompt and the agent's `cancel_task` check use the same constants, and a test fails if the prompt mentions a tool or parameter that does not exist. Each tool has a `risk` (`low`/`high`, optionally a function of the arguments), a `describe()` text for the confirmation dialog, and a `run(args, ctx)` that validates everything and builds yt-dlp/ffmpeg **argument arrays**. High risk: hardsub, re-encode, delete_files, any `playlist: true` download, and any call whose `url` the user did not type (see invariant 11).

### Providers

`PROVIDER_TYPES` (`providers/index.js`) declares each provider's capabilities: `needsApiKey`, `editableBaseUrl`, `lockedBaseUrlError`, and `options` (for example Gemini `thinkingLevel`, xAI `reasoningEffort`). Settings and validation read these flags, so adding a provider should not require edits to `chat-service.js`. All providers use `requestJson` / `requestStream` (`http.js`) and the shared stream readers (`stream.js`). Tunable limits (steps, history, timeouts, retries' timeouts, confirmation timeout) live in `limits.js`; user-facing and model-facing strings in `messages.js`.

### Neutral message format (all providers translate to/from this)

```text
{ role: 'user', text }
{ role: 'assistant', text, toolCalls: [{ id, name, args, providerCallId? }], raw? }
{ role: 'tool', toolCallId, providerCallId?, name, result }
```

`raw` stores provider-specific response parts. Gemini 3 requires "thought signatures" to be returned with function calls, so the Gemini adapter replays `raw.parts` verbatim.

### Agent loop (`agent.js`)

Call model, run requested tools **one at a time** (the app allows one yt-dlp/ffmpeg task at once), feed results back, repeat until a plain-text answer or `MAX_AGENT_STEPS` (8). Tool results are shaped to `MAX_TOOL_RESULT_CHARS`. Events (`assistant_delta`, `assistant_text`, `tool_start`, `tool_result`, `tool_denied`, `confirm_request` with an optional `reason`, `retrying`, `progress`) go to the window that sent the request. `Conversation.failTurn()` keeps history valid after an error (answers unanswered tool calls, records the failure). Abort cancels the model call and the running process.

## 4. Design decisions and invariants (do not break these)

1. **The model never gets a shell and never supplies raw flags.** Tools build argument arrays from validated values (`validate.js`). URLs must be `http(s)` without whitespace; file names cannot contain `/`, `\` or `..`; language and format codes are pattern-checked.
2. **The download folder, cookie browser and proxy come from the user's UI settings**, not from the model. `context.js` re-validates them on every message (absolute existing directory; browser from an allowlist; proxy URL pattern).
3. **Risky actions need confirmation** (`always` / `risky` default / `never`). With no confirm callback, risky actions are denied. An unanswered prompt is denied after 5 minutes.
4. **Tool output is untrusted data** (video titles, subtitles, error text): the system prompt says so. Replies are rendered with DOM calls only. **Never use `innerHTML` for model text** (a test enforces this in `ai-ui.js`).
5. **API keys never reach the renderer.** Stored per provider with Electron `safeStorage` in `ai-keys.json`; if encryption is unavailable they stay in memory only. Error messages are scrubbed of every stored key plus any key typed in the settings form. Providers that take an API key (Gemini, xAI) have a fixed endpoint so the key cannot be redirected.
6. **`set-settings` (the generic IPC handler) is an allow-list** (`settings-schema.js`: `downloadFolder`, `browser`, `subtitlePosition`, `proxyEnabled`, `proxyAddress`, each type-checked). AI settings go only through the validated `ai-*` handlers.
7. **AI downloads default to `--no-playlist`.**
8. **Temporary files are not deleted automatically.** The classic UI asks first; the assistant must use the confirmed `delete_files` tool. `delete_files` only touches direct children of the download folder (`resolveInFolder`). The classic `delete-temporary-files` handler only deletes files that a finished re-encode/hardsub reported in `tmpFiles` (it cannot delete arbitrary paths).
9. **Classic mode must keep working with no AI configured.** `core/tools.js` is shared by both modes; there is one `TaskManager`, so a Classic task blocks an AI task and vice versa.
10. **Conversations are in memory only** (max 40 messages kept). Nothing is logged to disk; `[ai]` lines never contain keys, messages or replies. The core logger redacts credentials in URLs and `--proxy` values.
11. **A URL the user did not type is high risk.** If a tool call's `url` is not in any user message (it may have come from a web page the model read), the agent treats the call as high risk and the dialog explains why (`provenance.js`). This is the main defence against prompt injection through low-risk tools; it does not cover other kinds of steering, so keep the "untrusted data" prompt rule and the high-risk confirmations.
12. **Events and confirmations go to the window that started the request.** If that window is destroyed, crashes or navigates away, the request and any running task are cancelled.

## 5. Provider facts learned (verify again, these change quickly)

**Gemini** (`providers/gemini.js`)

- REST `generateContent` (non-streaming) and `streamGenerateContent?alt=sse` (streaming), header `x-goog-api-key` (never in the URL). Default model `gemini-3.8-flash`; the ID is editable.
- Gemini 3.8 Flash defaults to `thinkingLevel: medium`, which was slow. The app sends `low` by default (low / medium / high). **`minimal` is rejected.** If a model rejects the thinking config (HTTP 400 mentioning "thinking"), the request is retried once without it; this works for streaming too.
- Function declarations with empty `parameters.properties` have been rejected (400). Parameter-less tools are declared with only name and description (`toGeminiDeclaration`).
- Streaming keeps text and function-call parts from all SSE chunks even when the final chunk has only metadata. Invalid stream data is reported as an error rather than skipped.
- Free tier returns **HTTP 503 "high demand"** at times and 429 when out of quota.
- Google calls `generateContent` "legacy" and recommends the **Interactions API**. `generateContent` still works. Migration is on the roadmap.

**xAI** (`XaiProvider`, type `xai`): `https://api.x.ai/v1`, default model `grok-4.3`, own key slot, key required, Responses API (`/responses`) with native function calling and SSE streaming. The endpoint is fixed; the UI exposes reasoning effort (`none`, `low`, `medium`, `high`, `xhigh`).

**Ollama**: `/api/chat`, needs a tool-capable model, streamed NDJSON. Unsupported-tools and unreachable-server errors are turned into actionable messages for both streaming and non-streaming calls. The configured default model is a placeholder and has not been evaluated.

**Retries** (`providers/http.js`): `DEFAULT_RETRIES` is **2** (up to 3 attempts), 1.5 s doubling, only for HTTP 500/502/503/504 and connection errors; not for 4xx, 429 or a request that already hit its timeout. They apply to requests before a streamed response starts. Cancelling during the wait stops immediately. The UI shows "retrying". Tests derive their expectations from `DEFAULT_RETRIES`.

## 6. Where data lives

macOS (dev run): `~/Library/Application Support/yt-downloader-electron/` (a packaged build may use its product name).

| File | Content |
| --- | --- |
| `user-settings.json` | Classic settings plus `aiMode`, `aiProvider`, `aiConfirmMode`, `aiProviderConfigs`. No secrets. Written atomically; a missing file means first run (defaults to AI mode), an unreadable one is treated as empty and logged. |
| `ai-keys.json` | API keys, encrypted (`safeStorage`), file mode 0600. |
| OS temp folder | Short-lived yt-dlp "manifest" files, deleted after each download. |

## 7. Testing and verification

```bash
pnpm install
pnpm run lint     # ESLint, src/ and test/
pnpm test         # node --test test/   (130 tests, about 2 s, no network, no API key)
```

Test files: `validate`, `providers` (adapters with mocked `fetch`, retries), `agent` (scripted fake model), `chat-service`, `llm-core` (conversation, confirmations, redaction, streaming, prompt/registry consistency, security checks), `infrastructure` (settings store, logger, bundled-tool detection), `api-contract` (`electron.d.ts` matches `preload.cjs`; every invoked IPC channel has a handler), `key-store`, `markdown`, `ui-wiring` (static checks: element IDs, script order, no `innerHTML`).

CI (`.github/workflows/lint.yml`) runs lint and tests on pushes and pull requests to `main` that touch `src/`, `test/`, `*.js`, `package.json`, the lockfile or the workflow. Run the tests on a clean checkout before pushing; a local working tree can differ from what CI sees (this once hid a changed retry default).

**Not covered by automated tests / not verified live:**

- The Electron window: no end-to-end test exists. UI behaviour is checked only by static tests plus manual runs.
- **Everything changed in the 2026-11 review pass has been verified only by unit tests.** Click through before releasing: mode switch, a chat turn with streaming, an Allow/Deny dialog (including the new "address was not in your message" text), Stop mid-download, closing/reloading the window during a request, saving AI settings, a packaged build finding the bundled `yt-dlp`/`ffmpeg`.
- Live runs of: hardsub / re-encode / delete via the assistant, the thinking-level setting, xAI, Ollama, the generic OpenAI-compatible provider, Windows and Linux (safeStorage and PATH behaviour differ).
- The xAI and Ollama adapters have only been tested against mocked responses.

## 8. Known limitations and rough edges

- The assistant can do only what the 12 tools allow. **No trimming, GIFs, joining, resizing, speed change, SponsorBlock, chapter/metadata editing, downloading a time range, or audio extraction from a local file.** It says so and suggests a command instead.
- One conversation at a time; history is lost on New chat or quit; capped at 40 messages.
- UI strings and the system prompt are English only (the model answers in the user's language). `messages.js` centralises the text but is not a translation layer.
- **`renderer.js` (about 1,200 lines) and `ai-ui.js` (about 760 lines) are large classic scripts** sharing global state and DOM IDs. They were deliberately not split because nothing but a manual click-through can catch wiring mistakes. If you split them, do it with a smoke test of each dialog.
- Re-encoding an `.mp4` replaces the original file (flagged high risk and described in the confirmation text).
- Small local models have not been evaluated; expect weaker tool selection.
- The login-shell `PATH` is read once per app run, so changes to shell config are picked up after a restart.
- `src/index.html` has no Content-Security-Policy and `open-external` in `main.js` only checks that the argument is a non-empty string (the renderer limits AI links to `http(s)`).

## 9. Roadmap (suggested order)

### A. Close the capability gap (the original goal)

1. Typed tools, each validated and building its own arguments: `trim_video` (start/end, stream copy or re-encode), `convert_media`, `extract_audio_from_file`, `make_gif`, `compress_video` (target size or CRF), `merge/concat`, `change_speed`, `resize`, `download_section` (`--download-sections`), SponsorBlock, chapters/metadata, playlist ranges. Add them as new files under `src/llm/tools/` with a name in `TOOL_NAMES`.
2. Then a **guarded passthrough** (`run_ytdlp`, `run_ffmpeg`) for the long tail: flag **allowlist** (not denylist); block `--exec`, `--exec-before-download`, `--config-locations`, `--plugin-dirs`, `--cookies-from-browser` changes, output templates escaping the folder; for ffmpeg, restrict input/output paths to the download folder and block protocol/file-reading filters (`concat:`, `movie=`, `subtitles=` on outside files, `drawtext` with `textfile`, lavfi network sources); always show the exact command and require confirmation.
3. Add tests for every new tool, including path-escape and flag-injection cases.

### B. UX

Show the command a step ran (collapsible), "Reveal in Finder / Open folder" button, real progress bar, drag-and-drop URL or file, clipboard URL detection, opt-in saved chat history with export and "delete all", opt-in log file, localisation, and (with a smoke test) splitting `ai-ui.js` / `renderer.js`.

### C. Providers

Migrate Gemini to the Interactions API; add a model dropdown from each provider's list-models endpoint; honour `Retry-After`; optional automatic fallback to another model or provider after repeated 503; Anthropic adapter (add it to `PROVIDER_TYPES`); token and cost display; evaluate and document recommended Ollama models.

### D. Quality and security

Electron end-to-end smoke test (Playwright for Electron, run outside restricted sandboxes); prompt to tool-call evaluation suite per provider (including small models); prompt-injection tests with malicious titles and subtitles; add a CSP meta tag and a `will-navigate` guard; restrict `open-external` to `http(s)` and known schemes; test the packaged app on Windows and Linux; AI-mode screenshots in the README.

## 10. Working agreements for whoever continues

- Work in small steps and run `pnpm run lint` and `pnpm test` after each; add or update tests with every change.
- Do not commit or push on the owner's behalf; the owner commits manually.
- Keep `core/` and `llm/` free of Electron imports. Keep renderer scripts as classic scripts. Keep `preload.cjs` CommonJS. Keep `electron.d.ts` in step with `preload.cjs` (a test checks it).
- Put new limits in `limits.js`, new user/model-facing strings in `messages.js`, new tool names in `TOOL_NAMES`, new provider capabilities in `PROVIDER_TYPES`.
- Add dependencies only when justified (none have been added by the AI work).
- Never log or return API keys; never render model text as HTML; never let the model choose paths or raw flags.
- State plainly what was and was not tested, especially anything that touches the Electron window.
- Do not rely on memory for provider APIs and model IDs; check current documentation.
