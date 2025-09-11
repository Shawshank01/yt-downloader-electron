<p align="center">
  <img src="build/icon.svg" alt="Video Downloader Icon" width="128">
</p>

# Video Downloader (Electron)

A modern, user-friendly desktop application for downloading videos from YouTube and other supported platforms using yt-dlp and ffmpeg.

## Features

- 🎥 Download videos in various formats and qualities
- 📝 Download subtitles
- 🍪 Browser cookie support (Brave, Chrome, Firefox, Safari)
- 📂 Custom download folder selection
- 📊 Real-time download progress
- 🎯 Format selection with detailed format list
- 🔄 MP4 re-encoding with H.264/AAC codecs for maximum compatibility

## 🚩 Important: yt-dlp and ffmpeg Are Not Bundled

**This app does NOT bundle `yt-dlp` or `ffmpeg` inside the installer.**  
You must have both `yt-dlp` and `ffmpeg` installed on your system for the app to work.

- **On macOS:**  
  The app will check for Homebrew and prompt to install it if not present. It will then attempt to install `yt-dlp` and `ffmpeg` automatically via Homebrew if they're missing.
- **On Linux:**  
  Please install `yt-dlp` and `ffmpeg` using your package manager before use (see below).
- **On Windows:**  
  Please install [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) and [ffmpeg](https://ffmpeg.org/download.html) manually and make sure they are available in your PATH.

## Prerequisites

- **macOS:** (tested on macOS 14+)
  - [Homebrew](https://brew.sh/) will be installed automatically if missing
  - `yt-dlp` and `ffmpeg` (will be installed automatically via Homebrew if missing)
- **Linux:**  
  - `yt-dlp` and `ffmpeg` (install via `apt`, `dnf`, or other package manager)
- **Windows:**  
  - `yt-dlp` and `ffmpeg` (must be installed manually and available in PATH)

## Installation

### Method 1: Direct Download (Recommended for Users)

1. Download the latest release from the [Releases](https://github.com/Shawshank01/yt-downloader-electron/releases) page.
2. Extract the downloaded file and run the installer for your OS:
    - **macOS:** `.dmg` (or `.zip`)
    - **Linux:** `.AppImage` or `.deb`
    - **Windows:** `.exe` installer
3. **First Run:**
    - On **macOS**, the app will try to install dependencies with Homebrew if missing.
    - On **Linux/Windows**, you must install `yt-dlp` and `ffmpeg` yourself if not already present (see troubleshooting below).

### Method 2: From Source (For Developers)

1. Clone the repository:
   ```bash
   git clone https://github.com/Shawshank01/yt-downloader-electron.git
   cd yt-downloader-electron
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm start
   ```

4. **Developer note:**  
   - The app expects `yt-dlp` and `ffmpeg` to be available in your system’s PATH.
   - On macOS, you can use Homebrew; on Linux use your package manager; on Windows install them manually.

### Building Distributables (Developers)

To build the application for your platform:
```bash
npm run build
```
This will create a distributable package in the `dist` directory.

## Usage

1. **Basic Video Download**
   - Enter the video URL
   - Select "Download Video (Best Quality)"
   - Choose your browser for cookies (if needed)
   - Select a download folder
   - Click "Run"

2. **Format Selection**
   - Enter the video URL
   - Select "List Formats" to see available formats
   - Choose "Choose Format" and enter the format code
   - Click "Run"

3. **Subtitle Download**
   - Enter the video URL
   - Select "Download Subtitles"
   - Click "Run"

4. **MP4 Re-encoding (H.264/AAC)**
   - Enter the video URL
   - Select "Download & Re-encode as MP4 (H.264/AAC)"
   - Click "Run"
   - The video will be downloaded and then re-encoded using ffmpeg with:
     - Video: H.264 (libx264) with CRF 18 and veryslow preset for maximum quality
     - Audio: AAC (libfdk_aac preferred, falls back to aac if not available)
     - Container: MP4 with proper AVC1 tag

## Updating

The app includes a built-in update checker:

1. Click the "Check for Updates" button to:
   - Check for a new version of the app
   - See your current version
2. If a new version is available, you will be prompted to open the [GitHub Releases](https://github.com/Shawshank01/yt-downloader-electron/releases/latest) page to download the latest installer for your platform (macOS, Windows, or Linux).
3. If you are already on the latest version, the app will let you know that you are up to date.

**Update button is only supported when running the packaged app** (from `.dmg`, `.exe`, or `.AppImage`/`.deb`). If you run the app in development mode (using `start.command` or `npm start`), update may not be available.

**Note:**
- The app cannot update `yt-dlp` or `ffmpeg` automatically on Windows or Linux—you must update them yourself (see Troubleshooting below).
- On macOS, the app can help install or update dependencies via Homebrew if needed.

## Troubleshooting

1. **Missing Dependencies**
   - The app will try to help you install dependencies if possible.
   - If manual installation is needed:
     - **macOS:**  
       ```bash
       brew install yt-dlp ffmpeg
       ```
     - **Linux (Ubuntu/Debian):**  
       ```bash
       sudo apt install yt-dlp ffmpeg
       ```
     - **Windows:**  
       - Download [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) and [ffmpeg](https://ffmpeg.org/download.html)
       - Add them to your system PATH

2. **Update Issues**
   - If updates fail, try updating `yt-dlp` and `ffmpeg` manually (see above).

3. **Browser Cookie Issues**
   - Make sure you're logged into YouTube in your selected browser
   - Try a different browser if issues persist

4. **start.command Issues (macOS)**
   - If you get a security warning, right-click the file and select "Open"
   - Make sure the file has execute permissions:
     ```bash
     chmod +x start.command
     ```

## License

MIT License - see LICENSE file for details

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - The core download engine
- [ffmpeg](https://ffmpeg.org/) - For video processing
- [Electron](https://www.electronjs.org/) - For the desktop application framework
