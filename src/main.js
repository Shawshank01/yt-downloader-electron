import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename, delimiter } from 'path';
import { promises as fs } from 'fs';
import { checkAppUpdate, getCurrentVersion, isAutoUpdaterSupported } from './update.js';
import { checkSystemDependencies, installMissingDependencies, checkFfmpegSubtitlesSupport } from './dependencies.js';

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
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function writeSettings(settings) {
    try {
        const filePath = await getSettingsPath();
        await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

ipcMain.handle('get-settings', async () => {
    return await readSettings();
});

ipcMain.handle('set-settings', async (_event, updates) => {
    const current = await readSettings();
    const merged = { ...current, ...updates };
    await writeSettings(merged);
    return merged;
});

// Fix PATH so yt-dlp and ffmpeg (including keg-only ffmpeg-full) are found
const extraPaths = process.platform === 'win32'
    ? []
    : [
        '/opt/homebrew/opt/ffmpeg-full/bin',
        '/usr/local/opt/ffmpeg-full/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
    ];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(delimiter), ...extraPaths])]
    .filter(Boolean)
    .join(delimiter);

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
    /^\s*Duration:\s*[\d:.]+/i,                             // FFmpeg stream duration probe header
    /^Extract(?:ing|ed)\s+(?:\d+\s+)?cookies from/i,        // Browser cookie extraction status
    /\[jsc:[^\]]+\]\s+Solving JS challenges/i,              // yt-dlp JS challenge solver status
    /^\[SubtitlesConvertor\]/i                              // yt-dlp internal subtitle convertor messages
];

function shouldSuppressLogLine(line) {
    return LOG_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

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

// Helper to attach stdout and stderr line-stream filters to a child process
function attachLineStreamFilters(child, onLine) {
    const stdoutFilter = new LineStreamFilter(onLine);
    const stderrFilter = new LineStreamFilter(onLine);

    child.stdout.on('data', (data) => stdoutFilter.push(data));
    child.stderr.on('data', (data) => stderrFilter.push(data));

    return () => {
        stdoutFilter.flush();
        stderrFilter.flush();
    };
}

// Unified IPC handler for cancelling the current action
ipcMain.handle('cancel-command', async () => {
    return taskManager.cancelCurrentTask();
});

ipcMain.handle('check-dependencies', async () => {
    return checkSystemDependencies();
});

ipcMain.handle('install-missing-dependencies', async (_event, options = {}) => {
    return installMissingDependencies(options);
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
        return {
            success: false,
            cancelled: false,
            code: -1,
            output: '',
            error: err.message
        };
    }

    return new Promise((resolve) => {
        let child;
        try {
            child = taskManager.spawnProcess(task, 'yt-dlp', args);
        } catch (err) {
            taskManager.endTask(task);
            resolve({
                success: false,
                cancelled: false,
                code: -1,
                output: '',
                error: err.message
            });
            return;
        }

        let outputLines = [];
        let lastProgressLine = null;

        const handleCleanLine = (line) => {
            const trimmed = line.trim();
            const isProgress = isProgressLine(trimmed);

            if (isProgress || trimmed.startsWith('[download]')) {
                event.sender.send('download-progress', trimmed);
            }
            if (isProgress) {
                lastProgressLine = line;
            } else {
                if (lastProgressLine) {
                    outputLines.push(lastProgressLine);
                    lastProgressLine = null;
                }
                outputLines.push(line);
            }
        };

        const flushFilters = attachLineStreamFilters(child, handleCleanLine);

        child.on('close', (code) => {
            flushFilters();

            if (lastProgressLine) {
                outputLines.push(lastProgressLine);
            }

            const wasCancelled = task.isCancelled;
            taskManager.endTask(task);

            const output = outputLines.join('\n').trim();
            if (wasCancelled) {
                resolve({
                    success: false,
                    cancelled: true,
                    code: code ?? -1,
                    output: 'Action cancelled by user.',
                    error: 'Action cancelled by user.'
                });
            } else if (code !== 0) {
                resolve({
                    success: false,
                    cancelled: false,
                    code,
                    output,
                    error: `Process exited with code ${code}`
                });
            } else {
                resolve({
                    success: true,
                    cancelled: false,
                    code: 0,
                    output,
                    error: ''
                });
            }
        });
    });
});

// Platform-adaptive default subtitle font (single font family name without commas for ASS style)
const DEFAULT_SUBTITLE_FONT = process.platform === 'darwin'
    ? 'PingFang SC'
    : process.platform === 'win32'
        ? 'Microsoft YaHei'
        : 'DejaVu Sans';

// Centralised transcoding and encoding configuration parameters
const TRANSCODE_CONFIG = {
    crf: '22',
    preset: 'veryslow',
    audioBitrate: '128k',
    h264Bitrate: '4000k',
    hevcBitrate: '2500k',
    pixelFormatHevc: 'p010le',
    tagH264: 'avc1',
    tagHevc: 'hvc1',
    audioCodecs: process.platform === 'darwin'
        ? ['aac_at', 'libfdk_aac', 'aac']
        : ['libfdk_aac', 'aac']
};

// Helper to construct FFmpeg arguments for re-encoding
function buildFfmpegReEncodeArgs({ filePath, outputPath, thumbnailPath, audioCodec }) {
    const args = ['-i', filePath];
    if (thumbnailPath) {
        args.push('-i', thumbnailPath);
        args.push('-map', '0:v:0', '-map', '0:a:0', '-map', '1:v:0');
        args.push(
            '-c:v:0', 'libx264',
            '-crf:0', TRANSCODE_CONFIG.crf,
            '-preset', TRANSCODE_CONFIG.preset,
            '-c:a:0', audioCodec,
            '-tag:v:0', TRANSCODE_CONFIG.tagH264
        );
        if (audioCodec === 'aac_at') {
            args.push('-aac_at_mode', 'cvbr');
        }
        args.push('-b:a:0', TRANSCODE_CONFIG.audioBitrate);
        args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic');
    } else {
        args.push(
            '-c:v', 'libx264',
            '-crf', TRANSCODE_CONFIG.crf,
            '-preset', TRANSCODE_CONFIG.preset,
            '-c:a', audioCodec,
            '-tag:v', TRANSCODE_CONFIG.tagH264
        );
        if (audioCodec === 'aac_at') {
            args.push('-aac_at_mode', 'cvbr');
        }
        args.push('-b:a', TRANSCODE_CONFIG.audioBitrate);
    }
    args.push(outputPath);
    return args;
}

// Helper to construct FFmpeg arguments for hardcoding subtitles
function buildFfmpegHardsubArgs({ videoPath, outputPath, subtitlePath, thumbnailPath, codec, audioCodec }) {
    const args = [];
    const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');

    if (process.platform === 'darwin') {
        args.push('-hwaccel', 'videotoolbox');
    }
    args.push('-i', videoPath);

    const subFilter = `subtitles='${escapedSubPath}':force_style='FontName=${DEFAULT_SUBTITLE_FONT}'`;
    if (thumbnailPath) {
        args.push('-i', thumbnailPath);
        args.push('-map', '0:v:0', '-map', '0:a:0', '-map', '1:v:0');
        args.push('-filter:v:0', subFilter);
    } else {
        args.push('-vf', subFilter);
    }

    if (codec === 'hevc') {
        const vcodec = process.platform === 'darwin' ? 'hevc_videotoolbox' : 'libx265';
        args.push(
            thumbnailPath ? '-c:v:0' : '-c:v', vcodec,
            '-pix_fmt', TRANSCODE_CONFIG.pixelFormatHevc,
            thumbnailPath ? '-b:v:0' : '-b:v', TRANSCODE_CONFIG.hevcBitrate,
            thumbnailPath ? '-tag:v:0' : '-tag:v', TRANSCODE_CONFIG.tagHevc
        );
    } else {
        const vcodec = process.platform === 'darwin' ? 'h264_videotoolbox' : 'libx264';
        args.push(
            thumbnailPath ? '-c:v:0' : '-c:v', vcodec,
            thumbnailPath ? '-b:v:0' : '-b:v', TRANSCODE_CONFIG.h264Bitrate,
            thumbnailPath ? '-tag:v:0' : '-tag:v', TRANSCODE_CONFIG.tagH264
        );
    }

    args.push(thumbnailPath ? '-c:a:0' : '-c:a', audioCodec);
    if (audioCodec === 'aac_at') {
        args.push('-aac_at_mode', 'cvbr');
    }
    args.push(thumbnailPath ? '-b:a:0' : '-b:a', TRANSCODE_CONFIG.audioBitrate);

    if (thumbnailPath) {
        args.push('-c:v:1', 'copy', '-disposition:v:1', 'attached_pic');
    }

    args.push(outputPath);
    return args;
}

// Reusable runner for FFmpeg transcoding with automatic audio codec fallbacks
async function runFfmpegWithCodecFallback({ task, event, buildArgs, outputPath, logPrefix }) {
    const audioCodecs = TRANSCODE_CONFIG.audioCodecs;
    let success = false;
    let lastCode = 0;
    let lastError = '';

    for (const audioCodec of audioCodecs) {
        if (task.isCancelled) break;

        const args = buildArgs(audioCodec);
        console.log(`${logPrefix} FFmpeg args:`, args);

        const stderrLines = [];
        const exitCode = await new Promise((resolve) => {
            let child;
            try {
                child = taskManager.spawnProcess(task, 'ffmpeg', args);
            } catch {
                resolve(-1);
                return;
            }

            const handleData = (data) => {
                if (task.isCancelled) return;
                const str = data.toString();
                if (str.includes('time=') || str.includes('frame=')) {
                    event.sender.send('download-progress', `${logPrefix} (${audioCodec}): ${str.trim()}`);
                } else {
                    const lines = str.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                    stderrLines.push(...lines);
                    if (stderrLines.length > 50) {
                        stderrLines.splice(0, stderrLines.length - 50);
                    }
                }
            };

            child.stdout.on('data', handleData);
            child.stderr.on('data', handleData);

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
            const errorSnippet = stderrLines.slice(-15).join('\n');
            console.error(`${logPrefix} with ${audioCodec} failed with code ${exitCode}:\n${errorSnippet}`);
            lastCode = exitCode;
            lastError = errorSnippet;

            // If the failure is due to filtergraph/subtitles, retrying other audio codecs will not help
            if (
                errorSnippet.includes('No option name near') ||
                errorSnippet.includes('Error parsing filterchain') ||
                errorSnippet.includes('subtitles')
            ) {
                break;
            }

            if (audioCodec === 'aac_at') {
                event.sender.send('download-progress', 'aac_at not available, trying with libfdk_aac...');
            } else if (audioCodec === 'libfdk_aac') {
                event.sender.send('download-progress', 'libfdk_aac not available, trying with aac...');
            }
        }
    }

    return { success, lastCode, lastError, isCancelled: task.isCancelled };
}

// Supported video file extensions for transcoding and discovery
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];

// Supported image extensions for video thumbnails
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.webp', '.png'];

// Find matching thumbnail file using exact basename match or basename prefix
function findMatchingThumbnail(files, baseName) {
    const fileNames = files.map((f) => (typeof f === 'string' ? f : f.file));

    // Priority 1: Exact basename match (e.g., "title.jpg", "title.webp")
    for (const ext of IMAGE_EXTENSIONS) {
        const exact = `${baseName}${ext}`;
        if (fileNames.includes(exact)) {
            return exact;
        }
    }

    // Priority 2: File begins with baseName and has an image extension
    const basePrefix = `${baseName}.`;
    for (const name of fileNames) {
        const lower = name.toLowerCase();
        if ((name.startsWith(basePrefix) || name.startsWith(baseName)) &&
            IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
            return name;
        }
    }

    return null;
}

// Find video and thumbnail files for re-encoding
async function findVideoToReEncode(downloadFolder, targetIdentifier) {
    const allFiles = await fs.readdir(downloadFolder);

    // Case 1: targetIdentifier matches a specific existing file in downloadFolder
    const directMatch = allFiles.find((f) => f === targetIdentifier || join(downloadFolder, f) === targetIdentifier);
    if (directMatch) {
        const filePath = join(downloadFolder, directMatch);
        const fileExt = extname(directMatch);
        const filename = basename(directMatch, fileExt);
        const thumbnailFile = findMatchingThumbnail(allFiles, filename);
        const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;
        return { file: directMatch, filePath, filename, thumbnailPath };
    }

    // Case 2: Match by video ID or name fragment
    const candidates = allFiles.filter((file) => {
        const lower = file.toLowerCase();
        return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext)) &&
            (!targetIdentifier || file.includes(targetIdentifier));
    });

    if (candidates.length === 0) return null;

    // If multiple candidates exist, sort only candidate files by mtime descending to get the most recent
    let chosenFile = candidates[0];
    if (candidates.length > 1) {
        const candidatesWithStats = await Promise.all(
            candidates.map(async (file) => {
                const stat = await fs.stat(join(downloadFolder, file));
                return { file, mtime: stat.mtimeMs };
            })
        );
        candidatesWithStats.sort((a, b) => b.mtime - a.mtime);
        chosenFile = candidatesWithStats[0].file;
    }

    const filePath = join(downloadFolder, chosenFile);
    const fileExt = extname(chosenFile);
    const filename = basename(chosenFile, fileExt);
    const thumbnailFile = findMatchingThumbnail(allFiles, filename);
    const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;

    return { file: chosenFile, filePath, filename, thumbnailPath };
}

// Find media, subtitles, and thumbnail for hardsubbing
async function findHardsubSourceFiles(downloadFolder, subtitleLang, downloadedFilePath = null) {
    const allFiles = await fs.readdir(downloadFolder);

    let videoFile = null;
    if (downloadedFilePath) {
        const candidate = basename(downloadedFilePath);
        if (allFiles.includes(candidate)) {
            videoFile = candidate;
        }
    }

    // Fallback: search candidate video files in downloadFolder, statting only candidates
    if (!videoFile) {
        const candidates = allFiles.filter((file) => {
            const lower = file.toLowerCase();
            return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext)) && !file.includes('_hardsub');
        });

        if (candidates.length === 0) return null;

        if (candidates.length === 1) {
            videoFile = candidates[0];
        } else {
            const candidatesWithStats = await Promise.all(
                candidates.map(async (file) => {
                    const stat = await fs.stat(join(downloadFolder, file));
                    return { file, mtime: stat.mtimeMs };
                })
            );
            candidatesWithStats.sort((a, b) => b.mtime - a.mtime);
            videoFile = candidatesWithStats[0].file;
        }
    }

    const videoExt = extname(videoFile);
    const videoName = basename(videoFile, videoExt);

    // Locate matching subtitle file deterministically:
    // 1. Exact: ${videoName}.${subtitleLang}.vtt
    // 2. Subtitle starting with ${videoName} and containing subtitleLang
    // 3. Base: ${videoName}.vtt
    // 4. Any vtt starting with ${videoName}
    let subtitleFile = null;
    const exactSub = `${videoName}.${subtitleLang}.vtt`;
    if (allFiles.includes(exactSub)) {
        subtitleFile = exactSub;
    } else {
        const videoSubCandidates = allFiles.filter((f) => f.startsWith(videoName) && f.endsWith('.vtt'));
        if (videoSubCandidates.length > 0) {
            const langMatch = videoSubCandidates.find((f) => f.includes(subtitleLang));
            subtitleFile = langMatch || videoSubCandidates[0];
        }
    }

    if (!subtitleFile) return null;

    const thumbnailFile = findMatchingThumbnail(allFiles, videoName);

    const videoPath = join(downloadFolder, videoFile);
    const subtitlePath = join(downloadFolder, subtitleFile);
    const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;

    return { videoFile, videoPath, subtitlePath, thumbnailPath, videoName };
}

// IPC handler for re-encoding videos to MP4 with H.264 and AAC
ipcMain.handle('re-encode-to-mp4', async (event, downloadFolder, videoId) => {
    console.log("Re-encoding video in folder:", downloadFolder, "for video ID:", videoId);

    let task;
    try {
        task = taskManager.startTask('re-encode');
    } catch (err) {
        return {
            success: false,
            cancelled: false,
            message: `Error: ${err.message}`,
            error: err.message,
            tmpFiles: []
        };
    }

    try {
        const media = await findVideoToReEncode(downloadFolder, videoId);
        if (!media) {
            return {
                success: false,
                cancelled: false,
                message: 'No matching video file found to re-encode.',
                error: 'No matching video file found to re-encode.',
                tmpFiles: []
            };
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
            return {
                success: false,
                cancelled: true,
                message: 'Re-encoding cancelled by user. Files cleaned up.',
                error: 'Action cancelled by user.',
                tmpFiles: []
            };
        }

        if (result.success) {
            const finalPath = join(downloadFolder, `${filename}.mp4`);
            await fs.rename(outputPath, finalPath);
            console.log(`Successfully re-encoded: ${file} to ${finalPath}`);

            const tmpFiles = [];
            if (filePath !== finalPath) tmpFiles.push(filePath);
            if (thumbnailPath && thumbnailPath !== finalPath) tmpFiles.push(thumbnailPath);

            return {
                success: true,
                cancelled: false,
                message: `Re-encoding completed successfully. Saved as: ${filename}.mp4`,
                tmpFiles
            };
        } else {
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            return {
                success: false,
                cancelled: false,
                message: `Failed to re-encode ${file} with exit code ${result.lastCode}`,
                error: `Process exited with code ${result.lastCode}`,
                tmpFiles: []
            };
        }
    } catch (error) {
        return {
            success: false,
            cancelled: false,
            message: `Error during re-encoding: ${error.message}`,
            error: error.message,
            tmpFiles: []
        };
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
                resolve({ success: false, error: true, message: err.message, subtitles: [], isAutoGenerated: false });
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    console.error('Error getting video info:', stderr);
                    resolve({ success: false, error: true, message: stderr || 'Unknown error', subtitles: [], isAutoGenerated: false });
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

                    resolve({ success: true, error: false, message: '', subtitles: subtitlesToReturn, isAutoGenerated });
                } catch (parseError) {
                    console.error('Error parsing video info:', parseError);
                    resolve({ success: false, error: true, message: 'Failed to parse video information', subtitles: [], isAutoGenerated: false });
                }
            });
        } catch (err) {
            resolve({ success: false, error: true, message: err.message, subtitles: [], isAutoGenerated: false });
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
        return {
            success: false,
            cancelled: false,
            message: `Error: ${err.message}`,
            error: err.message,
            tmpFiles: []
        };
    }

    const hasSubtitles = await checkFfmpegSubtitlesSupport();
    if (!hasSubtitles) {
        taskManager.endTask(task);
        return {
            success: false,
            cancelled: false,
            message: 'Hardsubbing requires FFmpeg with libass support (missing "subtitles" filter).\n\n👉 On macOS, please install ffmpeg-full via Homebrew:\n   brew install ffmpeg-full',
            error: 'FFmpeg lacks libass / subtitles filter support.',
            tmpFiles: []
        };
    }

    try {
        // Step 1: Download video with subtitle (limit to avc1/H.264)
        const manifestFile = join(app.getPath('temp'), `ytdl-sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
        const subsFlag = subtitleType === 'manual' ? '--write-subs' : '--write-auto-subs';
        let args = [
            '-f', 'bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]',
            subsFlag, '--sub-langs', subtitleLang,
            '--convert-subs', 'vtt',
            '--write-thumbnail', '--convert-thumbnails', 'jpg',
            '--print-to-file', 'after_move:filepath', manifestFile,
            '-P', downloadFolder
        ];
        if (proxy) args.push('--proxy', proxy);
        if (browser) args.push('--cookies-from-browser', browser);
        args.push(url);

        event.sender.send('download-progress', 'Downloading video and subtitles...');
        console.log('Download command:', args);

        let capturedDownloadPath = null;
        const downloadCode = await new Promise((resolve) => {
            let child;
            try {
                child = taskManager.spawnProcess(task, 'yt-dlp', args);
            } catch {
                resolve(-1);
                return;
            }

            const flushFilters = attachLineStreamFilters(child, (line) => {
                const trimmed = line.trim();
                if (isProgressLine(trimmed) || trimmed.startsWith('[download]')) {
                    event.sender.send('download-progress', trimmed);
                }
                const mergeMatch = trimmed.match(/^\[Merger\] Merging formats into ["']?(.+?)["']?$/i);
                if (mergeMatch) capturedDownloadPath = mergeMatch[1];
                const destMatch = trimmed.match(/^\[download\] Destination:\s+["']?(.+?)["']?$/i);
                if (destMatch && !capturedDownloadPath) capturedDownloadPath = destMatch[1];
            });

            child.on('close', (code) => {
                flushFilters();
                resolve(code);
            });
        });

        // Determine downloaded file path from manifest or stdout capture
        let downloadedFilePath = capturedDownloadPath;
        try {
            const manifestContent = await fs.readFile(manifestFile, 'utf8');
            const lines = manifestContent.trim().split(/[\r\n]+/);
            if (lines[0] && lines[0].trim()) {
                downloadedFilePath = lines[0].trim();
            }
        } catch { /* ignore if manifest not written */ }

        try { await fs.unlink(manifestFile); } catch { /* ignore */ }

        if (task.isCancelled) {
            return {
                success: false,
                cancelled: true,
                message: 'Hardsub cancelled by user.',
                error: 'Action cancelled by user.',
                tmpFiles: []
            };
        }
        if (downloadCode !== 0) {
            return {
                success: false,
                cancelled: false,
                message: `Download failed with code ${downloadCode}`,
                error: `Download failed with code ${downloadCode}`,
                tmpFiles: []
            };
        }

        // Step 2: Find downloaded files
        if (task.isCancelled) {
            return {
                success: false,
                cancelled: true,
                message: 'Hardsub cancelled by user.',
                error: 'Action cancelled by user.',
                tmpFiles: []
            };
        }

        const media = await findHardsubSourceFiles(downloadFolder, subtitleLang, downloadedFilePath);
        if (!media) {
            return {
                success: false,
                cancelled: false,
                message: 'Error: Video or subtitle file not found after download.',
                error: 'Video or subtitle file not found after download.',
                tmpFiles: []
            };
        }

        const { videoPath, subtitlePath, thumbnailPath, videoName } = media;
        const codecSuffix = codec === 'hevc' ? '_HEVC' : '_H264';
        const outputPath = join(downloadFolder, `${videoName}${codecSuffix}_temp.mp4`);

        console.log('Video file:', videoPath);
        console.log('Subtitle file:', subtitlePath);
        console.log('Output path:', outputPath);

        if (task.isCancelled) {
            return {
                success: false,
                cancelled: true,
                message: 'Hardsub cancelled by user.',
                error: 'Action cancelled by user.',
                tmpFiles: []
            };
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
            return {
                success: false,
                cancelled: true,
                message: 'Hardsub cancelled by user.',
                error: 'Action cancelled by user.',
                tmpFiles: []
            };
        }

        if (result.success) {
            const finalPath = join(downloadFolder, `${videoName}${codecSuffix}.mp4`);
            await fs.rename(outputPath, finalPath);

            console.log(`Successfully created hardsub video: ${finalPath}`);
            const tmpFiles = [];
            if (videoPath !== finalPath) tmpFiles.push(videoPath);
            if (subtitlePath && subtitlePath !== finalPath) tmpFiles.push(subtitlePath);
            if (thumbnailPath && thumbnailPath !== finalPath) tmpFiles.push(thumbnailPath);

            return {
                success: true,
                cancelled: false,
                message: `Hardsub completed! Saved as: ${videoName}${codecSuffix}.mp4`,
                tmpFiles
            };
        } else {
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            const errorDetail = result.lastError || `FFmpeg exit code ${result.lastCode}`;
            return {
                success: false,
                cancelled: false,
                message: `Failed to create hardsub video. ${errorDetail}`,
                error: errorDetail,
                tmpFiles: []
            };
        }
    } catch (error) {
        console.error('Hardsub error:', error);
        return {
            success: false,
            cancelled: false,
            message: `Error during hardsub: ${error.message}`,
            error: error.message,
            tmpFiles: []
        };
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
