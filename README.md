# YT Downloader Electron

A simple, cross-platform GUI application for downloading YouTube videos and audio using [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/) on your desktop.  
Built with Electron, runs on macOS and Linux (should also work on Windows with minor tweaks).

---

## Features

- Download best quality video or audio from YouTube (and other supported sites)
- Choose audio/video format by code (e.g., 140, 356, 140+356, etc.)
- Download subtitles (all available languages)
- Select browser cookies (Brave, Chrome, Firefox)
- Customizable download folder
- Full support for advanced `yt-dlp` features (merge, format selection)
- No command-line needed!

---

## Prerequisites

**Before using this app, you must have:**

1. **[yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and in your PATH**

    - On macOS or Linux:
      ```sh
      brew install yt-dlp     # with Homebrew
      # OR
      pip install -U yt-dlp
      ```
      Or [download the latest release](https://github.com/yt-dlp/yt-dlp/releases).

2. **[ffmpeg](https://ffmpeg.org/download.html) installed and in your PATH**

    - On macOS:
      ```sh
      brew install ffmpeg
      ```
    - On Ubuntu/Debian:
      ```sh
      sudo apt install ffmpeg
      ```
    - On other Linux:
      Use your distro’s package manager, or [see instructions here](https://ffmpeg.org/download.html).

**Test in your terminal:**
```sh
yt-dlp --version
ffmpeg -version
```
Both commands must print a version number. If not, install or fix your PATH first!

---

## Usage

1. **Clone this repository:**
    ```sh
    git clone https://github.com/Shawshank01/yt-downloader-electron.git
    cd yt-downloader-electron
    ```

2. **Install dependencies:**
    ```sh
    npm install
    ```

3. **Run the app:**
    ```sh
    npm start
    ```

4. **Paste a YouTube URL, choose action, format, and download folder. Click "Run".**

---

## Notes

- This app relies on `yt-dlp` and `ffmpeg` being installed and accessible in your system PATH.
- Supports macOS and most Linux distributions.
- Windows support is possible but not tested.

---

## Security

- Uses Electron’s secure context bridge (no node integration in renderer).
- No user data is collected or transmitted.

---

**Reminder:**  
If downloads fail, double-check that both `yt-dlp` and `ffmpeg` are installed and available in your shell’s `$PATH`.