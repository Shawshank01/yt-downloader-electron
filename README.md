# Video Downloader (Electron)

A modern, user-friendly desktop application for downloading videos from YouTube and other supported platforms using yt-dlp and ffmpeg.

## Features

- 🎥 Download videos in various formats and qualities
- 📝 Download subtitles
- 🔄 Automatic updates for the app, yt-dlp, and ffmpeg
- 🍪 Browser cookie support (Brave, Chrome, Firefox)
- 📂 Custom download folder selection
- 📊 Real-time download progress
- 🎯 Format selection with detailed format list
- 🔄 MP4 merging support
- 🚀 Automatic dependency management

## Prerequisites

- macOS (tested on macOS 14+)
- [Homebrew](https://brew.sh/) (will be installed automatically if missing)

## Installation

### Method 1: Direct Download (Recommended for Users)

1. Download the latest release from the [Releases](https://github.com/Shawshank01/yt-downloader-electron/releases) page
2. Extract the downloaded zip file
3. Double-click `start.command` to run the application
   - If you get a security warning, right-click the file and select "Open"
   - The app will automatically check for and install required dependencies

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

The app will automatically check for and install required dependencies (yt-dlp and ffmpeg) if they're not already present.

## Usage

1. **Basic Video Download**
   - Enter the video URL
   - Select "Download Video (Best Quality)"
   - Choose your browser for cookies
   - Select a download folder
   - Click "Run"

2. **Format Selection**
   - Enter the video URL
   - Select "List Formats" to see available formats
   - Choose "Choose Format" and enter the format code
   - Select your browser and download folder
   - Click "Run"

3. **Subtitle Download**
   - Enter the video URL
   - Select "Download Subtitles"
   - Click "Run"

4. **MP4 Merge**
   - Enter the video URL
   - Select "Download & Merge as MP4"
   - Choose your browser and download folder
   - Click "Run"

## Updating

The app includes an automatic update system:

1. Click the "Check for Updates" button to:
   - Check for app updates
   - Check yt-dlp version
   - Check ffmpeg version
2. If updates are available, you'll be prompted to install them

## Development

### Building

To build the application:

```bash
npm run build
```

This will create a distributable package in the `dist` directory.

## Troubleshooting

1. **Missing Dependencies**
   - The app will automatically check for and install required dependencies
   - If manual installation is needed:
     ```bash
     brew install yt-dlp ffmpeg
     ```

2. **Update Issues**
   - If updates fail, try running:
     ```bash
     brew upgrade yt-dlp ffmpeg
     ```

3. **Browser Cookie Issues**
   - Make sure you're logged into YouTube in your selected browser
   - Try a different browser if issues persist

4. **start.command Issues**
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
