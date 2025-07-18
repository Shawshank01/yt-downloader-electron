console.log("renderer.js loaded! window.electronAPI:", window.electronAPI);

// Initialize progress handler
let progressHandler = null;

window.chooseFolder = async function () {
    console.log("chooseFolder called! electronAPI:", window.electronAPI);
    if (!window.electronAPI) {
        alert("electronAPI is not defined!");
        return;
    }
    const folder = await window.electronAPI.chooseFolder();
    console.log("User chose folder:", folder);
    if (folder) {
        document.getElementById('downloadFolder').value = folder;
    }
};

window.checkUpdate = async function () {
    const output = document.getElementById('output');
    output.textContent = "Checking for app updates...\n";

    try {
        // Get current version
        const currentVersion = await window.electronAPI.getCurrentVersion();
        output.textContent += `Current version: ${currentVersion}\n`;

        // Check if auto-updater is supported
        const isSupported = await window.electronAPI.isAutoUpdaterSupported();
        if (!isSupported) {
            output.textContent += "\nAuto-updater is not supported on this platform.\n";
            output.textContent += "Please download updates manually from GitHub releases.\n";
            return;
        }

        // Check app update
        const appUpdate = await window.electronAPI.checkAppUpdate();

        if (appUpdate.error) {
            output.textContent += `\nError checking for updates: ${appUpdate.message}`;
        } else if (
            appUpdate.hasUpdate &&
            appUpdate.version &&
            appUpdate.version !== currentVersion
        ) {
            output.textContent += `\n✅ Update available!\n`;
            output.textContent += `New version: ${appUpdate.version}\n`;
            output.textContent += `Release notes: ${appUpdate.releaseNotes}\n`;

            if (confirm('A new version is available. Do you want to open the GitHub releases page to download the latest version?')) {
                window.open('https://github.com/Shawshank01/yt-downloader-electron/releases/latest', '_blank');
            }
        } else {
            output.textContent += `\n✅ App is up to date!`;
        }
    } catch (error) {
        output.textContent += `\nError: ${error.message}`;
    }
};

window.runCommand = async function () {
    const url = document.getElementById('url').value.trim();
    const action = document.getElementById('action').value;
    const formatCode = document.getElementById('formatCode').value.trim();
    const browser = document.getElementById('browser').value.trim();
    const downloadFolder = document.getElementById('downloadFolder').value.trim();

    if (!url) {
        document.getElementById('output').textContent = "Error: You must enter a video URL.";
        return;
    }
    if (!["brave", "chrome", "firefox"].includes(browser)) {
        document.getElementById('output').textContent = "Error: Invalid browser selection.";
        return;
    }
    if (!downloadFolder && action !== 'List Formats' && action !== 'Download Subtitles') {
        document.getElementById('output').textContent = "Error: Please select a download folder.";
        return;
    }

    // Clear previous progress handler
    if (progressHandler) {
        progressHandler();
    }

    // Set up new progress handler
    progressHandler = window.electronAPI.onProgress((progress) => {
        const outputElement = document.getElementById('output');
        const currentText = outputElement.textContent;
        // Keep the command line but update the progress
        const commandLine = currentText.split('\n')[0];
        outputElement.textContent = commandLine + '\n' + progress;
    });

    let cmd;
    switch (action) {
        case 'Download Video (Best Quality)':
            cmd = `yt-dlp -P "${downloadFolder}" --cookies-from-browser ${browser} "${url}"`;
            break;
        case 'List Formats':
            cmd = `yt-dlp -F --cookies-from-browser ${browser} "${url}"`;
            break;
        case 'Choose Format':
            if (formatCode) {
                cmd = `yt-dlp -f ${formatCode} -P "${downloadFolder}" --cookies-from-browser ${browser} "${url}"`;
            } else {
                document.getElementById('output').textContent = "Error: Please enter a format code (e.g., 140, 356, or 140+356) for audio/video download.";
                return;
            }
            break;
        case 'Download Subtitles':
            cmd = `yt-dlp --write-subs --all-subs --skip-download -P "${downloadFolder}" "${url}"`;
            break;
        case 'Download & Re-encode as high quality MP4 (H.264/AAC)':
            cmd = `yt-dlp -P "${downloadFolder}" --cookies-from-browser ${browser} "${url}"`;
            break;
        default:
            cmd = `yt-dlp -P "${downloadFolder}" --cookies-from-browser ${browser} "${url}"`;
            break;
    }

    document.getElementById('output').textContent = "Running: " + cmd + "\n";
    console.log("Running command:", cmd);

    try {
        const result = await window.electronAPI.runCommand(cmd);
        document.getElementById('output').textContent += result;

        // If this was a "Download & Re-encode as high quality MP4 (H.264/AAC)" action, ask for confirmation before re-encoding
        if (action === 'Download & Re-encode as high quality MP4 (H.264/AAC)' && downloadFolder) {
            const shouldReEncode = confirm('Video download completed! Would you like to re-encode it to high quality MP4 (H.264/AAC)?\n\nThis will:\n• Use H.264 video codec with maximum quality (CRF 18)\n• Use AAC audio codec for maximum compatibility\n• Replace the original file with the re-encoded version\n\nNote: Re-encoding may take some time depending on the video length.\n\nIf you skip re-encoding, the original video format will be preserved.');

            if (shouldReEncode) {
                document.getElementById('output').textContent += "\n\nRe-encoding videos to H.264/AAC...\n";

                try {
                    // Extract video ID from URL
                    const urlObj = new URL(url);
                    let videoId = '';

                    // Handle different YouTube URL formats
                    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname.includes('youtu.be')) {
                        if (urlObj.pathname.includes('/shorts/')) {
                            videoId = urlObj.pathname.split('/shorts/')[1];
                        } else if (urlObj.pathname.includes('/watch')) {
                            videoId = urlObj.searchParams.get('v');
                        } else if (urlObj.hostname.includes('youtu.be')) {
                            videoId = urlObj.pathname.substring(1);
                        }
                    }

                    if (videoId) {
                        const reEncodeResult = await window.electronAPI.reEncodeToMp4(downloadFolder, videoId);
                        document.getElementById('output').textContent += reEncodeResult;
                    } else {
                        document.getElementById('output').textContent += "Could not extract video ID from URL.";
                    }
                } catch (reEncodeError) {
                    document.getElementById('output').textContent += `\nRe-encoding error: ${reEncodeError}`;
                }
            } else {
                document.getElementById('output').textContent += "\n\nRe-encoding skipped. Original video file preserved.";
            }
        }

        // Add completion hint if it's a download action
        if (action !== 'List Formats') {
            const completionHint = document.createElement('div');
            completionHint.style.marginTop = '10px';
            completionHint.style.padding = '10px';
            completionHint.style.backgroundColor = '#e8f5e9';
            completionHint.style.borderRadius = '4px';
            completionHint.style.color = '#2e7d32';
            completionHint.innerHTML = '✅ Download completed!';
            document.getElementById('output').appendChild(completionHint);
        }
    } catch (e) {
        document.getElementById('output').textContent += "\nError: " + e;
    }
};
