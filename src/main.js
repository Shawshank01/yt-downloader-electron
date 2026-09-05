import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename } from 'path';
import { promises as fs } from 'fs';
import { checkAppUpdate, getCurrentVersion, isAutoUpdaterSupported } from './update.js';

// ESM-compatible dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Persistent user settings
let settingsFilePath = null;

async function getSettingsPath() {
    if (!settingsFilePath) {
        settingsFilePath = join(app.getPath('userData'), 'user-settings.json');
    }
    return settingsFilePath;
}

async function readSettings() {
    try {
        const filePath = await getSettingsPath();
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function writeSettings(data) {
    try {
        const filePath = await getSettingsPath();
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('Failed to write settings:', e);
    }
}

ipcMain.handle('get-settings', async () => {
    return readSettings();
});

ipcMain.handle('set-settings', async (_event, updates) => {
    const current = await readSettings();
    const merged = { ...current, ...updates };
    await writeSettings(merged);
    return merged;
});

// Fix PATH so yt-dlp is found
const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...extraPaths])].join(':');

// Global state for any active long-running process (yt-dlp or ffmpeg)
let activeProcess = null;
let isActionCancelled = false;

// Rule list for log noise reduction
const LOG_NOISE_PATTERNS = [
    /Opening 'https?:\/\//i,                                // HLS segment download spam
    /Changing ID3 metadata in HLS audio/i,                  // Twitter/X non-fatal metadata warning
    /mime type is not rfc8216 compliant/i,                  // HLS header compliance warning
    /^\s*(Input|Output) #\d+/i,                             // FFmpeg stream probe input/output header
    /^\s*Program \d+/i,                                     // FFmpeg program header
    /^\s*Stream mapping:/i,                                 // FFmpeg stream mapping header
    /^\s*Stream #\d+:\d+/i,                                 // FFmpeg stream descriptor
    /^\s*(Metadata:|variant_bitrate|encoder\s*:)/i,          // FFmpeg metadata tags
    /^\s*(TIT3|id3v2_priv|JSONMetadata|Hydra)/i,            // Twitter HLS ID3 metadata dumps
    /Press \[[q?]\] to stop/i,                              // FFmpeg interactive prompt
    /muxing overhead: unknown/i                             // FFmpeg muxing summary header
];

function shouldSuppressLogLine(line) {
    return LOG_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

// Line buffer wrapper to safely handle chunked stream data and filter noise
class LineStreamFilter {
    constructor(onLine) {
        this.buffer = '';
        this.onLine = onLine;
    }

    push(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split(/\r\n|\r|\n/);
        this.buffer = lines.pop(); // Keep incomplete trailing fragment in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 0 && !shouldSuppressLogLine(trimmed)) {
                this.onLine(line);
            }
        }
    }

    flush() {
        if (this.buffer.length > 0) {
            const trimmed = this.buffer.trim();
            if (trimmed.length > 0 && !shouldSuppressLogLine(trimmed)) {
                this.onLine(this.buffer);
            }
            this.buffer = '';
        }
    }
}

function runCommandWithOutput(command) {
    return new Promise((resolve) => {
        exec(command, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    stdout: stdout?.trim() || '',
                    stderr: stderr?.trim() || '',
                    error: error.message
                });
                return;
            }

            resolve({
                ok: true,
                stdout: stdout?.trim() || '',
                stderr: stderr?.trim() || '',
                error: ''
            });
        });
    });
}

async function getDependencyInfo(name, versionCommand) {
    const pathCommand = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const pathResult = await runCommandWithOutput(pathCommand);
    if (!pathResult.ok || !pathResult.stdout) {
        return {
            name,
            installed: false,
            path: '',
            version: ''
        };
    }

    const versionResult = await runCommandWithOutput(versionCommand);
    const versionLine =
        versionResult.stdout.split('\n')[0]?.trim() ||
        versionResult.stderr.split('\n')[0]?.trim() ||
        'Version unavailable';

    return {
        name,
        installed: true,
        path: pathResult.stdout.split('\n')[0].trim(),
        version: versionLine
    };
}

// Unified IPC handler for cancelling the current action
ipcMain.handle('cancel-command', async () => {
    if (activeProcess) {
        isActionCancelled = true;
        const pid = activeProcess.pid;
        console.log(`Cancelling current process with PID: ${pid}`);

        try {
            process.kill(pid, 'SIGKILL');
        } catch (e) {
            console.error("Error killing process:", e);
        }

        console.log("Process kill signal sent.");
        return true;
    }
    return false;
});

ipcMain.handle('check-dependencies', async () => {
    try {
        const isMac = process.platform === 'darwin';
        const checkList = [
            getDependencyInfo('yt-dlp', 'yt-dlp --version'),
            getDependencyInfo('ffmpeg', 'ffmpeg -version')
        ];

        if (isMac) {
            checkList.unshift(getDependencyInfo('brew', 'brew --version'));
        }

        const dependencies = await Promise.all(checkList);
        const missing = dependencies.filter((dep) => !dep.installed).map((dep) => dep.name);

        return {
            success: true,
            allInstalled: missing.length === 0,
            dependencies,
            missing,
            platform: process.platform
        };
    } catch (error) {
        return {
            success: false,
            message: error.message || 'Failed to check dependencies.'
        };
    }
});

ipcMain.handle('install-missing-dependencies', async (_event, options = {}) => {
    if (process.platform !== 'darwin') {
        return {
            success: false,
            message: 'Automatic installation is supported on macOS only.'
        };
    }

    try {
        const installHomebrew = Boolean(options.installHomebrew);
        let brewInfo = await getDependencyInfo('brew', 'brew --version');

        if (!brewInfo.installed) {
            if (!installHomebrew) {
                return {
                    success: false,
                    message:
                        'Homebrew is not installed. Please install it first, then restart the dependency check.'
                };
            }

            const brewInstallCommand =
                '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
            const brewInstallResult = await runCommandWithOutput(brewInstallCommand);
            if (!brewInstallResult.ok) {
                return {
                    success: false,
                    message:
                        brewInstallResult.stderr ||
                        brewInstallResult.error ||
                        'Failed to install Homebrew.'
                };
            }

            brewInfo = await getDependencyInfo('brew', 'brew --version');
            if (!brewInfo.installed) {
                return {
                    success: false,
                    message:
                        'Homebrew installation command finished, but brew is still not found in PATH.'
                };
            }
        }

        const ytDlpInfo = await getDependencyInfo('yt-dlp', 'yt-dlp --version');
        const ffmpegInfo = await getDependencyInfo('ffmpeg', 'ffmpeg -version');

        const missing = [];
        if (!ytDlpInfo.installed) missing.push('yt-dlp');
        if (!ffmpegInfo.installed) missing.push('ffmpeg');

        if (missing.length === 0) {
            return {
                success: true,
                installed: [],
                failed: [],
                message: 'Nothing to install.',
                dependencies: [brewInfo, ytDlpInfo, ffmpegInfo]
            };
        }

        const installed = [];
        const failed = [];
        const details = {};

        for (const dep of missing) {
            const cmd = `brew install ${dep}`;
            const result = await runCommandWithOutput(cmd);
            details[dep] = result;

            if (result.ok) {
                installed.push(dep);
            } else {
                failed.push(dep);
            }
        }

        const finalDependencies = await Promise.all([
            getDependencyInfo('brew', 'brew --version'),
            getDependencyInfo('yt-dlp', 'yt-dlp --version'),
            getDependencyInfo('ffmpeg', 'ffmpeg -version')
        ]);

        return {
            success: failed.length === 0,
            installed,
            failed,
            message:
                failed.length === 0
                    ? 'Installation completed.'
                    : 'Installation finished with some failures.',
            dependencies: finalDependencies,
            details
        };
    } catch (error) {
        return {
            success: false,
            message: error.message || 'Failed to install dependencies.'
        };
    }
});

function createWindow() {
    const win = new BrowserWindow({
        fullscreenable: true,
        webPreferences: {
            preload: join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    win.loadFile(join(__dirname, 'index.html'));

    // Maximise the window
    win.maximize();
}

app.whenReady().then(createWindow).catch(console.error);

// IPC handler for folder picker
ipcMain.handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0];
});

// IPC handler to fetch format metadata for a specific format code
ipcMain.handle('get-format-info', async (_event, args) => {
    return new Promise((resolve) => {
        const child = spawn('yt-dlp', args);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => stdout += d);
        child.stderr.on('data', (d) => stderr += d);
        child.on('close', (code) => {
            resolve({ ok: code === 0, output: stdout.trim(), error: stderr.trim() });
        });
    });
});

// IPC handler for running yt-dlp commands
ipcMain.handle('run-command', async (event, args) => {
    console.log('Executing:', args);
    console.log('process.env.PATH:', process.env.PATH);

    if (activeProcess) {
        return 'Error: Another task is already running. Please await completion or cancel it.';
    }

    isActionCancelled = false;

    return new Promise((resolve) => {
        activeProcess = spawn('yt-dlp', args);
        let outputLines = [];

        const handleCleanLine = (line) => {
            const trimmed = line.trim();
            if (trimmed.includes('[download]')) {
                event.sender.send('download-progress', trimmed);
            }
            if (!trimmed.startsWith('[download]') || (!trimmed.includes('%') && !trimmed.includes('ETA'))) {
                outputLines.push(line);
            }
        };

        const stdoutFilter = new LineStreamFilter(handleCleanLine);
        const stderrFilter = new LineStreamFilter(handleCleanLine);

        activeProcess.stdout.on('data', (data) => stdoutFilter.push(data));
        activeProcess.stderr.on('data', (data) => stderrFilter.push(data));

        activeProcess.on('close', (code) => {
            stdoutFilter.flush();
            stderrFilter.flush();
            activeProcess = null;

            let output = outputLines.join('\n');
            if (isActionCancelled) {
                resolve('Action cancelled by user.');
            } else {
                if (code !== 0) {
                    output += `\nProcess exited with code ${code}`;
                }
                resolve(output.trim());
            }
        });
    });
});

// IPC handler for re-encoding videos to MP4 with H.264 and AAC
ipcMain.handle('re-encode-to-mp4', async (event, downloadFolder, videoId) => {
    console.log("Re-encoding video in folder:", downloadFolder, "for video ID:", videoId);

    if (activeProcess) {
        return 'Error: Another task is already running. Please await completion or cancel it.';
    }

    try {
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];
        const allFiles = await fs.readdir(downloadFolder);
        const files = allFiles.filter(file => {
            const lowerFile = file.toLowerCase();
            return videoExtensions.some(ext => lowerFile.endsWith(ext)) && file.includes(videoId);
        });

        if (files.length === 0) {
            return "No matching video file found to re-encode.";
        }

        const file = files[0];
        const filePath = join(downloadFolder, file);

        const fileExt = extname(file);
        const filename = basename(file, fileExt);
        const outputPath = join(downloadFolder, `${filename}_reencoded.mp4`);
        isActionCancelled = false;

        // Find matching thumbnail file
        let thumbnailFile = null;
        for (const f of allFiles) {
            if (f.endsWith('.jpg') && f.includes(filename.substring(0, 20))) {
                thumbnailFile = f;
                break;
            }
        }
        const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;

        console.log(`Re-encoding file: ${file}`);
        event.sender.send('download-progress', `Re-encoding ${file}...`);

        return new Promise((resolve) => {
            const tryReEncode = (audioCodec) => {
                const args = [];
                args.push('-i', filePath);

                if (thumbnailPath) {
                    args.push('-i', thumbnailPath);
                    args.push('-map', '0:v:0', '-map', '0:a:0', '-map', '1:v:0');
                    args.push('-c:v:0', 'libx264', '-crf:0', '22', '-preset', 'veryslow', '-c:a:0', audioCodec, '-tag:v:0', 'avc1');
                    args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic');
                } else {
                    args.push('-c:v', 'libx264', '-crf', '22', '-preset', 'veryslow', '-c:a', audioCodec, '-tag:v', 'avc1');
                }

                args.push(outputPath);

                activeProcess = spawn('ffmpeg', args);

                activeProcess.stdout.on('data', (data) => {
                    if (isActionCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=')) {
                        event.sender.send('download-progress', `Re-encoding ${file} (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeProcess.stderr.on('data', (data) => {
                    if (isActionCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=')) {
                        event.sender.send('download-progress', `Re-encoding ${file} (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeProcess.on('close', async (code) => {
                    activeProcess = null;

                    if (isActionCancelled) {
                        console.log("Re-encoding was cancelled. Cleaning up...");
                        try {
                            await fs.unlink(outputPath);
                        } catch { /* ignore if output file doesn't exist */ }
                        try {
                            await fs.unlink(filePath);
                            console.log(`Deleted original file: ${filePath}`);
                        } catch { /* ignore if input file doesn't exist */ }

                        if (thumbnailPath) {
                            try { await fs.unlink(thumbnailPath); } catch (e) { if (e.code !== 'ENOENT') console.error('Cleanup error:', e); }
                        }

                        resolve("Re-encoding cancelled by user. Files cleaned up.");
                        return;
                    }

                    if (code === 0) {
                        try {
                            const finalPath = join(downloadFolder, `${filename}.mp4`);
                            await fs.rename(outputPath, finalPath);

                            console.log(`Successfully re-encoded: ${file} to ${finalPath}`);
                            const tmpFiles = [filePath];
                            if (thumbnailPath) tmpFiles.push(thumbnailPath);

                            resolve(JSON.stringify({
                                text: `Re-encoding completed successfully. Saved as: ${filename}.mp4`,
                                tmpFiles: tmpFiles
                            }));
                        } catch (err) {
                            console.error("Error replacing file:", err);
                            resolve(JSON.stringify({ text: `Re-encoding finished but failed to replace file: ${err.message}` }));
                        }
                    } else if (code !== 0 && audioCodec === 'aac_at') {
                        // Fallback to libfdk_aac
                        console.log(`aac_at failed for ${file}, trying with libfdk_aac...`);
                        event.sender.send('download-progress', `aac_at not available, trying with libfdk_aac...`);
                        tryReEncode('libfdk_aac');
                    } else if (code !== 0 && audioCodec === 'libfdk_aac') {
                        // Fallback to built-in aac codec
                        console.log(`libfdk_aac failed for ${file}, trying with aac...`);
                        event.sender.send('download-progress', `libfdk_aac not available, trying with aac...`);
                        tryReEncode('aac');
                    } else {
                        console.log(`Failed to re-encode: ${file}`);
                        try {
                            await fs.unlink(outputPath);
                        } catch { /* ignore */ }

                        resolve(`Failed to re-encode ${file}`);
                    }
                });
            };

            tryReEncode('aac_at');
        });

    } catch (error) {
        return `Error during re-encoding: ${error.message}`;
    }
});

// IPC handler for opening external links
ipcMain.handle('open-external', async (_event, url) => {
    if (typeof url !== 'string' || url.trim() === '') {
        return false;
    }

    try {
        await shell.openExternal(url);
        return true;
    } catch (error) {
        console.error('Failed to open external URL:', error);
        return false;
    }
});

// App update-related IPC handlers
ipcMain.handle('check-app-update', checkAppUpdate);
ipcMain.handle('get-current-version', getCurrentVersion);
ipcMain.handle('is-auto-updater-supported', isAutoUpdaterSupported);

// IPC handler for listing available subtitles
ipcMain.handle('list-subtitles', async (_event, url, browser, proxy) => {
    console.log('Listing subtitles for:', url);

    return new Promise((resolve) => {
        let args = ['-j', '--skip-download'];
        if (proxy) args.push('--proxy', proxy);
        if (browser) args.push('--cookies-from-browser', browser);
        args.push(url);

        const child = spawn('yt-dlp', args);
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => stdout += data);
        child.stderr.on('data', (data) => stderr += data);

        child.on('close', (code) => {
            if (code !== 0) {
                console.error('Error getting video info:', stderr);
                resolve({ error: true, message: stderr || 'Unknown error', subtitles: [], isAutoGenerated: false });
                return;
            }

            try {
                const info = JSON.parse(stdout);
                const manualSubtitles = [];
                const autoGenerated = [];

                // Get manually uploaded subtitles
                if (info.subtitles) {
                    for (const [code, formats] of Object.entries(info.subtitles)) {
                        if (formats && formats.length > 0) {
                            const name = formats[0].name || code.toUpperCase();
                            manualSubtitles.push({ code, name, type: 'manual' });
                        }
                    }
                }

                // Get auto-generated caption in the video's original language only
                if (info.automatic_captions && info.language) {
                    const lang = info.language;
                    // Prefer the "-orig" variant, fall back to base language code
                    const origKey = `${lang}-orig`;
                    const key = info.automatic_captions[origKey] ? origKey : (info.automatic_captions[lang] ? lang : null);
                    if (key) {
                        const formats = info.automatic_captions[key];
                        const rawName = (formats[0] && formats[0].name) || lang.toUpperCase();
                        const name = rawName.replace(/\(Original\)/gi, '').trim() || lang.toUpperCase();
                        autoGenerated.push({ code: key, name, type: 'auto-original' });
                    }
                }

                // Priority: manual subtitles first, then auto-generated
                let subtitlesToReturn;
                let isAutoGenerated = false;

                if (manualSubtitles.length > 0) {
                    subtitlesToReturn = manualSubtitles;
                    console.log('Found manual subtitles:', subtitlesToReturn);
                } else if (autoGenerated.length > 0) {
                    subtitlesToReturn = autoGenerated;
                    isAutoGenerated = true;
                    console.log('No manual subtitles, showing auto-generated:', subtitlesToReturn);
                } else {
                    subtitlesToReturn = [];
                    console.log('No subtitles available');
                }

                resolve({ error: false, subtitles: subtitlesToReturn, isAutoGenerated });
            } catch (parseError) {
                console.error('Error parsing video info:', parseError);
                resolve({ error: true, message: 'Failed to parse video information', subtitles: [], isAutoGenerated: false });
            }
        });
    });
});

// IPC handler for downloading video with hardcoded subtitles
ipcMain.handle('download-with-hardsub', async (event, options) => {
    const { url, browser, downloadFolder, subtitleLang, subtitleType, codec, proxy } = options;
    console.log('Download with hardsub:', { url, subtitleLang, subtitleType, codec, downloadFolder });

    if (activeProcess) {
        return 'Error: Another task is already running. Please await completion or cancel it.';
    }

    try {
        // Step 1: Download video with subtitle (limit to avc1/H.264)
        // Use --write-auto-subs for auto-generated captions, --write-subs for manual subtitles
        const subsFlag = subtitleType === 'manual' ? '--write-subs' : '--write-auto-subs';
        let args = [
            '-f', 'bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]',
            subsFlag, '--sub-langs', subtitleLang,
            '--convert-subs', 'vtt',
            '--write-thumbnail', '--convert-thumbnails', 'jpg',
            '-P', downloadFolder
        ];
        if (proxy) args.push('--proxy', proxy);
        if (browser) args.push('--cookies-from-browser', browser);
        args.push(url);

        event.sender.send('download-progress', 'Downloading video and subtitles...');
        console.log('Download command:', args);

        // Execute download
        await new Promise((resolve, reject) => {
            isActionCancelled = false;
            activeProcess = spawn('yt-dlp', args);

            const handleProgressLine = (line) => {
                if (line.includes('[download]')) {
                    event.sender.send('download-progress', line.trim());
                }
            };

            const stdoutFilter = new LineStreamFilter(handleProgressLine);
            const stderrFilter = new LineStreamFilter(handleProgressLine);

            activeProcess.stdout.on('data', (data) => stdoutFilter.push(data));
            activeProcess.stderr.on('data', (data) => stderrFilter.push(data));

            activeProcess.on('close', (code) => {
                stdoutFilter.flush();
                stderrFilter.flush();
                activeProcess = null;
                if (isActionCancelled) {
                    reject(new Error('Action cancelled by user.'));
                } else if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Download failed with code ${code}`));
                }
            });
        });

        // Step 2: Find downloaded files
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];
        const allFiles = await fs.readdir(downloadFolder);

        // Sort by modification time descending to get most recent files
        const filesWithStats = await Promise.all(
            allFiles.map(async (file) => {
                const filePath = join(downloadFolder, file);
                const stat = await fs.stat(filePath);
                return { file, mtime: stat.mtime };
            })
        );
        filesWithStats.sort((a, b) => b.mtime - a.mtime);

        // Find the most recently downloaded video file
        let videoFile = null;
        for (const { file } of filesWithStats) {
            const lowerFile = file.toLowerCase();
            if (videoExtensions.some(ext => lowerFile.endsWith(ext)) && !file.includes('_hardsub')) {
                videoFile = file;
                break;
            }
        }

        if (!videoFile) {
            return 'Error: No video file found after download.';
        }

        // Find matching subtitle file
        const videoBasename = basename(videoFile, extname(videoFile));
        let subtitleFile = null;

        for (const { file } of filesWithStats) {
            if (file.endsWith('.vtt') && file.includes(videoBasename.substring(0, 20))) {
                subtitleFile = file;
                break;
            }
        }

        // Also check for subtitle files that match the language
        if (!subtitleFile) {
            for (const { file } of filesWithStats) {
                if (file.endsWith('.vtt') && file.includes(subtitleLang)) {
                    subtitleFile = file;
                    break;
                }
            }
        }

        if (!subtitleFile) {
            return 'Error: No subtitle file found after download. The video may not have subtitles in the selected language.';
        }

        // Find matching thumbnail file
        let thumbnailFile = null;
        for (const { file } of filesWithStats) {
            if (file.endsWith('.jpg') && file.includes(videoBasename.substring(0, 20))) {
                thumbnailFile = file;
                break;
            }
        }

        const videoPath = join(downloadFolder, videoFile);
        const subtitlePath = join(downloadFolder, subtitleFile);
        const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;
        const videoExt = extname(videoFile);
        const videoName = basename(videoFile, videoExt);
        const codecSuffix = codec === 'hevc' ? '_HEVC' : '_H264';
        const outputPath = join(downloadFolder, `${videoName}${codecSuffix}_temp.mp4`);

        console.log('Video file:', videoPath);
        console.log('Subtitle file:', subtitlePath);
        console.log('Output path:', outputPath);

        // Step 3: Run ffmpeg with hardsub
        event.sender.send('download-progress', `Hardcoding subtitles using ${codec.toUpperCase()}...`);
        isActionCancelled = false;

        return new Promise((resolve) => {
            const tryHardsub = (audioCodec) => {
                let args = [];

                // Escape the subtitle path for ffmpeg filter
                const escapedSubPath = subtitlePath.replace(/'/g, "'\\''").replace(/:/g, '\\:');

                args.push('-hwaccel', 'videotoolbox');
                args.push('-i', videoPath);

                if (thumbnailPath) {
                    args.push('-i', thumbnailPath);
                    args.push('-map', '0:v:0', '-map', '0:a:0', '-map', '1:v:0');
                    args.push('-filter:v:0', `subtitles='${escapedSubPath}':force_style='FontName=Songti SC'`);
                } else {
                    args.push('-vf', `subtitles='${escapedSubPath}':force_style='FontName=Songti SC'`);
                }

                if (codec === 'hevc') {
                    args.push(
                        thumbnailPath ? '-c:v:0' : '-c:v', 'hevc_videotoolbox',
                        '-pix_fmt', 'p010le',
                        thumbnailPath ? '-b:v:0' : '-b:v', '2500k',
                        thumbnailPath ? '-tag:v:0' : '-tag:v', 'hvc1'
                    );
                } else {
                    // Default to H.264
                    args.push(
                        thumbnailPath ? '-c:v:0' : '-c:v', 'h264_videotoolbox',
                        thumbnailPath ? '-b:v:0' : '-b:v', '4000k',
                        thumbnailPath ? '-tag:v:0' : '-tag:v', 'avc1'
                    );
                }

                args.push(thumbnailPath ? '-c:a:0' : '-c:a', audioCodec);

                if (thumbnailPath) {
                    args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic');
                }

                args.push(outputPath);

                console.log('FFmpeg args:', args);
                activeProcess = spawn('ffmpeg', args);

                activeProcess.stdout.on('data', (data) => {
                    if (isActionCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=') || str.includes('frame=')) {
                        event.sender.send('download-progress', `Hardcoding (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeProcess.stderr.on('data', (data) => {
                    if (isActionCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=') || str.includes('frame=')) {
                        event.sender.send('download-progress', `Hardcoding (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeProcess.on('close', async (code) => {
                    activeProcess = null;

                    if (isActionCancelled) {
                        console.log("Hardsub was cancelled. Cleaning up...");
                        try { await fs.unlink(outputPath); } catch { /* ignore */ }
                        resolve("Hardsub cancelled by user.");
                        return;
                    }

                    if (code === 0) {
                        try {
                            // Rename output to final name
                            const finalPath = join(downloadFolder, `${videoName}${codecSuffix}.mp4`);
                            await fs.rename(outputPath, finalPath);

                            console.log(`Successfully created hardsub video: ${finalPath}`);
                            const tmpFiles = [videoPath, subtitlePath];
                            if (thumbnailPath) tmpFiles.push(thumbnailPath);

                            resolve(JSON.stringify({
                                text: `Hardsub completed! Saved as: ${videoName}${codecSuffix}.mp4`,
                                tmpFiles: tmpFiles
                            }));
                        } catch (err) {
                            console.error("Error handling hardsub wrap up:", err);
                            resolve(JSON.stringify({ text: `Hardsub finished but failed to clean up: ${err.message}` }));
                        }
                    } else if (code !== 0 && audioCodec === 'aac_at') {
                        // Fallback to libfdk_aac
                        console.log('aac_at failed, trying with libfdk_aac...');
                        event.sender.send('download-progress', 'aac_at not available, trying with libfdk_aac...');
                        tryHardsub('libfdk_aac');
                    } else if (code !== 0 && audioCodec === 'libfdk_aac') {
                        // Fallback to built-in aac codec
                        console.log('libfdk_aac failed, trying with aac...');
                        event.sender.send('download-progress', 'libfdk_aac not available, trying with aac...');
                        tryHardsub('aac');
                    } else {
                        console.log(`Failed to create hardsub video, exit code: ${code}`);
                        try { await fs.unlink(outputPath); } catch { /* ignore */ }
                        resolve(`Failed to create hardsub video. FFmpeg exit code: ${code}`);
                    }
                });
            };

            tryHardsub('aac_at');
        });

    } catch (error) {
        console.error('Hardsub error:', error);
        return `Error during hardsub: ${error.message}`;
    }
});

ipcMain.handle('delete-temporary-files', async (_event, paths) => {
    for (const p of paths) {
        if (p) {
            try { await fs.unlink(p); }
            catch (e) { if (e.code !== 'ENOENT') console.error('Error cleaning up temp file:', p, e.message); }
        }
    }
});
