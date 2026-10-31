# Project status and handoff

Snapshot of where the project stands, why it is built the way it is, what has and has not been verified, and what to do next. Written so that a new contributor, or another AI assistant, can continue without the earlier conversation.

Last updated: 2026-10-31 (app version 3.10.1 plus unreleased AI mode work).

## 1. What this project is

A desktop app (Electron 41, JavaScript ES modules, pnpm) that downloads videos with **yt-dlp** and processes them with **FFmpeg**. Neither tool is bundled; the user installs them (the app checks and can install via Homebrew on macOS).

It originally had only a form-based UI ("Classic mode"). The goal of the current work is:

> Let users do everything by describing it in plain language ("Help me download this video <link>"), using the Gemini API (default, free tier) or other providers including a local Ollama model, and eventually expose everything yt-dlp and FFmpeg can do through prompts, while keeping Classic mode as a no-LLM fallback.

## 2. What has been achieved

| Phase | Result | Status |
|---|---|---|
| 1. Refactor | `src/main.js` (about 1,150 lines) split into Electron-free modules in `src/core/`. `main.js` is now thin IPC handlers. Classic behaviour unchanged. | Done, user-verified |
| 2. AI backend | `src/llm/`: 12 tools, input validation, agent loop, three provider adapters, system prompt. | Done |
| 3A. Main-process integration | Encrypted API-key storage, chat service (settings, conversation, confirmations, cancel), IPC and preload API (`window.electronAPI.ai`). | Done, user-verified (key save, connection test) |
| 3B. UI | Classic / AI switch, chat panel, AI settings dialog, Allow/Deny dialog, live progress. | Done, user-verified |
| Follow-ups | Gemini `thinkingLevel` (default `low`), Markdown rendering of replies, automatic retries on HTTP 503 and similar, xAI provider preset, empty-parameter tool schema fix, diagnostic `[ai]` log lines. | Done |

Confirmed working by the user with Gemini (`gemini-3.8-flash`): saving a key, Test connection, chat, tool calling, downloading a video through the assistant using Brave cookies, error explanation and retry, and rendering of replies.

## 3. Architecture

```
Renderer (window)                         Main process (Node)
-----------------                         -------------------
renderer.js   Classic UI  ---IPC--->      main.js  (thin handlers)
ai-ui.js      AI UI       ---IPC--->        |-- core/tools.js  <---------------+
markdown.js   safe render                   |     (yt-dlp / ffmpeg operations)  |
                                            |-- llm/chat-service.js             |
                                            |      settings, history, confirm   |
                                            |      |-- llm/agent.js  (loop)     |
                                            |      |-- llm/providers/*          |
                                            |      '-- llm/tool-registry.js ----+
                                            '-- llm/key-store.js (safeStorage)
```

### Layout

```
src/main.js            Window, settings file, IPC handlers (Classic + ai-* channels)
src/preload.cjs        contextBridge: window.electronAPI and window.electronAPI.ai (must stay CommonJS)
src/renderer.js        Classic UI (classic script, not a module)
src/ai-ui.js           AI UI (classic script, IIFE, uses window.electronAPI.ai)
src/markdown.js        Safe Markdown renderer (classic script, exposes window.MarkdownLite)
src/core/              Electron-free: tools.js, task-manager.js, ffmpeg.js, media-files.js, log-filter.js
src/llm/               Electron-free: agent.js, chat-service.js, tool-registry.js, validate.js,
                       key-store.js, prompt.js, errors.js, providers/{gemini,ollama,openai-compatible,index,http}.js
test/                  node:test suite (101 tests), excluded from the installer
docs/                  This file (excluded from the installer)
```

`core/` and `llm/` never import Electron. Anything Electron-specific (safeStorage, userData path, windows) is injected from `main.js`. This is what makes them unit-testable.

### Tools the model can call (`src/llm/tool-registry.js`)

`get_video_info`, `list_formats`, `download_video` (max_height / format_code / container / playlist), `download_audio` (mp3, m4a, opus, flac, wav, best), `download_thumbnail`, `list_subtitles`, `download_subtitles`, `download_with_hardsub`, `reencode_mp4`, `list_downloads`, `delete_files`, `cancel_task`.

Each tool has a JSON-schema, a `risk` (`low` or `high`, optionally a function of the arguments), a `describe()` text for the confirmation dialog, and a `run(args, ctx)` that validates everything and builds yt-dlp/ffmpeg **argument arrays**. High risk: hardsub, re-encode, delete_files, and any `playlist: true` download.

### Neutral message format (all providers translate to/from this)

```
{ role: 'user', text }
{ role: 'assistant', text, toolCalls: [{ id, name, args, providerCallId? }], raw? }
{ role: 'tool', toolCallId, providerCallId?, name, result }
```

`raw` stores provider-specific response parts. Gemini 3 requires "thought signatures" to be returned with function calls, so the Gemini adapter replays `raw.parts` verbatim.

### Agent loop (`agent.js`)

Call model, run requested tools **one at a time** (the app allows one yt-dlp/ffmpeg task at once), feed results back, repeat until a plain-text answer or `maxSteps` (8). Tool results are shaped to a size limit. Events (`assistant_text`, `tool_start`, `tool_result`, `tool_denied`, `confirm_request`, `retrying`, `progress`) are streamed to the UI. Abort cancels the model call and the running process.

## 4. Design decisions and invariants (do not break these)

1. **The model never gets a shell and never supplies raw flags.** Tools build argument arrays from validated values (`validate.js`). URLs must be `http(s)` without whitespace; file names cannot contain `/`, `\` or `..`; language and format codes are pattern-checked.
2. **The download folder, cookie browser and proxy come from the user's UI settings**, not from the model. The main process re-validates them on every message (absolute existing directory; browser from an allowlist; proxy URL pattern).
3. **Risky actions need confirmation** (`always` / `risky` default / `never`). With no confirm callback, risky actions are denied.
4. **Tool output is untrusted data** (video titles, subtitles, error text): the system prompt says so. Replies are rendered with DOM calls only. **Never use `innerHTML` for model text** (a test enforces this in `ai-ui.js`).
5. **API keys never reach the renderer.** Stored per provider with Electron `safeStorage` in `ai-keys.json`; if encryption is unavailable they stay in memory only. Errors are redacted. Gemini's base URL is locked so the key cannot be redirected.
6. **`set-settings` (the old IPC handler) ignores any key starting with `ai`**; AI settings go only through validated `ai-*` handlers.
7. **AI downloads default to `--no-playlist`.** The classic UI did not do this; it is deliberate so a model cannot pull a whole playlist by accident.
8. **Temporary files are not deleted automatically.** The classic UI asks first; the assistant must use the confirmed `delete_files` tool.
9. **Classic mode must keep working with no AI configured.** `core/tools.js` is shared by both modes; there is one `TaskManager`, so a Classic task blocks an AI task and vice versa.
10. **Conversations are in memory only** (max 40 messages kept). Nothing is logged to disk; `[ai]` lines go to the terminal and never contain keys, messages or replies.

## 5. Provider facts learned (verify again, these change quickly)

**Gemini** (`src/llm/providers/gemini.js`)
- REST `generateContent`, header `x-goog-api-key` (key never in the URL). Default model `gemini-3.8-flash`; the ID is editable.
- Gemini 3.8 Flash defaults to `thinkingLevel: medium`, which was slow. The app sends `low` by default (user setting: low / medium / high). **`minimal` is rejected** by this model. If a model rejects thinking config (HTTP 400 mentioning "thinking"), the request is retried once without it.
- Function declarations with empty `parameters.properties` have been rejected by Gemini (400). Parameter-less tools are declared with only name and description (`toGeminiDeclaration`).
- Free tier returns **HTTP 503 "high demand"** at times and 429 when out of quota.
- Google now calls `generateContent` "legacy" and recommends the **Interactions API** (`/v1beta/interactions`). `generateContent` is still supported. Migration is on the roadmap.

**xAI** is a preset on `OpenAICompatibleProvider` (type `xai`): base URL `https://api.x.ai/v1`, default model `grok-4.7`, its own key slot, key required. It uses the Chat Completions endpoint, which xAI also labels legacy (they recommend the Responses API).

**Ollama**: `/api/chat`, requires a tool-capable model. Default model `qwen3:4b` is only a placeholder and has not been evaluated.

**Retries** (`providers/http.js`): up to 3 retries, 1.5 s doubling, only for HTTP 500/502/503/504 and connection errors; not for 4xx, 429 or a request that already hit its timeout. Cancelling during the wait stops immediately. The UI shows "retrying".

## 6. Where data lives

macOS (dev run): `~/Library/Application Support/yt-downloader-electron/` (a packaged build may use its product name).

| File | Content |
|---|---|
| `user-settings.json` | Classic settings plus `aiMode`, `aiProvider`, `aiConfirmMode`, `aiProviderConfigs` (model, base URL, thinking level per provider). No secrets. |
| `ai-keys.json` | API keys, encrypted (`safeStorage`), file mode 0600. |
| OS temp folder | Short-lived yt-dlp "manifest" files, deleted after each download. |

## 7. Testing and verification

```bash
pnpm install
pnpm run lint     # ESLint, src/ and test/
pnpm test         # node --test test/   (101 tests, about 2 s, no network, no API key)
```

Test files: `validate`, `providers` (Gemini/Ollama/OpenAI-compatible/xAI with mocked `fetch`, retries), `agent` (scripted fake model), `chat-service` (settings, keys, confirmations, cancel, retry events), `key-store`, `markdown` (including hostile and pathological input), `ui-wiring` (static checks: element IDs exist, preload channels match main handlers, script order, no `innerHTML`).

CI (`.github/workflows/lint.yml`) runs lint and tests on push and pull requests touching `src/`, `test/`, `*.js`, `package.json`.

**Not covered by automated tests / not verified live:**
- The Electron window itself: no end-to-end test exists. Earlier work was developed in an environment where Electron could not start, so **all UI behaviour was checked only by static tests plus the user running the app**.
- Live runs of: the Allow/Deny dialog, hardsub / re-encode / delete via the assistant, the Stop button mid-download, the thinking-level setting, retry display, xAI, Ollama, the generic OpenAI-compatible provider, Windows and Linux (safeStorage and PATH behaviour differ).
- The xAI adapter has only been tested against mocked responses.

## 8. Known limitations and rough edges

- The assistant can do only what the 12 tools allow. **No trimming, GIFs, joining, resizing, speed change, SponsorBlock, chapter/metadata editing, downloading a time range, or audio extraction from a local file.** It says so and suggests a command instead.
- Replies appear all at once (no streaming).
- One conversation at a time; history is lost on New chat or quit; capped at 40 messages.
- UI strings and the system prompt are English only (the model answers in the user's language).
- The classic code logs the full `PATH` on every yt-dlp run (terminal noise, pre-existing).
- Re-encoding an `.mp4` replaces the original file (flagged high risk and described in the confirmation text).
- Small local models have not been evaluated; expect weaker tool selection.
- `src/index.html` has no Content-Security-Policy and `open-external` in `main.js` only checks that the argument is a non-empty string (the renderer limits AI links to `http(s)`).

## 9. Roadmap (suggested order)

**A. Close the capability gap (the original goal)**
1. Typed tools, each validated and building its own arguments: `trim_video` (start/end, stream copy or re-encode), `convert_media`, `extract_audio_from_file`, `make_gif`, `compress_video` (target size or CRF), `merge/concat`, `change_speed`, `resize`, `download_section` (`--download-sections`), SponsorBlock, chapters/metadata, playlist ranges.
2. Then a **guarded passthrough** (`run_ytdlp`, `run_ffmpeg`) for the long tail: flag **allowlist** (not denylist); block `--exec`, `--exec-before-download`, `--config-locations`, `--plugin-dirs`, `--cookies-from-browser` changes, output templates escaping the folder; for ffmpeg, restrict input/output paths to the download folder and block protocol/file-reading filters (`concat:`, `movie=`, `subtitles=` on outside files, `drawtext` with `textfile`, lavfi network sources); always show the exact command and require confirmation.
3. Add tests for every new tool, including path-escape and flag-injection cases.

**B. UX**
Show the command a step ran (collapsible), "Reveal in Finder / Open folder" button, real progress bar, streaming replies, drag-and-drop URL or file, clipboard URL detection, opt-in saved chat history with export and "delete all", opt-in log file, remove the `PATH` log noise, localisation.

**C. Providers**
Migrate Gemini to the Interactions API; xAI Responses API; model dropdown from each provider's list-models endpoint; honour `Retry-After`; optional automatic fallback to another model or provider after repeated 503; Anthropic adapter; token and cost display; evaluate and document recommended Ollama models.

**D. Quality and security**
Electron end-to-end smoke test (Playwright for Electron, run outside restricted sandboxes); prompt to tool-call evaluation suite per provider (including small models); prompt-injection tests with malicious titles and subtitles; add a CSP meta tag and a `will-navigate` guard; restrict `open-external` to `http(s)` and known schemes; test the packaged app on Windows and Linux; AI-mode screenshots in the README.

## 10. Working agreements for whoever continues

- Work in small steps and run `pnpm run lint` and `pnpm test` after each; add or update tests with every change.
- Do not commit or push on the owner's behalf; the owner commits manually.
- Keep `core/` and `llm/` free of Electron imports. Keep renderer scripts as classic scripts. Keep `preload.cjs` CommonJS.
- Add dependencies only when justified (none have been added so far; the lockfile is unchanged by the AI work).
- Never log or return API keys; never render model text as HTML; never let the model choose paths or raw flags.
- State plainly what was and was not tested, especially anything that touches the Electron window.
- Do not rely on memory for provider APIs and model IDs; check current documentation.

## 11. Suggested commit

Message: `Add AI assistant mode (Gemini, xAI, Ollama, OpenAI-compatible), refactor core into shared modules, add tests`

New: `src/core/`, `src/llm/`, `src/ai-ui.js`, `src/markdown.js`, `test/`, `docs/`.
Changed: `src/main.js`, `src/preload.cjs`, `src/index.html`, `src/styles.css`, `src/types/electron.d.ts`, `package.json` (test and lint scripts, installer excludes `test/` and `docs/`), `eslint.config.js`, `.github/workflows/lint.yml`, `README.md`.
