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

window.checkUpdate = async function() {
    const output = document.getElementById('output');
    output.textContent = "Checking for updates...\n";
    
    try {
        // Check app update
        const appUpdate = await window.electronAPI.checkAppUpdate();
        output.textContent += `\nApp: ${appUpdate}`;
        
        // Check yt-dlp version and update status
        const ytDlpVersion = await window.electronAPI.checkYtDlp();
        output.textContent += `\n${ytDlpVersion}`;
        const ytDlpUpdate = await window.electronAPI.checkYtDlpUpdate();
        output.textContent += `\n${ytDlpUpdate.message}`;
        
        // Check ffmpeg version and update status
        const ffmpegVersion = await window.electronAPI.checkFfmpeg();
        output.textContent += `\n${ffmpegVersion}`;
        const ffmpegUpdate = await window.electronAPI.checkFfmpegUpdate();
        output.textContent += `\n${ffmpegUpdate.message}`;
        
        // Only prompt for yt-dlp update if needed
        if (ytDlpUpdate.needsUpdate) {
            if (confirm('Would you like to update yt-dlp to the latest version?')) {
                output.textContent += "\n\nUpdating yt-dlp...";
                const updateResult = await window.electronAPI.updateYtDlp();
                output.textContent += `\n${updateResult}`;
            }
        }
        
        // Only prompt for ffmpeg update if needed
        if (ffmpegUpdate.needsUpdate) {
            if (confirm('Would you like to update ffmpeg to the latest version?')) {
                output.textContent += "\n\nUpdating ffmpeg...";
                const updateResult = await window.electronAPI.updateFfmpeg();
                output.textContent += `\n${updateResult}`;
            }
        }
        
        // If no updates are needed, show a message
        if (!ytDlpUpdate.needsUpdate && !ffmpegUpdate.needsUpdate) {
            output.textContent += "\n\nAll components are up to date!";
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
            cmd = `yt-dlp --write-subs --all-subs --skip-download "${url}"`;
            break;
        case 'Download & Merge as MP4':
            cmd = `yt-dlp --merge-output-format mp4 -P "${downloadFolder}" --cookies-from-browser ${browser} "${url}"`;
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
