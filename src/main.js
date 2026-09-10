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

// Task management for long-running processes (yt-dlp or ffmpeg)
class TaskManager {
    constructor() {
        this.currentTask = null;
    }

    hasActiveTask() {
        return this.currentTask !== null && !this.currentTask.isDone;
    }

    startTask(type, description = '') {
        if (this.hasActiveTask()) {
            throw new Error('Another task is already running. Please await completion or cancel it.');
        }
        const task = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type,
            description,
            isCancelled: false,
            isDone: false,
            activeProcess: null
        };
        this.currentTask = task;
        return task;
    }

    spawnProcess(task, command, args, options = {}) {
        if (task.isCancelled) {
            throw new Error('Action cancelled by user.');
        }

        const child = spawn(command, args, options);
        task.activeProcess = child;

        child.on('error', (err) => {
            console.error(`Process error [${command}]:`, err);
        });

        child.on('close', () => {
            if (task.activeProcess === child) {
                task.activeProcess = null;
            }
        });

        return child;
    }

    cancelCurrentTask() {
        if (!this.hasActiveTask()) {
            return false;
        }

        const task = this.currentTask;
        task.isCancelled = true;

        if (task.activeProcess) {
            const pid = task.activeProcess.pid;
            console.log(`Cancelling task [${task.type}] with process PID: ${pid}`);

            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', pid.toString(), '/T', '/F']);
                } else {
                    task.activeProcess.kill('SIGKILL');
                }
            } catch (e) {
                console.error('Error killing process:', e);
            }
        }

        return true;
    }

    endTask(task) {
        if (task) {
            task.isDone = true;
            if (task.activeProcess) {
                try {
                    task.activeProcess.kill('SIGKILL');
                } catch { /* ignore */ }
                task.activeProcess = null;
            }
            if (this.currentTask === task) {
                this.currentTask = null;
            }
        }
    }
}

const taskManager = new TaskManager();

// Rule list for log noise reduction
const LOG_NOISE_PATTERNS = [
    /Opening 'https?:\/\//i,                                // HLS segment download spam
    /Changing ID3 metadata in HLS audio/i,                  // Twitter/X non-fatal metadata warning
    /mime type is not rfc8216 compliant/i,                  // HLS header compliance warning
    /^\s*(Input|Output) #\d+/i,                             // FFmpeg stream probe input/output header
    /^\s*Program \d+/i,                                     // FFmpeg program header
    /^\s*Stream mapping:/i,                                 // FFmpeg stream mapping header
    /^\s*Stream #\d+:\d+/i,                                 // FFmpeg stream descriptor
    /^\s*(Metadata:|variant_bitrate|encoder\s*:)/i,         // FFmpeg metadata tags
    /^\s*(TIT3|id3v2_priv|JSONMetadata|Hydra)/i,            // Twitter HLS ID3 metadata dumps
    /Press \[[q?]\] to stop/i,                              // FFmpeg interactive prompt
    /muxing overhead: unknown/i,                            // FFmpeg muxing summary header
    /^\s*Duration:\s*[\d:.]+/i                              // FFmpeg stream duration probe header
];

function shouldSuppressLogLine(line) {
    return LOG_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

function isProgressLine(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[download]') && (trimmed.includes('%') || trimmed.includes('ETA'))) {
        return true;
    }
    if ((/^(?:frame|size)=\s*\S+/i.test(trimmed) && trimmed.includes('time=')) ||
        (/^time=\S+/i.test(trimmed) && trimmed.includes('bitrate='))) {
        return true;
    }
    return false;
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
    return taskManager.cancelCurrentTask();
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
        try {
            const child = spawn('yt-dlp', args);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => stdout += d);
            child.stderr.on('data', (d) => stderr += d);
            child.on('error', (err) => {
                console.error('get-format-info process error:', err);
                resolve({ ok: false, output: '', error: err.message });
            });
            child.on('close', (code) => {
                resolve({ ok: code === 0, output: stdout.trim(), error: stderr.trim() });
            });
        } catch (err) {
            resolve({ ok: false, output: '', error: err.message });
        }
    });
});

// IPC handler for running yt-dlp commands
ipcMain.handle('run-command', async (event, args) => {
    console.log('Executing:', args);
    console.log('process.env.PATH:', process.env.PATH);

    let task;
    try {
        task = taskManager.startTask('run-command');
    } catch (err) {
        return `Error: ${err.message}`;
    }

    return new Promise((resolve) => {
        let child;
        try {
            child = taskManager.spawnProcess(task, 'yt-dlp', args);
        } catch (err) {
            taskManager.endTask(task);
            resolve(err.message);
            return;
        }

        let outputLines = [];

        const handleCleanLine = (line) => {
            const trimmed = line.trim();
            const isProgress = isProgressLine(trimmed);

            if (isProgress || trimmed.startsWith('[download]')) {
                event.sender.send('download-progress', trimmed);
            }
            if (!isProgress) {
                outputLines.push(line);
            }
        };

        const stdoutFilter = new LineStreamFilter(handleCleanLine);
        const stderrFilter = new LineStreamFilter(handleCleanLine);

        child.stdout.on('data', (data) => stdoutFilter.push(data));
        child.stderr.on('data', (data) => stderrFilter.push(data));

        child.on('close', (code) => {
            stdoutFilter.flush();
            stderrFilter.flush();

            const wasCancelled = task.isCancelled;
            taskManager.endTask(task);

            let output = outputLines.join('\n');
            if (wasCancelled) {
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

// Helper to construct FFmpeg arguments for re-encoding
function buildFfmpegReEncodeArgs({ filePath, outputPath, thumbnailPath, audioCodec }) {
    const args = ['-i', filePath];
    if (thumbnailPath) {
        args.push('-i', thumbnailPath);
        args.push('-map', '0:v:0', '-map', '0:a:0', '-map', '1:v:0');
        args.push('-c:v:0', 'libx264', '-crf:0', '22', '-preset', 'veryslow', '-c:a:0', audioCodec, '-tag:v:0', 'avc1');
        if (audioCodec === 'aac_at') {
            args.push('-aac_at_mode', 'cvbr');
        }
        args.push('-b:a:0', '128k');
        args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic');
    } else {
        args.push('-c:v', 'libx264', '-crf', '22', '-preset', 'veryslow', '-c:a', audioCodec, '-tag:v', 'avc1');
        if (audioCodec === 'aac_at') {
            args.push('-aac_at_mode', 'cvbr');
        }
        args.push('-b:a', '128k');
    }
    args.push(outputPath);
    return args;
}

// Helper to construct FFmpeg arguments for hardcoding subtitles
function buildFfmpegHardsubArgs({ videoPath, outputPath, subtitlePath, thumbnailPath, codec, audioCodec }) {
    const args = [];
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
        args.push(
            thumbnailPath ? '-c:v:0' : '-c:v', 'h264_videotoolbox',
            thumbnailPath ? '-b:v:0' : '-b:v', '4000k',
            thumbnailPath ? '-tag:v:0' : '-tag:v', 'avc1'
        );
    }

    args.push(thumbnailPath ? '-c:a:0' : '-c:a', audioCodec);
    if (audioCodec === 'aac_at') {
        args.push('-aac_at_mode', 'cvbr');
    }
    args.push(thumbnailPath ? '-b:a:0' : '-b:a', '128k');

    if (thumbnailPath) {
        args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic');
    }

    args.push(outputPath);
    return args;
}

// Reusable runner for FFmpeg transcoding with automatic audio codec fallbacks
async function runFfmpegWithCodecFallback({ task, event, buildArgs, outputPath, logPrefix }) {
    const audioCodecs = ['aac_at', 'libfdk_aac', 'aac'];
    let success = false;
    let lastCode = 0;

    for (const audioCodec of audioCodecs) {
        if (task.isCancelled) break;

        const args = buildArgs(audioCodec);
        console.log(`${logPrefix} FFmpeg args:`, args);

        const exitCode = await new Promise((resolve) => {
            let child;
            try {
                child = taskManager.spawnProcess(task, 'ffmpeg', args);
            } catch {
                resolve(-1);
                return;
            }

            const handleProgress = (data) => {
                if (task.isCancelled) return;
                const str = data.toString();
                if (str.includes('time=') || str.includes('frame=')) {
                    event.sender.send('download-progress', `${logPrefix} (${audioCodec}): ${str.trim()}`);
                }
            };

            child.stdout.on('data', handleProgress);
            child.stderr.on('data', handleProgress);

            child.on('close', (code) => {
                resolve(code);
            });
        });

        if (task.isCancelled) {
            break;
        }

        if (exitCode === 0) {
            success = true;
            break;
        } else {
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            console.log(`${logPrefix} with ${audioCodec} failed with code ${exitCode}`);
            if (audioCodec === 'aac_at') {
                event.sender.send('download-progress', 'aac_at not available, trying with libfdk_aac...');
            } else if (audioCodec === 'libfdk_aac') {
                event.sender.send('download-progress', 'libfdk_aac not available, trying with aac...');
            }
            lastCode = exitCode;
        }
    }

    return { success, lastCode, isCancelled: task.isCancelled };
}

// Find video and thumbnail files for re-encoding
async function findVideoToReEncode(downloadFolder, videoId) {
    const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];
    const allFiles = await fs.readdir(downloadFolder);
    const files = allFiles.filter((file) => {
        const lower = file.toLowerCase();
        return videoExtensions.some((ext) => lower.endsWith(ext)) && file.includes(videoId);
    });

    if (files.length === 0) return null;

    const file = files[0];
    const filePath = join(downloadFolder, file);
    const fileExt = extname(file);
    const filename = basename(file, fileExt);

    let thumbnailFile = null;
    for (const f of allFiles) {
        if (f.endsWith('.jpg') && f.includes(filename.substring(0, 20))) {
            thumbnailFile = f;
            break;
        }
    }
    const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;

    return { file, filePath, filename, thumbnailPath };
}

// Find media, subtitles, and thumbnail for hardsubbing
async function findHardsubSourceFiles(downloadFolder, subtitleLang) {
    const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];
    const allFiles = await fs.readdir(downloadFolder);

    const filesWithStats = await Promise.all(
        allFiles.map(async (file) => {
            const filePath = join(downloadFolder, file);
            const stat = await fs.stat(filePath);
            return { file, mtime: stat.mtime };
        })
    );
    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    let videoFile = null;
    for (const { file } of filesWithStats) {
        const lower = file.toLowerCase();
        if (videoExtensions.some((ext) => lower.endsWith(ext)) && !file.includes('_hardsub')) {
            videoFile = file;
            break;
        }
    }
    if (!videoFile) return null;

    const videoBasename = basename(videoFile, extname(videoFile));
    let subtitleFile = null;
    for (const { file } of filesWithStats) {
        if (file.endsWith('.vtt') && file.includes(videoBasename.substring(0, 20))) {
            subtitleFile = file;
            break;
        }
    }
    if (!subtitleFile) {
        for (const { file } of filesWithStats) {
            if (file.endsWith('.vtt') && file.includes(subtitleLang)) {
                subtitleFile = file;
                break;
            }
        }
    }
    if (!subtitleFile) return null;

    let thumbnailFile = null;
    for (const { file } of filesWithStats) {
        if (file.endsWith('.jpg') && file.includes(videoBasename.substring(0, 20))) {
            thumbnailFile = f;
            break;
        }
    }

    const videoPath = join(downloadFolder, videoFile);
    const subtitlePath = join(downloadFolder, subtitleFile);
    const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;
    const videoExt = extname(videoFile);
    const videoName = basename(videoFile, videoExt);

    return { videoFile, videoPath, subtitlePath, thumbnailPath, videoName };
}

// IPC handler for re-encoding videos to MP4 with H.264 and AAC
ipcMain.handle('re-encode-to-mp4', async (event, downloadFolder, videoId) => {
    console.log("Re-encoding video in folder:", downloadFolder, "for video ID:", videoId);

    let task;
    try {
        task = taskManager.startTask('re-encode');
    } catch (err) {
        return `Error: ${err.message}`;
    }

    try {
        const media = await findVideoToReEncode(downloadFolder, videoId);
        if (!media) {
            return "No matching video file found to re-encode.";
        }

        const { file, filePath, filename, thumbnailPath } = media;
        const outputPath = join(downloadFolder, `${filename}_reencoded.mp4`);

        console.log(`Re-encoding file: ${file}`);
        event.sender.send('download-progress', `Re-encoding ${file}...`);

        const result = await runFfmpegWithCodecFallback({
            task,
            event,
            buildArgs: (audioCodec) => buildFfmpegReEncodeArgs({ filePath, outputPath, thumbnailPath, audioCodec }),
            outputPath,
            logPrefix: `Re-encoding ${file}`
        });

        if (result.isCancelled) {
            console.log("Re-encoding was cancelled. Cleaning up temporary output only...");
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            return "Re-encoding cancelled by user. Files cleaned up.";
        }

        if (result.success) {
            const finalPath = join(downloadFolder, `${filename}.mp4`);
            await fs.rename(outputPath, finalPath);
            console.log(`Successfully re-encoded: ${file} to ${finalPath}`);

            const tmpFiles = [];
            if (filePath !== finalPath) tmpFiles.push(filePath);
            if (thumbnailPath && thumbnailPath !== finalPath) tmpFiles.push(thumbnailPath);

            return JSON.stringify({
                text: `Re-encoding completed successfully. Saved as: ${filename}.mp4`,
                tmpFiles
            });
        } else {
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            return `Failed to re-encode ${file} with exit code ${result.lastCode}`;
        }
    } catch (error) {
        return `Error during re-encoding: ${error.message}`;
    } finally {
        taskManager.endTask(task);
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
        try {
            let args = ['-j', '--skip-download'];
            if (proxy) args.push('--proxy', proxy);
            if (browser) args.push('--cookies-from-browser', browser);
            args.push(url);

            const child = spawn('yt-dlp', args);
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => stdout += data);
            child.stderr.on('data', (data) => stderr += data);
            child.on('error', (err) => {
                console.error('list-subtitles process error:', err);
                resolve({ error: true, message: err.message, subtitles: [], isAutoGenerated: false });
            });

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
        } catch (err) {
            resolve({ error: true, message: err.message, subtitles: [], isAutoGenerated: false });
        }
    });
});

// IPC handler for downloading video with hardcoded subtitles
ipcMain.handle('download-with-hardsub', async (event, options) => {
    const { url, browser, downloadFolder, subtitleLang, subtitleType, codec, proxy } = options;
    console.log('Download with hardsub:', { url, subtitleLang, subtitleType, codec, downloadFolder });

    let task;
    try {
        task = taskManager.startTask('hardsub');
    } catch (err) {
        return `Error: ${err.message}`;
    }

    try {
        // Step 1: Download video with subtitle (limit to avc1/H.264)
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

        const downloadCode = await new Promise((resolve) => {
            let child;
            try {
                child = taskManager.spawnProcess(task, 'yt-dlp', args);
            } catch {
                resolve(-1);
                return;
            }

            const handleProgressLine = (line) => {
                const trimmed = line.trim();
                if (isProgressLine(trimmed) || trimmed.startsWith('[download]')) {
                    event.sender.send('download-progress', trimmed);
                }
            };

            const stdoutFilter = new LineStreamFilter(handleProgressLine);
            const stderrFilter = new LineStreamFilter(handleProgressLine);

            child.stdout.on('data', (data) => stdoutFilter.push(data));
            child.stderr.on('data', (data) => stderrFilter.push(data));

            child.on('close', (code) => {
                stdoutFilter.flush();
                stderrFilter.flush();
                resolve(code);
            });
        });

        if (task.isCancelled) {
            return 'Hardsub cancelled by user.';
        }
        if (downloadCode !== 0) {
            return `Download failed with code ${downloadCode}`;
        }

        // Step 2: Find downloaded files
        if (task.isCancelled) {
            return 'Hardsub cancelled by user.';
        }

        const media = await findHardsubSourceFiles(downloadFolder, subtitleLang);
        if (!media) {
            return 'Error: Video or subtitle file not found after download.';
        }

        const { videoFile, videoPath, subtitlePath, thumbnailPath, videoName } = media;
        const codecSuffix = codec === 'hevc' ? '_HEVC' : '_H264';
        const outputPath = join(downloadFolder, `${videoName}${codecSuffix}_temp.mp4`);

        console.log('Video file:', videoPath);
        console.log('Subtitle file:', subtitlePath);
        console.log('Output path:', outputPath);

        if (task.isCancelled) {
            return 'Hardsub cancelled by user.';
        }

        // Step 3: Run ffmpeg with hardsub
        event.sender.send('download-progress', `Hardcoding subtitles using ${codec.toUpperCase()}...`);

        const result = await runFfmpegWithCodecFallback({
            task,
            event,
            buildArgs: (audioCodec) => buildFfmpegHardsubArgs({ videoPath, outputPath, subtitlePath, thumbnailPath, codec, audioCodec }),
            outputPath,
            logPrefix: 'Hardcoding'
        });

        if (result.isCancelled) {
            console.log("Hardsub was cancelled. Cleaning up temporary output only...");
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            return "Hardsub cancelled by user.";
        }

        if (result.success) {
            const finalPath = join(downloadFolder, `${videoName}${codecSuffix}.mp4`);
            await fs.rename(outputPath, finalPath);

            console.log(`Successfully created hardsub video: ${finalPath}`);
            const tmpFiles = [];
            if (videoPath !== finalPath) tmpFiles.push(videoPath);
            if (subtitlePath && subtitlePath !== finalPath) tmpFiles.push(subtitlePath);
            if (thumbnailPath && thumbnailPath !== finalPath) tmpFiles.push(thumbnailPath);

            return JSON.stringify({
                text: `Hardsub completed! Saved as: ${videoName}${codecSuffix}.mp4`,
                tmpFiles: tmpFiles
            });
        } else {
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            return `Failed to create hardsub video. FFmpeg exit code: ${result.lastCode}`;
        }
    } catch (error) {
        console.error('Hardsub error:', error);
        return `Error during hardsub: ${error.message}`;
    } finally {
        taskManager.endTask(task);
    }
});

ipcMain.handle('delete-temporary-files', async (_event, paths) => {
    if (!Array.isArray(paths)) return;
    for (const p of paths) {
        if (typeof p === 'string' && p.trim()) {
            try {
                await fs.unlink(p);
            } catch (e) {
                if (e.code !== 'ENOENT') console.error('Error cleaning up temp file:', p, e.message);
            }
        }
    }
});
