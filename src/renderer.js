console.log('renderer.js loaded! window.electronAPI:', window.electronAPI);

let progressHandler = null;

// Cache the format list output from "List Formats" to detect audio-only formats
let cachedFormatList = '';

// Fetch format metadata for a single format code using yt-dlp --print
// Falls back to the cached format list if available to avoid an extra network call
async function fetchFormatMeta(formatCode, browser, url) {
    // Try cache first
    if (cachedFormatList) {
        const lines = cachedFormatList.split(/[\r\n]+/);
        for (const line of lines) {
            const trimmed = line.trim();
            const m = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)/);
            if (m && m[1] === formatCode) {
                // Parse from cached -F table: ext is column 2, rest is the line
                const ext = m[2];
                const audioMatch = trimmed.match(/\|\s*audio only\s+(\S+)/i);
                const acodec = audioMatch ? audioMatch[1] : 'none';
                const vcodec = trimmed.includes('audio only') ? 'none' : 'video';
                return { ext, acodec, vcodec };
            }
        }
    }

    // Cache miss — use yt-dlp --print for a fast single-format lookup
    const args = [...getProxyArgs(), '-f', formatCode, '--print', '%(ext)s %(acodec)s %(vcodec)s', '--no-download'];
    if (browser) args.push('--cookies-from-browser', browser);
    args.push(url);

    const result = await window.electronAPI.getFormatInfo(args);
    if (!result.ok || !result.output) return null;

    const [ext, acodec, vcodec] = result.output.split(' ');
    return { ext, acodec: acodec || 'none', vcodec: vcodec || 'none' };
}

// Detect audio-only webm formats and return the correct extraction format
async function getAudioOnlyWebmFormat(formatCode, browser, url) {
    if (!formatCode || formatCode.includes('+')) return null;
    const meta = await fetchFormatMeta(formatCode, browser, url);
    if (!meta) return null;
    if (meta.ext !== 'webm') return null;
    if (meta.acodec.startsWith('opus')) return 'opus';
    if (meta.acodec.startsWith('vorbis')) return 'vorbis';
    return null;
}

// Detect image/storyboard formats (mhtml) that don't support thumbnail embedding
async function isImageFormat(formatCode, browser, url) {
    if (!formatCode || formatCode.includes('+')) return false;
    const meta = await fetchFormatMeta(formatCode, browser, url);
    return meta?.ext === 'mhtml';
}

// Function to clean yt-dlp output by removing progress lines
function cleanYtDlpResult(result) {
    if (!result) return result;

    const lines = result.split(/[\r\n]+/);
    const cleanLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('[download]') && (trimmed.includes('%') || trimmed.includes('ETA'))) {
            continue;
        }

        cleanLines.push(trimmed);
    }

    return cleanLines.join('\n').trim();
}

// Build proxy args for yt-dlp if proxy is enabled
function getProxyArgs() {
    const proxyEnabled = document.getElementById('proxyEnabled');
    const proxyAddress = document.getElementById('proxyAddress');
    if (proxyEnabled && proxyEnabled.checked && proxyAddress) {
        const addr = proxyAddress.value.trim();
        if (addr) {
            return ['--proxy', `socks5://${addr}/`];
        }
    }
    return [];
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
        // Persist the chosen folder immediately
        window.electronAPI.setSettings({ downloadFolder: folder }).catch(console.error);
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
                    } catch {
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

window.checkDependencies = async function () {
    const output = document.getElementById('output');
    output.textContent = 'Checking dependencies...\n';

    try {
        const result = await window.electronAPI.checkDependencies();
        if (!result.success) {
            output.textContent += `\nError checking dependencies: ${result.message || 'Unknown error'}`;
            return;
        }

        const formatReport = (report) => {
            const lines = [];
            lines.push(
                report.allInstalled
                    ? '✅ All required dependencies are installed.'
                    : '⚠️ Some dependencies are missing.'
            );
            lines.push('');

            for (const dep of report.dependencies) {
                if (dep.installed) {
                    lines.push(`- ${dep.name}: installed`);
                    lines.push(`  path: ${dep.path}`);
                    lines.push(`  version: ${dep.version}`);
                } else {
                    lines.push(`- ${dep.name}: missing`);
                }
                lines.push('');
            }

            if (!report.allInstalled) {
                lines.push(`Missing: ${report.missing.join(', ')}`);
            }

            return lines.join('\n').trim();
        };

        if (result.allInstalled) {
            output.textContent = formatReport(result);
            return;
        }

        const isMac = result.platform === 'darwin';

        if (isMac) {
            output.textContent = formatReport(result);

            const installableMissing = result.missing.filter((d) => d !== 'brew');
            const missingBrew = result.missing.includes('brew');
            const installList = missingBrew ? result.missing : installableMissing;

            const shouldInstall = confirm(
                `Missing dependencies:\n${result.missing.join(', ')}\n\n` +
                `Would you like to install missing ones now?\n` +
                (missingBrew
                    ? `This will run Homebrew installer:\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\nThen run:\nbrew install ${installList.filter((d) => d !== 'brew').join(' ')}`
                    : `This will run: brew install ${installList.join(' ')}`) +
                `\n\nYou can cancel and install later.`
            );

            if (!shouldInstall) {
                output.textContent +=
                    '\n\nInstall manually later with:\nbrew install yt-dlp ffmpeg';
                return;
            }

            output.textContent = missingBrew
                ? 'Installing Homebrew and missing dependencies...\n'
                : 'Installing missing dependencies with Homebrew...\n';
            const installResult = await window.electronAPI.installMissingDependencies({
                installHomebrew: missingBrew
            });

            if (!installResult.success) {
                output.textContent = `Installation finished with issues: ${installResult.message || 'Unknown error'
                    }\n`;
                if (!installResult.dependencies) {
                    return;
                }
            }

            const recomputedMissing = (installResult.dependencies || [])
                .filter((d) => !d.installed)
                .map((d) => d.name);

            const depsResult = {
                success: true,
                allInstalled: recomputedMissing.length === 0,
                dependencies: installResult.dependencies,
                missing: recomputedMissing
            };

            output.textContent = formatReport(depsResult);
            if (installResult.failed?.length) {
                output.textContent += `\nFailed: ${installResult.failed.join(', ')}`;
            }
            return;
        }

        // Linux/Windows: check-only
        const lines = [];
        lines.push(formatReport(result));
        lines.push('');
        lines.push(
            'Please install the missing dependencies manually before using the downloader.'
        );
        if (result.missing.includes('yt-dlp') || result.missing.includes('ffmpeg')) {
            lines.push('Hints: Install yt-dlp and ffmpeg using your system package manager.');
        }
        if (result.missing.includes('brew')) {
            lines.push('Note: Homebrew is not available on this platform; use your OS package manager.');
        }

        output.textContent = lines.join('\n').trim();
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

    let args = [...getProxyArgs()];
    if (browser) {
        args.push('--cookies-from-browser', browser);
    }

    switch (action) {
        case 'Download Video (Best Quality)':
            args.push('--embed-thumbnail', '-P', downloadFolder, url);
            break;
        case 'List Formats':
            args.push('-F', url);
            break;
        case 'Download (Custom Format)':
            if (formatCode) {
                args.push('-f', formatCode);
                if (!cachedFormatList) {
                    document.getElementById('output').textContent =
                        'Detecting format metadata... (run "List Formats" first to skip this step)';
                }
                if (!await isImageFormat(formatCode, browser, url)) {
                    const audioFmt = await getAudioOnlyWebmFormat(formatCode, browser, url);
                    if (audioFmt) {
                        // Extract audio so --embed-thumbnail works
                        args.push('-x', '--audio-format', audioFmt);
                    }
                    args.push('--embed-thumbnail');
                }
                args.push('-P', downloadFolder, url);
            } else {
                document.getElementById('output').textContent =
                    'Error: Please enter a format code (e.g., 140, 356, or 140+356) for audio/video download.';
                return;
            }
            break;
        case 'Download Subtitles':
            // Handle subtitle download workflow separately
            await handleSubtitleDownload(url, browser, downloadFolder);
            return;
        case 'Download Thumbnail':
            // Download only the video thumbnail in its original format, no video/audio
            args.push('--write-thumbnail', '--skip-download', '-P', downloadFolder, url);
            break;
        case 'Download & Re-encode as high quality MP4 (H.264/AAC)':
            args.push('--write-thumbnail', '--convert-thumbnails', 'jpg', '-P', downloadFolder, url);
            break;
        case 'Download & Add Hardsub (Only Support on macOS)':
            // Handle hardsub workflow separately
            await handleHardsubAction(url, browser, downloadFolder);
            return;
        default:
            args.push('--embed-thumbnail', '-P', downloadFolder, url);
            break;
    }

    // Store the command line for progress updates
    const commandLine = 'Running: yt-dlp ' + args.join(' ');

    // Set up new progress handler
    progressHandler = window.electronAPI.onProgress((progress) => {
        const outputElement = document.getElementById('output');
        // Only show command line + latest progress
        outputElement.textContent = commandLine + '\n' + progress;
    });

    document.getElementById('output').textContent = commandLine + '\n';
    console.log('Running command:', args);

    // Show generic cancel button
    const cancelActionControls = document.getElementById('cancelActionControls');
    const cancelActionBtn = document.getElementById('cancelActionBtn');

    if (cancelActionControls) cancelActionControls.style.display = 'block';
    if (cancelActionBtn) {
        cancelActionBtn.disabled = false;
        cancelActionBtn.textContent = 'Cancel Action';

        // Remove old listeners to prevent duplicates
        const newCancelBtn = cancelActionBtn.cloneNode(true);
        cancelActionBtn.parentNode.replaceChild(newCancelBtn, cancelActionBtn);

        newCancelBtn.addEventListener('click', async () => {
            newCancelBtn.disabled = true;
            newCancelBtn.textContent = 'Cancelling...';
            await window.electronAPI.cancelCommand();
        });
    }

    try {
        const result = await window.electronAPI.runCommand(args);

        // Cache the format list output for audio-only detection
        if (action === 'List Formats') {
            cachedFormatList = result || '';
        }

        // Clean the result by removing progress lines and keeping only the final message
        const cleanResult = cleanYtDlpResult(result);

        document.getElementById('output').textContent = commandLine + '\n' + cleanResult;

        // Ask for confirmation before re-encoding
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
                            const cancelActionControls = document.getElementById('cancelActionControls');
                            const cancelActionBtn = document.getElementById('cancelActionBtn');
                            if (cancelActionControls) cancelActionControls.style.display = 'block';
                            if (cancelActionBtn) {
                                cancelActionBtn.disabled = false;
                                cancelActionBtn.textContent = 'Cancel Action';
                            }

                            const reEncodeResult = await window.electronAPI.reEncodeToMp4(
                                downloadFolder,
                                videoId
                            );

                            let parsedResult;
                            try {
                                parsedResult = JSON.parse(reEncodeResult);
                            } catch {
                                parsedResult = { text: reEncodeResult, tmpFiles: [] };
                            }

                            document.getElementById('output').textContent =
                                commandLine + '\n' + cleanResult + '\n' + parsedResult.text;

                            if (parsedResult.tmpFiles && parsedResult.tmpFiles.length > 0) {
                                const shouldDelete = await showCleanupModal('Re-encoding completed successfully. Do you want to delete the temporary downloaded files (original video and thumbnail)?');
                                if (shouldDelete) {
                                    await window.electronAPI.deleteTemporaryFiles(parsedResult.tmpFiles);
                                }
                            }
                        } finally {
                            // Hide cancel button
                            const cancelActionControls = document.getElementById('cancelActionControls');
                            if (cancelActionControls) cancelActionControls.style.display = 'none';
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

        // Hide generic cancel button
        if (cancelActionControls) cancelActionControls.style.display = 'none';

        // Add completion hint if it's a download action
        if (action !== 'List Formats') {
            const isCancelled = document.getElementById('output').textContent.includes('cancelled by user');
            const completionHint = document.createElement('div');
            completionHint.style.marginTop = '10px';
            completionHint.style.padding = '10px';
            completionHint.style.borderRadius = '4px';

            if (isCancelled) {
                completionHint.style.backgroundColor = '#ffebee';
                completionHint.style.color = '#c62828';
                completionHint.innerHTML = '❌ Download canceled!';
            } else {
                completionHint.style.backgroundColor = '#e8f5e9';
                completionHint.style.color = '#2e7d32';
                completionHint.innerHTML = '✅ Download completed!';
            }
            document.getElementById('output').appendChild(completionHint);
        }
    } catch (e) {
        document.getElementById('output').textContent += '\nError: ' + e;
        if (cancelActionControls) cancelActionControls.style.display = 'none';
    }
};

// Show/hide Format Code field depending on action
function updateFormatCodeVisibility() {
    const action = document.getElementById('action').value;
    const formatGroup = document.getElementById('formatCodeGroup');
    const codecGroup = document.getElementById('codecGroup');

    if (formatGroup) {
        formatGroup.style.display = action === 'Download (Custom Format)' ? '' : 'none';
    }
    if (codecGroup) {
        codecGroup.style.display = action === 'Download & Add Hardsub (Only Support on macOS)' ? '' : 'none';
    }
}

// Handle subtitle download workflow
async function handleSubtitleDownload(url, browser, downloadFolder) {
    const output = document.getElementById('output');

    if (!downloadFolder) {
        output.textContent = 'Error: Please select a download folder.';
        return;
    }

    output.textContent = 'Fetching available subtitles...';

    try {
        const proxyUrl = getProxyArgs().length ? `socks5://${document.getElementById('proxyAddress').value.trim()}/` : '';
        const result = await window.electronAPI.listSubtitles(url, browser, proxyUrl);

        if (result.error) {
            output.textContent = `Error listing subtitles: ${result.message}`;
            return;
        }

        if (!result.subtitles || result.subtitles.length === 0) {
            output.textContent = 'No subtitles available for this video.';
            return;
        }

        const selectedSubtitle = await showSubtitleModal(result.subtitles, result.isAutoGenerated);

        if (!selectedSubtitle) {
            output.textContent = 'Subtitle download cancelled.';
            return;
        }

        output.textContent = `Downloading ${selectedSubtitle.name} (${selectedSubtitle.code}) subtitle...`;

        let args = [...getProxyArgs()];
        if (browser) {
            args.push('--cookies-from-browser', browser);
        }
        const subsFlag = selectedSubtitle.type === 'manual' ? '--write-subs' : '--write-auto-subs';
        args.push(subsFlag, '--sub-langs', selectedSubtitle.code, '--skip-download', '--convert-subs', 'vtt', '-P', downloadFolder, url);

        const cmdResult = await window.electronAPI.runCommand(args);

        if (cmdResult.includes('cancelled by user')) {
            output.textContent = 'Subtitle download cancelled.';
            const completionHint = document.createElement('div');
            completionHint.style.marginTop = '10px';
            completionHint.style.padding = '10px';
            completionHint.style.backgroundColor = '#ffebee';
            completionHint.style.borderRadius = '4px';
            completionHint.style.color = '#c62828';
            completionHint.innerHTML = '❌ Download canceled!';
            output.appendChild(completionHint);
        } else if (cmdResult.includes('There are no subtitles for the requested languages')) {
            output.textContent = 'No subtitles available for this video.';
        } else {
            output.textContent = `✅ Subtitle downloaded: ${selectedSubtitle.name} (${selectedSubtitle.code})`;
        }
    } catch (error) {
        output.textContent = `Error: ${error.message}`;
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
        const proxyUrl = getProxyArgs().length ? `socks5://${document.getElementById('proxyAddress').value.trim()}/` : '';
        const result = await window.electronAPI.listSubtitles(url, browser, proxyUrl);

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
        const cancelActionControls = document.getElementById('cancelActionControls');
        const cancelActionBtn = document.getElementById('cancelActionBtn');
        if (cancelActionControls) cancelActionControls.style.display = 'block';
        if (cancelActionBtn) {
            cancelActionBtn.disabled = false;
            cancelActionBtn.textContent = 'Cancel Action';

            // Make sure listener is attached
            const newCancelBtn = cancelActionBtn.cloneNode(true);
            cancelActionBtn.parentNode.replaceChild(newCancelBtn, cancelActionBtn);

            newCancelBtn.addEventListener('click', async () => {
                newCancelBtn.disabled = true;
                newCancelBtn.textContent = 'Cancelling...';
                await window.electronAPI.cancelCommand();
            });
        }

        try {
            // Step 3: Download and hardsub
            const hardsubResult = await window.electronAPI.downloadWithHardsub({
                url,
                browser,
                downloadFolder,
                subtitleLang: selectedSubtitle.code,
                subtitleType: selectedSubtitle.type,
                codec,
                proxy: proxyUrl
            });

            let parsedResult;
            try {
                parsedResult = JSON.parse(hardsubResult);
            } catch {
                parsedResult = { text: hardsubResult, tmpFiles: [] };
            }

            output.textContent = parsedResult.text;

            if (parsedResult.tmpFiles && parsedResult.tmpFiles.length > 0) {
                const shouldDelete = await showCleanupModal('Hardsub completed successfully. Do you want to delete the temporary downloaded files (original video, thumbnail, and subtitles)?');
                if (shouldDelete) {
                    await window.electronAPI.deleteTemporaryFiles(parsedResult.tmpFiles);
                }
            }

            // Add completion hint
            if (parsedResult.text.includes('cancelled by user')) {
                const completionHint = document.createElement('div');
                completionHint.style.marginTop = '10px';
                completionHint.style.padding = '10px';
                completionHint.style.backgroundColor = '#ffebee';
                completionHint.style.borderRadius = '4px';
                completionHint.style.color = '#c62828';
                completionHint.innerHTML = '❌ Hardsub canceled!';
                output.appendChild(completionHint);
            } else if (hardsubResult.includes('completed') || hardsubResult.includes('Saved as')) {
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
            const cancelActionControls = document.getElementById('cancelActionControls');
            if (cancelActionControls) cancelActionControls.style.display = 'none';
        }
    } catch (error) {
        if (error.message.includes('cancelled by user')) {
            output.textContent = 'Action cancelled by user.';
            const completionHint = document.createElement('div');
            completionHint.style.marginTop = '10px';
            completionHint.style.padding = '10px';
            completionHint.style.backgroundColor = '#ffebee';
            completionHint.style.borderRadius = '4px';
            completionHint.style.color = '#c62828';
            completionHint.innerHTML = '❌ Hardsub canceled!';
            output.appendChild(completionHint);
        } else {
            output.textContent = `Error: ${error.message}`;
        }
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
document.addEventListener('DOMContentLoaded', async () => {
    const actionSelect = document.getElementById('action');
    if (actionSelect) {
        actionSelect.addEventListener('change', updateFormatCodeVisibility);
        updateFormatCodeVisibility();
    }

    // Restore persisted user settings
    if (window.electronAPI?.getSettings) {
        try {
            const saved = await window.electronAPI.getSettings();

            // Browser for Cookies
            const browserEl = document.getElementById('browser');
            if (browserEl && saved.browser !== undefined) {
                browserEl.value = saved.browser;
            }

            // Download folder
            const folderEl = document.getElementById('downloadFolder');
            if (folderEl && saved.downloadFolder) {
                folderEl.value = saved.downloadFolder;
            }

            // SOCKS5 Proxy
            const proxyToggleSaved = document.getElementById('proxyEnabled');
            const proxyInputSaved = document.getElementById('proxyAddress');
            if (proxyToggleSaved && saved.proxyEnabled !== undefined) {
                proxyToggleSaved.checked = saved.proxyEnabled;
                if (proxyInputSaved) proxyInputSaved.disabled = !saved.proxyEnabled;
            }
            if (proxyInputSaved && saved.proxyAddress !== undefined) {
                proxyInputSaved.value = saved.proxyAddress;
            }
        } catch (e) {
            console.warn('Could not load saved settings:', e);
        }
    }

    // Persist settings on change
    const browserEl = document.getElementById('browser');
    if (browserEl) {
        browserEl.addEventListener('change', () => {
            window.electronAPI?.setSettings({ browser: browserEl.value }).catch(console.error);
        });
    }

    // Proxy toggle wiring + persistence
    const proxyToggle = document.getElementById('proxyEnabled');
    const proxyInput = document.getElementById('proxyAddress');
    if (proxyToggle && proxyInput) {
        proxyToggle.addEventListener('change', () => {
            proxyInput.disabled = !proxyToggle.checked;
            window.electronAPI?.setSettings({ proxyEnabled: proxyToggle.checked }).catch(console.error);
        });
        proxyInput.addEventListener('change', () => {
            window.electronAPI?.setSettings({ proxyAddress: proxyInput.value.trim() }).catch(console.error);
        });
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

// Show cleanup modal and return boolean for delete files
function showCleanupModal(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('cleanupModal');
        const messageEl = document.getElementById('cleanupMessage');
        const keepBtn = document.getElementById('keepFilesBtn');
        const deleteBtn = document.getElementById('deleteFilesBtn');

        if (message) {
            messageEl.textContent = message;
        }

        const handleKeep = () => {
            modal.style.display = 'none';
            cleanupListeners();
            resolve(false);
        };

        const handleDelete = () => {
            modal.style.display = 'none';
            cleanupListeners();
            resolve(true);
        };

        const cleanupListeners = () => {
            keepBtn.removeEventListener('click', handleKeep);
            deleteBtn.removeEventListener('click', handleDelete);
        };

        keepBtn.addEventListener('click', handleKeep);
        deleteBtn.addEventListener('click', handleDelete);

        modal.style.display = 'flex';
    });
}
