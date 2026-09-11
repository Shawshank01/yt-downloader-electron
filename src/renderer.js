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

// Function to check if a line is a progress update
function isProgressLine(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[download]')) {
        if (trimmed.includes('%') || trimmed.includes('ETA')) {
            return true;
        }
        if (/\s+[\d.]+\s*[kKmMgGtT]?i?B\s+at\s+/i.test(trimmed) || /\bat\s+\S*B\/s/i.test(trimmed)) {
            return true;
        }
        return false;
    }
    if ((/^(?:frame|size)=\s*\S+/i.test(trimmed) && trimmed.includes('time=')) ||
        (/^time=\S+/i.test(trimmed) && trimmed.includes('bitrate='))) {
        return true;
    }
    return false;
}

// Function to check if a line is intermediate extractor or probe noise
function isExtractorOrNoiseLine(line) {
    const trimmed = line.trim();
    if (/^\s*Duration:\s*[\d:.]+/i.test(trimmed)) {
        return true;
    }
    if (/^\[[^\]]+\]\s+Extracting URL:/i.test(trimmed)) {
        return true;
    }
    if (/^\[(?!download\])[^\]]+\]\s+(?:.*:\s+)?Downloading\s+/i.test(trimmed)) {
        return true;
    }
    if (/^Extract(?:ing|ed)\s+(?:\d+\s+)?cookies from/i.test(trimmed)) {
        return true;
    }
    if (/\[jsc:[^\]]+\]\s+Solving JS challenges/i.test(trimmed)) {
        return true;
    }
    if (/^\[SubtitlesConvertor\]/i.test(trimmed)) {
        return true;
    }
    return false;
}

// Function to clean yt-dlp output by removing progress lines and intermediate noise,
// keeping only the final progress line when progress lines are present
function cleanYtDlpResult(result) {
    if (!result) return result;

    const lines = result.split(/[\r\n]+/);
    const filteredLines = [];
    let lastProgressLine = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (isExtractorOrNoiseLine(trimmed)) {
            continue;
        }

        if (isProgressLine(trimmed)) {
            lastProgressLine = trimmed;
            continue;
        }

        if (lastProgressLine) {
            filteredLines.push(lastProgressLine);
            lastProgressLine = null;
        }
        filteredLines.push(trimmed);
    }

    if (lastProgressLine) {
        filteredLines.push(lastProgressLine);
        lastProgressLine = null;
    }

    return filteredLines.length > 0 ? filteredLines.join('\n') : result.trim();
}

// Resolve proxy URL if proxy is enabled
function getProxyUrl() {
    const proxyEnabled = document.getElementById('proxyEnabled');
    const proxyAddress = document.getElementById('proxyAddress');
    if (proxyEnabled && proxyEnabled.checked && proxyAddress) {
        const addr = proxyAddress.value.trim();
        if (addr) {
            return `socks5://${addr}/`;
        }
    }
    return '';
}

// Build proxy args for yt-dlp if proxy is enabled
function getProxyArgs() {
    const proxyUrl = getProxyUrl();
    return proxyUrl ? ['--proxy', proxyUrl] : [];
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

            const openNow = await showConfirmModal({
                title: 'Update Available',
                message: promptMsg,
                confirmText: 'Open Releases Page',
                cancelText: 'Later'
            });

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
                    if (dep.name === 'ffmpeg' && dep.hasSubtitlesFilter === false) {
                        lines.push(`  ⚠️ warning: missing libass / subtitles filter (hardsubbing disabled)`);
                        lines.push(`  👉 run 'brew install ffmpeg-full' to enable hardsubbing`);
                    }
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

            const shouldInstall = await showConfirmModal({
                title: 'Install Missing Dependencies',
                message:
                    `Missing dependencies:\n- ${result.missing.join('\n- ')}\n\n` +
                    `Would you like to install missing ones now?\n\n` +
                    (missingBrew
                        ? `This will run Homebrew installer:\n/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\nThen run:\nbrew install ${installList.filter((d) => d !== 'brew').join(' ')}`
                        : `This will run:\nbrew install ${installList.join(' ')}`) +
                    `\n\nYou can cancel and install later.`,
                confirmText: 'Install Now',
                cancelText: 'Install Later'
            });

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

// Validate form inputs before running any action
function validateRunInputs() {
    const url = document.getElementById('url').value.trim();
    const action = document.getElementById('action').value;
    const formatCode = document.getElementById('formatCode').value.trim();
    const browser = document.getElementById('browser').value.trim();
    const downloadFolder = document.getElementById('downloadFolder').value.trim();

    if (!url) {
        return { ok: false, error: 'Error: You must enter a video URL.' };
    }
    if (!['', 'brave', 'chrome', 'firefox', 'safari'].includes(browser)) {
        return { ok: false, error: 'Error: Invalid browser selection.' };
    }
    if (!downloadFolder && action !== 'List Formats' && action !== 'Download Subtitles') {
        return { ok: false, error: 'Error: Please select a download folder.' };
    }
    if (action === 'Download (Custom Format)' && !formatCode) {
        return {
            ok: false,
            error: 'Error: Please enter a format code (e.g., 140, 356, or 140+356) for audio/video download.'
        };
    }

    return {
        ok: true,
        values: { url, action, formatCode, browser, downloadFolder }
    };
}

// Build yt-dlp CLI arguments for the chosen action
async function buildActionArgs(action, { url, browser, downloadFolder, formatCode }) {
    const args = [...getProxyArgs()];
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
            args.push('-f', formatCode);
            if (!cachedFormatList) {
                document.getElementById('output').textContent =
                    'Detecting format metadata... (run "List Formats" first to skip this step)';
            }
            if (!await isImageFormat(formatCode, browser, url)) {
                const audioFmt = await getAudioOnlyWebmFormat(formatCode, browser, url);
                if (audioFmt) {
                    args.push('-x', '--audio-format', audioFmt);
                }
                args.push('--embed-thumbnail');
            }
            args.push('-P', downloadFolder, url);
            break;
        case 'Download Thumbnail':
            args.push('--write-thumbnail', '--skip-download', '-P', downloadFolder, url);
            break;
        case 'Download & Re-encode as high quality MP4 (H.264/AAC)':
            args.push('--write-thumbnail', '--convert-thumbnails', 'jpg', '-P', downloadFolder, url);
            break;
        default:
            args.push('--embed-thumbnail', '-P', downloadFolder, url);
            break;
    }
    return args;
}

// Manage cancel button UI state without cloning DOM nodes
function showCancelButton(onCancel = null) {
    const cancelActionControls = document.getElementById('cancelActionControls');
    const cancelActionBtn = document.getElementById('cancelActionBtn');
    if (!cancelActionControls || !cancelActionBtn) return;

    cancelActionControls.style.display = 'block';
    cancelActionBtn.disabled = false;
    cancelActionBtn.textContent = 'Cancel Action';

    cancelActionBtn.onclick = async () => {
        cancelActionBtn.disabled = true;
        cancelActionBtn.textContent = 'Cancelling...';
        if (onCancel) {
            await onCancel();
        } else {
            await window.electronAPI.cancelCommand();
        }
    };
}

function hideCancelButton() {
    const cancelActionControls = document.getElementById('cancelActionControls');
    const cancelActionBtn = document.getElementById('cancelActionBtn');
    if (cancelActionControls) cancelActionControls.style.display = 'none';
    if (cancelActionBtn) {
        cancelActionBtn.onclick = null;
        cancelActionBtn.disabled = false;
        cancelActionBtn.textContent = 'Cancel Action';
    }
}

// Render status banner with CSS classes
function renderStatusBanner(status, message) {
    const outputElement = document.getElementById('output');
    if (!outputElement) return;

    const banner = document.createElement('div');
    banner.className = `completion-hint ${status}`;
    banner.textContent = message;
    outputElement.appendChild(banner);
}

// Extract video ID from URL supporting YouTube, TikTok, Twitter/X, Instagram, Bilibili, Reddit, and generic platforms
function extractVideoId(url) {
    try {
        const urlObj = new URL(url);
        const host = urlObj.hostname.toLowerCase();
        const path = urlObj.pathname;

        // 1. YouTube
        if (host.includes('youtube.com') || host.includes('youtu.be')) {
            if (path.includes('/shorts/')) {
                const id = path.split('/shorts/')[1];
                return id ? id.split('/')[0].split('?')[0] : '';
            }
            if (path.includes('/embed/')) {
                const id = path.split('/embed/')[1];
                return id ? id.split('/')[0].split('?')[0] : '';
            }
            if (path.includes('/live/')) {
                const id = path.split('/live/')[1];
                return id ? id.split('/')[0].split('?')[0] : '';
            }
            if (path.includes('/watch')) {
                return urlObj.searchParams.get('v') || '';
            }
            if (host.includes('youtu.be')) {
                return path.substring(1).split('/')[0].split('?')[0];
            }
        }

        // 2. Twitter / X (e.g., https://x.com/user/status/1234567890)
        if (host.includes('twitter.com') || host.includes('x.com')) {
            const m = path.match(/status(?:es)?\/(\d+)/i);
            if (m) return m[1];
        }

        // 3. TikTok (e.g., https://www.tiktok.com/@user/video/1234567890)
        if (host.includes('tiktok.com')) {
            const m = path.match(/(?:video|v)\/(\d+)/i);
            if (m) return m[1];
        }

        // 4. Instagram (e.g., https://www.instagram.com/reel/C12345/)
        if (host.includes('instagram.com')) {
            const m = path.match(/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i);
            if (m) return m[1];
        }

        // 5. Bilibili (e.g., https://www.bilibili.com/video/BV1xx411c7mD)
        if (host.includes('bilibili.com')) {
            const m = path.match(/(BV[a-zA-Z0-9]+|av\d+)/i);
            if (m) return m[1];
        }

        // 6. Reddit (e.g., https://www.reddit.com/r/videos/comments/abc123/title/)
        if (host.includes('reddit.com')) {
            const m = path.match(/\/comments\/([a-z0-9]+)/i);
            if (m) return m[1];
        }

        // 7. Vimeo (e.g., https://vimeo.com/123456789)
        if (host.includes('vimeo.com')) {
            const m = path.match(/\/(\d+)/);
            if (m) return m[1];
        }

        // 8. Facebook (e.g., https://www.facebook.com/watch/?v=123456)
        if (host.includes('facebook.com')) {
            if (urlObj.searchParams.has('v')) return urlObj.searchParams.get('v');
            const m = path.match(/(?:reel|videos)\/(\d+)/i);
            if (m) return m[1];
        }

        // 9. Generic query param search
        for (const param of ['v', 'id', 'video_id', 'item_id']) {
            const val = urlObj.searchParams.get(param);
            if (val) return val;
        }

        // 10. Generic last path segment fallback
        const segments = path.split('/').filter(Boolean);
        if (segments.length > 0) {
            return segments[segments.length - 1].split('.')[0];
        }

        return '';
    } catch {
        return '';
    }
}

// Extract downloaded video destination path from yt-dlp stdout lines
function extractDownloadedPath(text) {
    if (!text) return null;
    const lines = text.split(/[\r\n]+/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        const mergeMatch = line.match(/^\[Merger\] Merging formats into ["']?(.+?)["']?$/i);
        if (mergeMatch) return mergeMatch[1].trim();

        const alreadyMatch = line.match(/^\[download\]\s+["']?(.+?)["']?\s+has already been downloaded/i);
        if (alreadyMatch) return alreadyMatch[1].trim();

        const destMatch = line.match(/^\[(?:download|ExtractAudio)\] Destination:\s+["']?(.+?)["']?$/i);
        if (destMatch) return destMatch[1].trim();
    }
    return null;
}

// Handle format list result and automatically transition UI
function handleFormatListSelection(result, isCancelled, isError) {
    cachedFormatList = result || '';
    if (!isCancelled && !isError) {
        const actionSelect = document.getElementById('action');
        if (actionSelect) {
            actionSelect.value = 'Download (Custom Format)';
            updateFormatCodeVisibility();
            actionSelect.dispatchEvent(new Event('change'));
            const formatCodeInput = document.getElementById('formatCode');
            if (formatCodeInput) {
                formatCodeInput.focus();
            }
        }
    }
}

// Handle optional re-encode workflow following download
async function handleReEncodePrompt({ url, downloadFolder, commandLine, cleanResult }) {
    const shouldReEncode = await showConfirmModal({
        title: 'Re-encode to MP4?',
        message:
            'Video download completed! Would you like to re-encode it to high quality MP4 (H.264/AAC)?\n\n' +
            'This will:\n' +
            '• Use H.264 video codec with high quality (CRF 22)\n' +
            '• Use AAC audio codec for maximum compatibility\n' +
            '• Replace the original file with the re-encoded version\n\n' +
            'Note: Re-encoding may take some time depending on the video length.\n\n' +
            'If you skip re-encoding, the original video format will be preserved.',
        confirmText: 'Re-encode',
        cancelText: 'Skip'
    });

    if (!shouldReEncode) {
        document.getElementById('output').textContent +=
            '\n\nRe-encoding skipped. Original video file preserved.';
        return;
    }

    document.getElementById('output').textContent +=
        '\n\nRe-encoding videos to H.264/AAC...\n';

    // Prefer exact downloaded file path from yt-dlp output, or fall back to extracted video ID
    const downloadedPath = extractDownloadedPath(cleanResult);
    const targetIdentifier = downloadedPath || extractVideoId(url);

    if (!targetIdentifier) {
        document.getElementById('output').textContent +=
            'Could not determine video file or extract video ID from URL.';
        return;
    }

    showCancelButton();

    try {
        const reEncodeResult = await window.electronAPI.reEncodeToMp4(downloadFolder, targetIdentifier);
        const res = typeof reEncodeResult === 'string'
            ? (() => { try { return JSON.parse(reEncodeResult); } catch { return { success: false, message: reEncodeResult, tmpFiles: [] }; } })()
            : reEncodeResult;

        const messageText = res.message || res.text || '';
        document.getElementById('output').textContent =
            commandLine + '\n' + cleanResult + '\n' + messageText;

        if (res.tmpFiles && res.tmpFiles.length > 0) {
            const shouldDelete = await showCleanupModal(
                'Re-encoding completed successfully. Do you want to delete the temporary downloaded files (original video and thumbnail)?'
            );
            if (shouldDelete) {
                await window.electronAPI.deleteTemporaryFiles(res.tmpFiles);
                document.getElementById('output').textContent += '\n\nTemporary files cleaned up.';
            }
        }

        if (res.cancelled) {
            renderStatusBanner('cancelled', '❌ Re-encoding canceled!');
        } else if (res.success) {
            renderStatusBanner('success', '✅ Re-encoding completed successfully!');
        } else {
            renderStatusBanner('error', '❌ Re-encoding failed!');
        }
    } catch (reEncodeError) {
        document.getElementById('output').textContent +=
            `\nRe-encoding error: ${reEncodeError.message || reEncodeError}`;
        renderStatusBanner('error', '❌ Re-encoding failed!');
    } finally {
        hideCancelButton();
    }
}

window.runCommand = async function () {
    const validation = validateRunInputs();
    if (!validation.ok) {
        document.getElementById('output').textContent = validation.error;
        return;
    }

    const { url, action, formatCode, browser, downloadFolder } = validation.values;

    if (action === 'Download Subtitles') {
        await handleSubtitleDownload(url, browser, downloadFolder);
        return;
    }
    if (action === 'Download & Add Hardsub' || action === 'Download & Add Hardsub (Only Support on macOS)') {
        await handleHardsubAction(url, browser, downloadFolder);
        return;
    }

    if (progressHandler) {
        progressHandler();
    }

    const args = await buildActionArgs(action, { url, browser, downloadFolder, formatCode });
    const commandLine = 'Running: yt-dlp ' + args.join(' ');
    const outputElement = document.getElementById('output');

    progressHandler = window.electronAPI.onProgress((progress) => {
        outputElement.textContent = commandLine + '\n' + progress;
    });

    outputElement.textContent = commandLine + '\n';
    console.log('Running command:', args);

    showCancelButton();

    try {
        const rawResult = await window.electronAPI.runCommand(args);
        const res = typeof rawResult === 'object' && rawResult !== null
            ? rawResult
            : {
                success: !(rawResult || '').includes('Process exited with code') &&
                    !(rawResult || '').includes('ERROR:') &&
                    !(rawResult || '').startsWith('Error:'),
                cancelled: (rawResult || '').includes('cancelled by user'),
                output: rawResult || '',
                error: (rawResult || '').includes('ERROR:') ? rawResult : ''
            };

        const resultOutput = res.output || '';
        const cleanResult = action === 'List Formats' ? resultOutput.trim() : cleanYtDlpResult(resultOutput);
        outputElement.textContent = commandLine + '\n' + cleanResult;

        const isCancelled = res.cancelled;
        const isError = !res.success && !isCancelled;

        if (action === 'List Formats') {
            handleFormatListSelection(resultOutput, isCancelled, isError);
        } else if (
            action === 'Download & Re-encode as high quality MP4 (H.264/AAC)' &&
            downloadFolder &&
            !isCancelled &&
            !isError
        ) {
            await handleReEncodePrompt({ url, downloadFolder, commandLine, cleanResult });
        }

        if (action !== 'List Formats') {
            if (isCancelled) {
                renderStatusBanner('cancelled', '❌ Download canceled!');
            } else if (isError) {
                renderStatusBanner('error', '❌ Download failed!');
            } else {
                renderStatusBanner('success', '✅ Download completed!');
            }
        }
    } catch (e) {
        outputElement.textContent += '\nError: ' + (e?.message || e);
        if (action !== 'List Formats') {
            renderStatusBanner('error', '❌ Download failed!');
        }
    } finally {
        hideCancelButton();
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
        codecGroup.style.display =
            (action === 'Download & Add Hardsub' || action === 'Download & Add Hardsub (Only Support on macOS)') ? '' : 'none';
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
        const proxyUrl = getProxyUrl();
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
        args.push(
            subsFlag,
            '--sub-langs', selectedSubtitle.code,
            '--skip-download',
            '--convert-subs', 'vtt',
            '-P', downloadFolder,
            url
        );

        const commandLine = 'Running: yt-dlp ' + args.join(' ');
        output.textContent = commandLine + '\n';

        if (progressHandler) {
            progressHandler();
        }

        progressHandler = window.electronAPI.onProgress((progress) => {
            output.textContent = commandLine + '\n' + progress;
        });

        showCancelButton();

        try {
            const rawCmdResult = await window.electronAPI.runCommand(args);
            const res = typeof rawCmdResult === 'object' && rawCmdResult !== null
                ? rawCmdResult
                : {
                    success: !(rawCmdResult || '').includes('Process exited with code') && !(rawCmdResult || '').includes('ERROR:'),
                    cancelled: (rawCmdResult || '').includes('cancelled by user'),
                    output: rawCmdResult || ''
                };

            const cleanResult = cleanYtDlpResult(res.output);

            if (res.cancelled) {
                output.textContent = 'Subtitle download cancelled.';
                renderStatusBanner('cancelled', '❌ Download canceled!');
            } else if (!res.success && (res.output || '').includes('There are no subtitles for the requested languages')) {
                output.textContent = 'No subtitles available for this video.';
                renderStatusBanner('error', '❌ No subtitles available for this video.');
            } else if (!res.success) {
                output.textContent = `${commandLine}\n${res.error || res.output || 'Subtitle download failed.'}`;
                renderStatusBanner('error', '❌ Download failed!');
            } else {
                output.textContent = cleanResult
                    ? `${commandLine}\n${cleanResult}`
                    : `${commandLine}\nLanguage: ${selectedSubtitle.name} (${selectedSubtitle.code})\nFolder: ${downloadFolder}`;
                renderStatusBanner('success', `✅ Subtitle downloaded: ${selectedSubtitle.name} (${selectedSubtitle.code})`);
            }
        } finally {
            hideCancelButton();
        }
    } catch (error) {
        output.textContent = `Error: ${error.message || error}`;
        renderStatusBanner('error', '❌ Download failed!');
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

    if (progressHandler) {
        progressHandler();
    }

    progressHandler = window.electronAPI.onProgress((progress) => {
        output.textContent = progress;
    });

    output.textContent = 'Fetching available subtitles...';

    try {
        const proxyUrl = getProxyUrl();
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
            output.textContent = 'Subtitle selection cancelled.';
            return;
        }

        output.textContent = `Selected subtitle: ${selectedSubtitle.name} (${selectedSubtitle.code})\nStarting download...`;
        showCancelButton();

        try {
            const rawHardsubResult = await window.electronAPI.downloadWithHardsub({
                url,
                browser,
                downloadFolder,
                subtitleLang: selectedSubtitle.code,
                subtitleType: selectedSubtitle.type,
                codec,
                proxy: proxyUrl
            });

            const res = typeof rawHardsubResult === 'object' && rawHardsubResult !== null
                ? rawHardsubResult
                : (() => {
                    try {
                        return JSON.parse(rawHardsubResult);
                    } catch {
                        return {
                            success: (rawHardsubResult || '').includes('completed') || (rawHardsubResult || '').includes('Saved as'),
                            cancelled: (rawHardsubResult || '').includes('cancelled by user'),
                            message: rawHardsubResult || '',
                            tmpFiles: []
                        };
                    }
                })();

            const messageText = res.message || res.text || '';
            output.textContent = messageText;

            if (res.tmpFiles && res.tmpFiles.length > 0) {
                const shouldDelete = await showCleanupModal(
                    'Hardsub completed successfully. Do you want to delete the temporary downloaded files (original video, thumbnail, and subtitles)?'
                );
                if (shouldDelete) {
                    await window.electronAPI.deleteTemporaryFiles(res.tmpFiles);
                }
            }

            if (res.cancelled) {
                renderStatusBanner('cancelled', '❌ Hardsub canceled!');
            } else if (res.success) {
                renderStatusBanner('success', '✅ Hardsub completed!');
            } else {
                renderStatusBanner('error', '❌ Hardsub failed!');
            }
        } finally {
            hideCancelButton();
        }
    } catch (error) {
        if (error?.cancelled || (error?.message && error.message.includes('cancelled by user'))) {
            output.textContent = 'Action cancelled by user.';
            renderStatusBanner('cancelled', '❌ Hardsub canceled!');
        } else {
            output.textContent = `Error: ${error?.message || error}`;
            renderStatusBanner('error', '❌ Hardsub failed!');
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
});

// Show asynchronous confirmation modal and return boolean without freezing UI thread
function showConfirmModal({ title = 'Confirm Action', message = '', confirmText = 'Confirm', cancelText = 'Cancel' } = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const cancelBtn = document.getElementById('confirmCancelBtn');
        const acceptBtn = document.getElementById('confirmAcceptBtn');

        if (!modal || !cancelBtn || !acceptBtn) {
            resolve(false);
            return;
        }

        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;
        acceptBtn.textContent = confirmText;
        cancelBtn.textContent = cancelText;

        const cleanup = () => {
            modal.style.display = 'none';
            acceptBtn.removeEventListener('click', handleAccept);
            cancelBtn.removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKeydown);
        };

        const handleAccept = () => {
            cleanup();
            resolve(true);
        };

        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        acceptBtn.addEventListener('click', handleAccept);
        cancelBtn.addEventListener('click', handleCancel);
        document.addEventListener('keydown', handleKeydown);

        modal.style.display = 'flex';
        acceptBtn.focus();
    });
}

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
