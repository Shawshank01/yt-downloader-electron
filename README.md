<p align="center">
  <img src="build/icon.svg" alt="Video Downloader Icon" width="128">
</p>

# YT Downloader

A desktop video downloader and media processor built with Electron, powered by **yt-dlp** and **FFmpeg**. Download videos and audio from YouTube, X (Twitter), Instagram, and hundreds of other sites, with support for format selection, subtitle extraction, re-encoding, and hardsubbing.

The app provides two interfaces you can switch between at any time:

- **Classic Mode**: A traditional form with URL input, action selection, and cookie/proxy settings.
- **AI Mode**: Describe what you want in plain language (e.g., *"Download this video and add an English hardsub to it"*). The app translates your request into safe `yt-dlp` or `FFmpeg` commands and runs them for you.

![YT Downloader Electron UI](public/YT-Downloader-UI.png)
*Classic UI*

![YT Downloader Electron UI AI Mode](public/YT-Downloader-UI-AI.png)
*AI Mode UI*

## Features

- **Dual interfaces**: Switch between the traditional form and a conversational AI chat at any time.
- **Broad platform support**: Downloads media using `yt-dlp` from YouTube, X, Instagram, TikTok, and more.
- **Quality & format control**: Select specific resolutions and containers, or extract audio directly (M4A, MP3, Opus, FLAC, WAV).
- **Embedded thumbnails**: Automatically attaches video thumbnails into MP4 containers.
- **Subtitle handling**: Download subtitles by language, or burn them into the video (hardsub) with top or bottom positioning.
- **MP4 re-encoding**: Convert videos to universally compatible H.264/AAC MP4 files via FFmpeg.
- **Hardware acceleration**: Takes advantage of macOS VideoToolbox for fast encoding.
- **Cookie support**: Pass cookies from Chrome, Firefox, Brave, or Safari to download age-restricted or member-only videos.
- **SOCKS5 proxy**: Route downloads and queries through a local (e.g. `127.0.0.1:1080`) or remote proxy.
- **Safe cancellation**: Stop any in-progress download or encoding job with one click; partial files are cleaned up automatically.

## Installation

### Method 1: Homebrew (macOS)

Install and update using Homebrew:

```bash
brew install --cask Shawshank01/tap/yt-downloader
```

To update in the future:

```bash
git -C "$(brew --repository Shawshank01/tap)" pull
brew upgrade --cask yt-downloader
```

### Method 2: Direct Download

1. Download the latest release from the [Releases](https://github.com/Shawshank01/yt-downloader-electron/releases) page.
2. Run the installer for your operating system:
   - **macOS:** `.dmg` (select `mac-arm64` for Apple Silicon M-series Macs)
   - **Windows:** `.exe` installer (select `win-x64` for most users)
   - **Linux:** `.AppImage`
3. **macOS First Run Note:**  
   Drag `YT Downloader.app` to `/Applications`. If macOS prevents opening it because it is not notarised, run this in Terminal:

   ```bash
   xattr -cr /Applications/"YT Downloader.app"
   ```

### Method 3: From Source

1. Clone the repository:

   ```bash
   git clone https://github.com/Shawshank01/yt-downloader-electron.git
   cd yt-downloader-electron
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Start the application:

   ```bash
   pnpm start
   ```

   *(On macOS, you can also double-click `start.command` in the project root to install dependencies and launch the app.)*

#### Building Distributables

To build an installer for your current platform:

```bash
pnpm run build
```

Installers and executables are output to the `dist/` directory.

## AI Mode Usage

Click **AI** in the top-right corner to open the chat panel. You can ask for downloads, conversions, file management, or media inspection in conversational language.

### Example Prompts

- *"Download this video: https://..."*
- *"Download this video in 720p: https://..."*
- *"Get the audio of this video as an M4A"*
- *"What subtitle languages are available for this video?"* followed by *"Hardcode the English ones at the top"*
- *"Download it, then re-encode it to a compatible MP4"*
- *"Show me what's in my download folder"* / *"Delete the leftover subtitle files"*

The assistant has access to dedicated tools for fetching video info, inspecting local media, listing formats and subtitles, downloading media/thumbnails, burning subtitles, re-encoding to MP4, and listing or deleting downloaded files.

> [!NOTE]
> The assistant can only perform actions supported by these tools (for instance, video trimming is not supported yet; it will tell you so and can suggest an `ffmpeg` command). AI mode shares the exact same download folder, browser cookies, and proxy settings as Classic mode.

### How AI Mode Works

Rather than giving an LLM direct shell access, the app executes requests through predefined, strictly validated tools:

- **No shell access**: The model cannot run arbitrary terminal commands. Every operation maps to a predefined tool that builds argument arrays directly.
- **Strict parameter validation**: URLs must use `http(s)`, file names cannot escape the designated download directory, and format codes are regex-checked.
- **Prompt injection defense & URL provenance**: Text from websites (titles, descriptions, comments) is treated as untrusted data. URLs that did not come directly from your message require explicit confirmation before downloading.
- **Configurable confirmations**: Operations considered high risk (re-encoding existing files, deleting files, downloading full playlists) prompt for confirmation before proceeding.
- **Zero framework bloat**: The AI integration is written with vanilla ES modules and standard HTTP requests—no LangChain, LlamaIndex, or heavy external agent runtimes.

### Setting Up a Provider

1. Click top right corner **AI**, then open **AI Settings**.
2. Select your provider, verify the model, paste your API key, and click **Save key**.
3. Click **Test connection**, then **Save**.
4. Choose your download folder and start chatting.

| Provider | Requirement | Notes |
| --- | --- | --- |
| **Google Gemini** (default, model `gemini-3.5-flash-lite`) | Free API key from [Google AI Studio](https://aistudio.google.com/apikey) | Free tier can be busy (HTTP 503) or rate limited, the app retries automatically. Your messages go to Google. |
| **xAI Grok** (model `grok-4.3`) | API key from the [xAI console](https://console.x.ai) | Uses xAI's Responses API at `https://api.x.ai/v1/responses`. Your messages go to Musk. |
| **Ollama (local)** | [Ollama](https://ollama.com) running with a tool-capable model, for example `LFM3:1.7b`, `Qwen3`. | Everything stays on your computer if you run a local model. Small models are faster but less reliable. |
| **OpenAI-compatible** | Server URL, model name, usually an API key | Works with llama.cpp, OpenAI, OpenRouter, Groq, LM Studio and similar. |

Additional settings:

- **Reasoning effort**: Adjust how long models think before responding (*Fast* is recommended for quick downloads).
- **Confirmation level**: Choose whether to require approval for *Risky actions only* (default), *Every action*, or *Never*.

### Privacy & Security

- **What is sent to the provider**: Only your chat prompts, assistant replies, and necessary tool outputs (video titles, format lists, filenames).
- **API key storage**: Stored securely using Electron's `safeStorage` (macOS Keychain, Windows DPAPI, Linux Secret Service). Keys never touch renderer memory or client-side storage.
- **Ephemeral conversations**: Chat history is kept in memory only during the active session. Closing the window or starting a new chat discards it completely.
- **Isolated file operations**: File operations are strictly locked to your selected download folder.

## Classic Mode Usage

Classic mode provides a straightforward, no-fuss interface:

1. Paste a video URL and select your destination folder.
2. Choose your action:
   - **Download Video (Best Quality)**: Grabs the best available stream.
   - **Download (Custom Format)**: Enter a specific format code (run **List Formats** first to view available options).
   - **Download Audio**: Extracts audio directly into your preferred format.
   - **Download Subtitles**: Displays available subtitle tracks and lets you pick which to save.
   - **Download & Re-encode to MP4**: Re-encodes with H.264/AAC for maximum playback compatibility.
   - **Download & Add Hardsub**: Burns subtitles directly into the video stream with customizable position (top or bottom).
3. If needed, select your browser under **Browser for Cookies** (helpful for age-restricted or private links) or toggle the **SOCKS5 Proxy**.
4. Click **Run**.

To stop an ongoing task, click **Cancel Action**. The active `yt-dlp` or `FFmpeg` process will exit immediately and clean up any incomplete temp files.

## Updating

The app includes a built-in update checker:

1. Click the app icon in the header to open the **About** modal, then click **Check for Updates**.
2. If an update is available, you will be prompted to open the [GitHub Releases](https://github.com/Shawshank01/yt-downloader-electron/releases/latest) page to grab the latest installer.

> [!NOTE]
> Packaged release builds bundle their own copies of `yt-dlp`, `FFmpeg`, and `Deno` (used for solving YouTube JavaScript challenges). In development runs (`pnpm start`), the app looks for tools installed on your system `PATH`.

## Troubleshooting

1. **Missing Tools in Development**
   - Development mode expects `yt-dlp` and `ffmpeg` on your `PATH`.
   - Install them via package managers:
     - **macOS:** `brew install yt-dlp ffmpeg`
     - **Linux (Ubuntu/Debian):** `sudo apt install yt-dlp ffmpeg`
     - **Windows:** Download from official releases and add to your PATH.

2. **Browser Cookies Access (macOS)**
   - When reading cookies from Chrome, Firefox, or Safari, macOS may request permission.
   - If access is denied, go to **System Settings > Privacy & Security > Files & Folders** and ensure `YT Downloader.app` is enabled.

3. **AI Mode Connection Issues**
   - **HTTP 503 (Overloaded)**: Google Gemini free tier can occasionally experience high demand. The app automatically retries; if it persists, wait a moment or try another provider.
   - **HTTP 429 (Rate Limit)**: Quota exhausted. Wait for it to reset or switch to a local Ollama model.
   - **Authentication Errors**: Open **AI Settings**, re-enter your key, and use **Test connection**.

## Project Layout

```text
src/
  main.js              Electron main process: window creation, IPC handlers
  preload.cjs          Secure context bridge (window.electronAPI)
  renderer.js          Classic mode interface logic
  ai-ui.js             AI mode interface: chat, settings, confirmation dialogs
  markdown.js          Lightweight safe Markdown renderer for chat replies
  dependencies.js      Tool resolution (bundled vs system PATH)
  check-dependencies.js Pre-flight dependency checks
  settings-store.js    Atomic JSON configuration store
  settings-schema.js   Schema validation for settings
  update.js            Release version checker
  core/                Shared yt-dlp / FFmpeg operations (Electron-free)
    tools.js           Download, query, subtitle, and media operations
    task-manager.js    Task queueing, concurrency, and cancellation
    ffmpeg.js          FFmpeg command generation and execution
  llm/                 AI execution engine (Electron-free)
    agent.js           Agent loop: tool execution, step budgeting, and event dispatch
    tool-registry.js   Tool declarations and risk classification
    tools/             Tool implementations (info, download, media, files)
    validate.js        Strict input validation for model arguments
    provenance.js      URL origin tracking to guard against indirect prompt injection
    chat-service.js    Conversation management, confirmation handling, and state
    key-store.js       Encrypted API key storage via Electron safeStorage
    providers/         Provider implementations (Gemini, xAI, Ollama, OpenAI-compatible)
test/                  Unit tests using node:test runner
```

## Contributing

Contributions, bug reports, and suggestions are welcome!

Before submitting a pull request, please ensure linting and tests pass:

```bash
pnpm run lint
pnpm test
```

The test suite runs offline using mock HTTP responses and fake model scripts. Tests cover parameter validation, provider adapters, the agent loop, safe key storage, settings schemas, and interface wiring.

## Credits

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - The core media download engine
- [FFmpeg](https://ffmpeg.org/) - Audio/video processing, transcoding, and subtitle burn-in
- [Deno](https://deno.com/) - Lightweight JS runtime for yt-dlp challenge solving
- [Electron](https://www.electronjs.org/) - Desktop application framework
