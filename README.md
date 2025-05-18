# Video Downloader (Electron)

A simple, cross-platform GUI application for downloading video and audio using [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [ffmpeg](https://ffmpeg.org/) on your desktop.  
Built with Electron, runs on macOS and Linux (should also work on Windows with minor tweaks).

---

## Features

- Download video in best quality
- List available video formats
- Download specific formats using format codes (e.g., 140, 356, 140+356, etc.)
- Download subtitles (all available languages)
- Download and merge as MP4
- Real-time download progress
- Support for multiple browsers (Chrome, Firefox, Brave) for cookies
- Easy-to-use interface

## Prerequisites

- Node.js and npm installed
- yt-dlp installed (the app will try to find it in common locations)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Shawshank01/yt-downloader-electron.git
cd yt-downloader-electron
```

2. Install dependencies:
```bash
npm install
```

## Running the Application

### Method 1: Using Terminal
```bash
npm start
```

### Method 2: Double-click (macOS)
Simply double-click the `start.command` file in the application directory.

## Usage

1. Enter a video URL in the input field
2. Select your preferred browser for cookies (If the site requires a login or membership)
3. Choose a download folder
4. Select an action:
   - Download Video (Best Quality)
   - List Formats
   - Choose Format
   - Download Subtitles
   - Download & Merge as MP4

### Format Codes
When using "Choose Format" option, you can enter format codes like:
- `140` for audio only
- `356` for video+audio
- `140+356` for your choice of video+audio format

## Development

The application is built with:
- Electron
- Node.js
- yt-dlp
- FFmpeg (Recommend)

## Contributing

Feel free to open issues or submit pull requests.
