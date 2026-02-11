console.log('renderer.js loaded! window.electronAPI:', window.electronAPI);

// Initialise progress handler
let progressHandler = null;

// Function to clean yt-dlp output by removing progress lines
function cleanYtDlpResult(result) {
    if (!result) return result;

    const lines = result.split(/[\r\n]+/);
    const cleanLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Skip progress lines
        if (trimmed.startsWith('[download]') && (trimmed.includes('%') || trimmed.includes('ETA'))) {
            continue;
        }

        // Skip some other noisy lines if needed, but mainly progress
        cleanLines.push(trimmed);
    }

    // Join with newlines
    return cleanLines.join('\n').trim();
}

window.chooseFolder = async function () {
    console.log('chooseFolder called! electronAPI:', window.electronAPI);
    if (!window.electronAPI) {
        alert('electronAPI is not defined!');
        return;
    }
    const folder = await window.electronAPI.chooseFolder();
    console.log('User chose folder:', folder);
    if (folder) {
        document.getElementById('downloadFolder').value = folder;
    }
};

window.checkUpdate = async function () {
    const output = document.getElementById('output');
    output.textContent = 'Checking for app updates...\n';

    try {
        // Get current version
        const currentVersion = await window.electronAPI.getCurrentVersion();
        output.textContent += `Current version: ${currentVersion}\n`;

        // Check if auto-updater is supported
        const isSupported = await window.electronAPI.isAutoUpdaterSupported();
        if (!isSupported) {
            output.textContent += '\nAuto-updater is not supported on this platform.\n';
            output.textContent += 'Please download updates manually from GitHub releases.\n';
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
            const stripHtml = (v) => (v || '').replace(/<[^>]*>/g, '').trim();
            const cleanedNotes = stripHtml(appUpdate.releaseNotes);

            // Show details inside the confirmation prompt first
            const promptMsg =
                `A new version is available.\n\n` +
                `New version: ${appUpdate.version}\n` +
                (cleanedNotes ? `Release notes:\n${cleanedNotes}\n\n` : '\n') +
                `Do you want to open the GitHub releases page to download the latest version?`;

            const openNow = confirm(promptMsg);

            // Then print to output (also using cleaned notes)
            output.textContent += `\n✅ Update available!\n`;
            output.textContent += `New version: ${appUpdate.version}\n`;
            if (cleanedNotes) {
                output.textContent += `Release notes: ${cleanedNotes}\n`;
            }

            if (openNow) {
                const releaseUrl =
                    'https://github.com/Shawshank01/yt-downloader-electron/releases/latest';

                if (window.electronAPI?.openExternal) {
                    try {
                        const opened = await window.electronAPI.openExternal(releaseUrl);
                        if (!opened) {
                            window.open(releaseUrl, '_blank');
                        }
                    } catch (error) {
                        window.open(releaseUrl, '_blank');
                    }
                } else {
                    window.open(releaseUrl, '_blank');
                }
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
        document.getElementById('output').textContent = 'Error: You must enter a video URL.';
        return;
    }
    if (!['', 'brave', 'chrome', 'firefox', 'safari'].includes(browser)) {
        document.getElementById('output').textContent = 'Error: Invalid browser selection.';
        return;
    }
    if (!downloadFolder && action !== 'List Formats' && action !== 'Download Subtitles') {
        document.getElementById('output').textContent = 'Error: Please select a download folder.';
        return;
    }

    // Clear previous progress handler
    if (progressHandler) {
        progressHandler();
    }

    // Build cookies parameter if browser is selected
    const cookiesParam = browser ? `--cookies-from-browser ${browser}` : '';

    let cmd;
    switch (action) {
        case 'Download Video (Best Quality)':
            cmd = `yt-dlp -P "${downloadFolder}" ${cookiesParam} "${url}"`.trim();
            break;
        case 'List Formats':
            cmd = `yt-dlp -F ${cookiesParam} "${url}"`.trim();
            break;
        case 'Choose Format':
            if (formatCode) {
                cmd =
                    `yt-dlp -f ${formatCode} -P "${downloadFolder}" ${cookiesParam} "${url}"`.trim();
            } else {
                document.getElementById('output').textContent =
                    'Error: Please enter a format code (e.g., 140, 356, or 140+356) for audio/video download.';
                return;
            }
            break;
        case 'Download Subtitles':
            cmd =
                `yt-dlp --write-subs --write-auto-subs --all-subs --skip-download -P "${downloadFolder}" ${cookiesParam} "${url}"`.trim();
            break;
        case 'Download & Re-encode as high quality MP4 (H.264/AAC)':
            cmd = `yt-dlp -P "${downloadFolder}" ${cookiesParam} "${url}"`.trim();
            break;
        case 'Download & Add Hardsub (Only Support on macOS)':
            // Handle hardsub workflow separately
            await handleHardsubAction(url, browser, downloadFolder);
            return;
        default:
            cmd = `yt-dlp -P "${downloadFolder}" ${cookiesParam} "${url}"`.trim();
            break;
    }

    // Store the command line for progress updates
    const commandLine = 'Running: ' + cmd;

    // Set up new progress handler
    progressHandler = window.electronAPI.onProgress((progress) => {
        const outputElement = document.getElementById('output');
        // Only show command line + latest progress
        outputElement.textContent = commandLine + '\n' + progress;
    });

    document.getElementById('output').textContent = 'Running: ' + cmd + '\n';
    console.log('Running command:', cmd);

    try {
        const result = await window.electronAPI.runCommand(cmd);
        // Clean the result by removing progress lines and keeping only the final message
        const cleanResult = cleanYtDlpResult(result);

        // For Download Subtitles action, check if no subtitles were found
        if (action === 'Download Subtitles' && result.includes('There are no subtitles for the requested languages')) {
            document.getElementById('output').textContent = 'No subtitles available for this video.';
            return;
        }

        document.getElementById('output').textContent = commandLine + '\n' + cleanResult;

        // If this was a "Download & Re-encode as high quality MP4 (H.264/AAC)" action, ask for confirmation before re-encoding
        if (action === 'Download & Re-encode as high quality MP4 (H.264/AAC)' && downloadFolder) {
            const shouldReEncode = confirm(
                'Video download completed! Would you like to re-encode it to high quality MP4 (H.264/AAC)?\n\nThis will:\n• Use H.264 video codec with maximum quality (CRF 18)\n• Use AAC audio codec for maximum compatibility\n• Replace the original file with the re-encoded version\n\nNote: Re-encoding may take some time depending on the video length.\n\nIf you skip re-encoding, the original video format will be preserved.'
            );

            if (shouldReEncode) {
                document.getElementById('output').textContent +=
                    '\n\nRe-encoding videos to H.264/AAC...\n';

                try {
                    // Extract video ID from URL
                    const urlObj = new URL(url);
                    let videoId = '';

                    // Handle different YouTube URL formats
                    if (
                        urlObj.hostname.includes('youtube.com') ||
                        urlObj.hostname.includes('youtu.be')
                    ) {
                        if (urlObj.pathname.includes('/shorts/')) {
                            videoId = urlObj.pathname.split('/shorts/')[1];
                        } else if (urlObj.pathname.includes('/watch')) {
                            videoId = urlObj.searchParams.get('v');
                        } else if (urlObj.hostname.includes('youtu.be')) {
                            videoId = urlObj.pathname.substring(1);
                        }
                    }

                    if (videoId) {
                        try {
                            // Show cancel button
                            const reEncodeControls = document.getElementById('reEncodeControls');
                            if (reEncodeControls) reEncodeControls.style.display = 'block';

                            // Reset button state
                            const cancelBtn = document.getElementById('cancelReEncodeBtn');
                            if (cancelBtn) {
                                cancelBtn.disabled = false;
                                cancelBtn.textContent = "Cancel Re-encoding";
                            }

                            const reEncodeResult = await window.electronAPI.reEncodeToMp4(
                                downloadFolder,
                                videoId
                            );

                            document.getElementById('output').textContent =
                                commandLine + '\n' + cleanResult + '\n' + reEncodeResult;
                        } finally {
                            // Hide cancel button
                            const reEncodeControls = document.getElementById('reEncodeControls');
                            if (reEncodeControls) reEncodeControls.style.display = 'none';
                        }
                    } else {
                        document.getElementById('output').textContent +=
                            'Could not extract video ID from URL.';
                    }
                } catch (reEncodeError) {
                    document.getElementById('output').textContent +=
                        `\nRe-encoding error: ${reEncodeError}`;
                }
            } else {
                document.getElementById('output').textContent +=
                    '\n\nRe-encoding skipped. Original video file preserved.';
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
        document.getElementById('output').textContent += '\nError: ' + e;
    }
};

// Show/hide Format Code field depending on action
function updateFormatCodeVisibility() {
    const action = document.getElementById('action').value;
    const formatGroup = document.getElementById('formatCodeGroup');
    const codecGroup = document.getElementById('codecGroup');

    if (formatGroup) {
        formatGroup.style.display = action === 'Choose Format' ? '' : 'none';
    }
    if (codecGroup) {
        codecGroup.style.display = action === 'Download & Add Hardsub (Only Support on macOS)' ? '' : 'none';
    }
}

// Handle hardsub action workflow
async function handleHardsubAction(url, browser, downloadFolder) {
    const output = document.getElementById('output');
    const codec = document.getElementById('codec').value;

    if (!downloadFolder) {
        output.textContent = 'Error: Please select a download folder.';
        return;
    }

    // Clear previous progress handler
    if (progressHandler) {
        progressHandler();
    }

    // Set up progress handler
    progressHandler = window.electronAPI.onProgress((progress) => {
        output.textContent = progress;
    });

    output.textContent = 'Fetching available subtitles...';

    try {
        // Step 1: List available subtitles
        const result = await window.electronAPI.listSubtitles(url, browser);

        if (result.error) {
            output.textContent = `Error listing subtitles: ${result.message}`;
            return;
        }

        if (!result.subtitles || result.subtitles.length === 0) {
            output.textContent = 'No subtitles available for this video.';
            return;
        }

        // Step 2: Show subtitle selection modal
        const selectedSubtitle = await showSubtitleModal(result.subtitles, result.isAutoGenerated);

        if (!selectedSubtitle) {
            output.textContent = 'Subtitle selection cancelled.';
            return;
        }

        output.textContent = `Selected subtitle: ${selectedSubtitle.name} (${selectedSubtitle.code})\nStarting download...`;

        // Show hardsub controls
        const hardsubControls = document.getElementById('hardsubControls');
        const cancelBtn = document.getElementById('cancelHardsubBtn');
        if (hardsubControls) hardsubControls.style.display = 'block';
        if (cancelBtn) {
            cancelBtn.disabled = false;
            cancelBtn.textContent = "Cancel Hardsub";
        }

        try {
            // Step 3: Download and hardsub
            const hardsubResult = await window.electronAPI.downloadWithHardsub({
                url,
                browser,
                downloadFolder,
                subtitleLang: selectedSubtitle.code,
                subtitleType: selectedSubtitle.type,
                codec
            });

            output.textContent = hardsubResult;

            // Add completion hint
            if (hardsubResult.includes('completed') || hardsubResult.includes('Saved as')) {
                const completionHint = document.createElement('div');
                completionHint.style.marginTop = '10px';
                completionHint.style.padding = '10px';
                completionHint.style.backgroundColor = '#e8f5e9';
                completionHint.style.borderRadius = '4px';
                completionHint.style.color = '#2e7d32';
                completionHint.innerHTML = '✅ Hardsub completed!';
                output.appendChild(completionHint);
            }
        } finally {
            // Hide hardsub controls
            if (hardsubControls) hardsubControls.style.display = 'none';
        }
    } catch (error) {
        output.textContent = `Error: ${error.message}`;
    }
}

// Show subtitle selection modal and return selected subtitle
function showSubtitleModal(subtitles, isAutoGenerated = false) {
    return new Promise((resolve) => {
        const modal = document.getElementById('subtitleModal');
        const subtitleList = document.getElementById('subtitleList');
        const cancelBtn = document.getElementById('cancelSubtitleBtn');

        // Clear previous list
        subtitleList.innerHTML = '';

        // Add warning banner if auto-translated
        if (isAutoGenerated) {
            const warning = document.createElement('div');
            warning.style.padding = '10px';
            warning.style.marginBottom = '10px';
            warning.style.backgroundColor = '#fff3cd';
            warning.style.border = '1px solid #ffc107';
            warning.style.borderRadius = '4px';
            warning.style.color = '#856404';
            warning.innerHTML = 'ℹ️ <strong>Auto-Generated Subtitles</strong><br>No manually uploaded subtitles found. Showing auto-generated captions.';
            subtitleList.appendChild(warning);
        }

        // Populate subtitle list
        subtitles.forEach((sub) => {
            const item = document.createElement('div');
            item.className = 'subtitle-item';
            item.textContent = `${sub.name} (${sub.code})`;
            item.addEventListener('click', () => {
                modal.style.display = 'none';
                resolve(sub);
            });
            subtitleList.appendChild(item);
        });

        // Handle cancel
        const handleCancel = () => {
            modal.style.display = 'none';
            resolve(null);
        };

        cancelBtn.onclick = handleCancel;

        // Show modal
        modal.style.display = 'flex';
    });
}

// Initialise and bind change handler
document.addEventListener('DOMContentLoaded', () => {
    const actionSelect = document.getElementById('action');
    if (actionSelect) {
        actionSelect.addEventListener('change', updateFormatCodeVisibility);
        updateFormatCodeVisibility();
    }

    // Re-encode cancel button
    const cancelReEncodeBtn = document.getElementById('cancelReEncodeBtn');
    if (cancelReEncodeBtn) {
        cancelReEncodeBtn.addEventListener('click', async () => {
            cancelReEncodeBtn.disabled = true;
            cancelReEncodeBtn.textContent = "Cancelling...";
            await window.electronAPI.cancelReEncode();
        });
    }

    // Hardsub cancel button
    const cancelHardsubBtn = document.getElementById('cancelHardsubBtn');
    if (cancelHardsubBtn) {
        cancelHardsubBtn.addEventListener('click', async () => {
            cancelHardsubBtn.disabled = true;
            cancelHardsubBtn.textContent = "Cancelling...";
            await window.electronAPI.cancelHardsub();
        });
    }
});
