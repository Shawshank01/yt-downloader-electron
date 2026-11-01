// Electron-free operations built on yt-dlp and ffmpeg.
//
// Every function here is a plain async function that takes an `onProgress(string)` callback
// instead of an Electron IPC event. This lets the classic UI (via IPC handlers in main.js)
// and any future caller (e.g. an LLM agent) share exactly the same implementation.
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { checkFfmpegSubtitlesSupport, findExecutable } from '../dependencies.js';
import { taskManager } from './task-manager.js';
import { logger } from './logger.js';
import { attachLineStreamFilters, isProgressLine } from './log-filter.js';
import { findVideoToReEncode, findHardsubSourceFiles } from './media-files.js';
import {
    buildFfmpegReEncodeArgs,
    buildFfmpegHardsubArgs,
    runFfmpegWithCodecFallback
} from './ffmpeg.js';

const noop = () => { };

/** Cancel whichever task is currently running (yt-dlp or ffmpeg). */
export function cancelCurrentTask() {
    return taskManager.cancelCurrentTask();
}

/**
 * Run yt-dlp with the given argument array and stream progress lines.
 * @returns {Promise<{success: boolean, cancelled: boolean, code: number, output: string, error: string}>}
 */
export async function runYtDlp(args, onProgress = noop) {
    const finalArgs = args.includes('--remote-components')
        ? args
        : ['--remote-components', 'ejs:github', ...args];
    logger.info('Executing:', finalArgs);

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
            child = taskManager.spawnProcess(task, 'yt-dlp', finalArgs);
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
                onProgress(trimmed);
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
}

/**
 * Run a short, non-task yt-dlp query (e.g. to fetch metadata for a format code).
 * @returns {Promise<{ok: boolean, output: string, error: string}>}
 */
export function getFormatInfo(args) {
    return findExecutable('yt-dlp').then((executable) => new Promise((resolve) => {
        if (!executable) {
            resolve({ ok: false, output: '', error: 'yt-dlp is not installed.' });
            return;
        }
        try {
            const child = spawn(executable, args);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => stdout += d);
            child.stderr.on('data', (d) => stderr += d);
            child.on('error', (err) => {
                logger.error('get-format-info process error:', err);
                resolve({ ok: false, output: '', error: err.message });
            });
            child.on('close', (code) => {
                resolve({ ok: code === 0, output: stdout.trim(), error: stderr.trim() });
            });
        } catch (err) {
            resolve({ ok: false, output: '', error: err.message });
        }
    }));
}

/** Extract manual / original-language auto subtitles from a yt-dlp info JSON object. */
function extractSubtitleChoices(info) {
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
    if (manualSubtitles.length > 0) {
        logger.info('Found manual subtitles:', manualSubtitles);
        return { subtitles: manualSubtitles, isAutoGenerated: false };
    }
    if (autoGenerated.length > 0) {
        logger.info('No manual subtitles, showing auto-generated:', autoGenerated);
        return { subtitles: autoGenerated, isAutoGenerated: true };
    }
    logger.info('No subtitles available');
    return { subtitles: [], isAutoGenerated: false };
}

/**
 * List the subtitle languages available for a video.
 * @returns {Promise<{success: boolean, error: boolean, message: string, subtitles: Array, isAutoGenerated: boolean}>}
 */
export function listSubtitles(url, browser, proxy) {
    logger.info('Listing subtitles for:', url);

    const failure = (message) => ({ success: false, error: true, message, subtitles: [], isAutoGenerated: false });

    return findExecutable('yt-dlp').then((executable) => new Promise((resolve) => {
        if (!executable) {
            resolve(failure('yt-dlp is not installed.'));
            return;
        }
        try {
            let args = ['-j', '--skip-download', '--remote-components', 'ejs:github'];
            if (proxy) args.push('--proxy', proxy);
            if (browser) args.push('--cookies-from-browser', browser);
            args.push(url);

            const child = spawn(executable, args);
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => stdout += data);
            child.stderr.on('data', (data) => stderr += data);
            child.on('error', (err) => {
                logger.error('list-subtitles process error:', err);
                resolve(failure(err.message));
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    logger.error('Error getting video info:', stderr);
                    resolve(failure(stderr || 'Unknown error'));
                    return;
                }

                try {
                    const info = JSON.parse(stdout);
                    const { subtitles, isAutoGenerated } = extractSubtitleChoices(info);
                    resolve({ success: true, error: false, message: '', subtitles, isAutoGenerated });
                } catch (parseError) {
                    logger.error('Error parsing video info:', parseError);
                    resolve(failure('Failed to parse video information'));
                }
            });
        } catch (err) {
            resolve(failure(err.message));
        }
    }));
}

/** Re-encode a downloaded video in `downloadFolder` to MP4 (H.264/AAC). */
export async function reEncodeToMp4(downloadFolder, videoId, onProgress = noop) {
    logger.info('Re-encoding video in folder:', downloadFolder, 'for video ID:', videoId);

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

        logger.info(`Re-encoding file: ${file}`);
        onProgress(`Re-encoding ${file}...`);

        const result = await runFfmpegWithCodecFallback({
            task,
            onProgress,
            buildArgs: (audioCodec) => buildFfmpegReEncodeArgs({ filePath, outputPath, thumbnailPath, audioCodec }),
            outputPath,
            logPrefix: `Re-encoding ${file}`
        });

        if (result.isCancelled) {
            logger.info('Re-encoding was cancelled. Cleaning up temporary output only...');
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
            logger.info(`Successfully re-encoded: ${file} to ${finalPath}`);

            const tmpFiles = [];
            if (filePath !== finalPath) tmpFiles.push(filePath);
            if (thumbnailPath && thumbnailPath !== finalPath) tmpFiles.push(thumbnailPath);

            return {
                success: true,
                cancelled: false,
                message: `Re-encoding completed successfully. Saved as: ${filename}.mp4`,
                tmpFiles: offerTempFiles(tmpFiles)
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
}

/** Download a video with subtitles and burn the subtitles into the video with ffmpeg. */
export async function downloadWithHardsub(options, onProgress = noop) {
    const { url, browser, downloadFolder, subtitleLang, subtitleType, codec, subtitlePosition = 'bottom', proxy } = options;
    logger.info('Download with hardsub:', { url, subtitleLang, subtitleType, codec, subtitlePosition, downloadFolder });

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
            message:
                'Hardsubbing requires FFmpeg with libass support (missing "subtitles" filter).\n\n👉 On macOS, please install FFmpeg with subtitles support:\n   - MacPorts: sudo port install ffmpeg\n   - Homebrew: brew install ffmpeg-full',
            error: 'FFmpeg lacks libass / subtitles filter support.',
            tmpFiles: []
        };
    }

    const cancelledResult = () => ({
        success: false,
        cancelled: true,
        message: 'Hardsub cancelled by user.',
        error: 'Action cancelled by user.',
        tmpFiles: []
    });

    try {
        // Step 1: Download video with subtitle (limit to avc1/H.264)
        const manifestFile = join(tmpdir(), `ytdl-sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
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

        onProgress('Downloading video and subtitles...');
        logger.info('Download command:', args);

        let capturedDownloadPath = null;
        const outputLines = [];
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
                    onProgress(trimmed);
                } else if (trimmed) {
                    outputLines.push(trimmed);
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
            return cancelledResult();
        }
        if (downloadCode !== 0) {
            const errorDetail = outputLines.join('\n') || `Download failed with code ${downloadCode}`;
            return {
                success: false,
                cancelled: false,
                message: errorDetail,
                error: errorDetail,
                tmpFiles: []
            };
        }

        // Step 2: Find downloaded files
        if (task.isCancelled) {
            return cancelledResult();
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

        logger.info('Video file:', videoPath);
        logger.info('Subtitle file:', subtitlePath);
        logger.info('Output path:', outputPath);

        if (task.isCancelled) {
            return cancelledResult();
        }

        // Step 3: Run ffmpeg with hardsub
        onProgress(`Hardcoding subtitles using ${codec.toUpperCase()}...`);

        const result = await runFfmpegWithCodecFallback({
            task,
            onProgress,
            buildArgs: (audioCodec) => buildFfmpegHardsubArgs({ videoPath, outputPath, subtitlePath, thumbnailPath, codec, audioCodec, subtitlePosition }),
            outputPath,
            logPrefix: 'Hardcoding'
        });

        if (result.isCancelled) {
            logger.info('Hardsub was cancelled. Cleaning up temporary output only...');
            try { await fs.unlink(outputPath); } catch { /* ignore */ }
            return cancelledResult();
        }

        if (result.success) {
            const finalPath = join(downloadFolder, `${videoName}${codecSuffix}.mp4`);
            await fs.rename(outputPath, finalPath);

            logger.info(`Successfully created hardsub video: ${finalPath}`);
            const tmpFiles = [];
            if (videoPath !== finalPath) tmpFiles.push(videoPath);
            if (subtitlePath && subtitlePath !== finalPath) tmpFiles.push(subtitlePath);
            if (thumbnailPath && thumbnailPath !== finalPath) tmpFiles.push(thumbnailPath);

            return {
                success: true,
                cancelled: false,
                message: `Hardsub completed! Saved as: ${videoName}${codecSuffix}.mp4`,
                tmpFiles: offerTempFiles(tmpFiles)
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
        logger.error('Hardsub error:', error);
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
}

/**
 * Temporary files this process has offered to delete (leftovers of a finished re-encode or hardsub).
 * Only these can be deleted through `deleteTemporaryFiles`, so a caller cannot use it to remove
 * arbitrary files.
 */
const offeredTempFiles = new Set();

function offerTempFiles(paths) {
    for (const p of paths) offeredTempFiles.add(p);
    return paths;
}

/** Delete temporary files previously reported in a result's `tmpFiles`; ignores everything else. */
export async function deleteTemporaryFiles(paths) {
    if (!Array.isArray(paths)) return;
    for (const p of paths) {
        if (typeof p === 'string' && offeredTempFiles.has(p)) {
            offeredTempFiles.delete(p);
            try {
                await fs.unlink(p);
            } catch (e) {
                if (e.code !== 'ENOENT') logger.error('Error cleaning up temp file:', p, e.message);
            }
        }
    }
}
