console.log("renderer.js loaded! window.electronAPI:", window.electronAPI);

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

window.runCommand = async function () {
    const url = document.getElementById('url').value.trim();
    const action = document.getElementById('action').value;
    const formatCode = document.getElementById('formatCode').value.trim();
    const browser = document.getElementById('browser').value.trim();
    const downloadFolder = document.getElementById('downloadFolder').value.trim();

    if (!url) {
        document.getElementById('output').textContent = "Error: You must enter a YouTube URL.";
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
    } catch (e) {
        document.getElementById('output').textContent += "\nError: " + e;
    }
};
