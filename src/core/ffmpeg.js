import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { findExecutable } from '../dependencies.js';
import { taskManager } from './task-manager.js';
import { logger } from './logger.js';

// Platform-adaptive default subtitle font (single font family name without commas for ASS style)
export const DEFAULT_SUBTITLE_FONT = process.platform === 'darwin'
    ? 'PingFang SC'
    : process.platform === 'win32'
        ? 'Microsoft YaHei'
        : 'DejaVu Sans';

// Centralised transcoding and encoding configuration parameters
export const TRANSCODE_CONFIG = {
    crf: '22',
    preset: 'veryslow',
    audioBitrate: '128k',
    h264Bitrate: '5000k',
    hevcBitrate: '3000k',
    pixelFormatHevc: 'p010le',
    tagH264: 'avc1',
    tagHevc: 'hvc1',
    audioCodecs: process.platform === 'darwin'
        ? ['aac_at', 'libfdk_aac', 'aac']
        : ['libfdk_aac', 'aac']
};

// Helper to construct FFmpeg arguments for re-encoding
export function buildFfmpegReEncodeArgs({ filePath, outputPath, thumbnailPath, audioCodec }) {
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
export function buildFfmpegHardsubArgs({ videoPath, outputPath, subtitlePath, thumbnailPath, codec, audioCodec, subtitlePosition = 'bottom' }) {
    const args = [];
    const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:');

    args.push('-i', videoPath);

    // Alignment: 2 = Bottom Center (default), 6 = Top Center
    const alignment = subtitlePosition === 'top' ? '6' : '2';
    const subFilter = `subtitles='${escapedSubPath}':force_style='FontName=${DEFAULT_SUBTITLE_FONT},Alignment=${alignment}'`;
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
export async function runFfmpegWithCodecFallback({ task, onProgress, buildArgs, outputPath, logPrefix }) {
    const audioCodecs = TRANSCODE_CONFIG.audioCodecs;
    let success = false;
    let lastCode = 0;
    let lastError = '';

    for (const audioCodec of audioCodecs) {
        if (task.isCancelled) break;

        const args = buildArgs(audioCodec);
        logger.info(`${logPrefix} FFmpeg args:`, args);

        const stderrLines = [];
        let totalDurationSeconds = 0;
        let headerBuffer = '';

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

                if (!totalDurationSeconds) {
                    headerBuffer += str;
                    const durMatch = headerBuffer.match(/Duration:\s*(\d{2}):(\d{2}):([\d.]+)/);
                    if (durMatch) {
                        const durSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
                        if (durSec > 0.5) {
                            totalDurationSeconds = durSec;
                            headerBuffer = '';
                        }
                    } else if (headerBuffer.length > 4096) {
                        headerBuffer = headerBuffer.slice(-1024);
                    }
                }

                if (str.includes('time=') || str.includes('frame=')) {
                    const timeMatch = str.match(/time=\s*(\d{2}):(\d{2}):([\d.]+)/);
                    const speedMatch = str.match(/speed=\s*([\d.]+)x/i);
                    const sizeMatch = str.match(/size=\s*([^\s]+)/);

                    if (timeMatch && totalDurationSeconds > 0) {
                        const curSec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
                        const pct = Math.min(99.9, Math.max(0, (curSec / totalDurationSeconds) * 100));
                        const speedVal = speedMatch ? parseFloat(speedMatch[1]) : 0;
                        const speedStr = speedVal > 0 ? `${speedVal.toFixed(1)}x` : '';

                        let etaStr = '';
                        if (speedVal > 0 && curSec < totalDurationSeconds) {
                            const remainingSec = Math.round((totalDurationSeconds - curSec) / speedVal);
                            const m = Math.floor(remainingSec / 60);
                            const s = remainingSec % 60;
                            etaStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                        }

                        const totMin = Math.floor(totalDurationSeconds / 60);
                        const totSec = Math.floor(totalDurationSeconds % 60);
                        const totFormatted = `${String(totMin).padStart(2, '0')}:${String(totSec).padStart(2, '0')}`;

                        const curMin = Math.floor(curSec / 60);
                        const curSecPart = Math.floor(curSec % 60);
                        const curFormatted = `${String(curMin).padStart(2, '0')}:${String(curSecPart).padStart(2, '0')}`;

                        const etaPart = etaStr ? ` ETA ${etaStr}` : '';
                        const speedPart = speedStr ? ` at ${speedStr}` : '';
                        const sizePart = sizeMatch ? ` (${sizeMatch[1]})` : '';

                        onProgress(`[ffmpeg] ${pct.toFixed(1)}% of ~${totFormatted} (${curFormatted})${speedPart}${sizePart}${etaPart}`);
                    } else {
                        onProgress(`${logPrefix} (${audioCodec}): ${str.trim()}`);
                    }
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
            logger.error(`${logPrefix} with ${audioCodec} failed with code ${exitCode}:\n${errorSnippet}`);
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
                onProgress('aac_at not available, trying with libfdk_aac...');
            } else if (audioCodec === 'libfdk_aac') {
                onProgress('libfdk_aac not available, trying with aac...');
            }
        }
    }

    return { success, lastCode, lastError, isCancelled: task.isCancelled };
}

/**
 * Run ffprobe to get structured stream and format metadata for a media file.
 * @param {string} filePath Absolute path to the file.
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
export async function probeMedia(filePath) {
    const executable = await findExecutable('ffprobe');
    if (!executable) {
        return { ok: false, error: 'ffprobe is not installed or bundled.' };
    }

    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            filePath
        ];

        let child;
        try {
            child = spawn(executable, args);
        } catch (err) {
            resolve({ ok: false, error: `Failed to spawn ffprobe: ${err.message}` });
            return;
        }

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            resolve({ ok: false, error: 'ffprobe timed out after 15 seconds.' });
        }, 15000);

        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ ok: false, error: `ffprobe error: ${err.message}` });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                const err = stderr.trim() || `ffprobe failed with exit code ${code}`;
                resolve({ ok: false, error: err });
                return;
            }

            try {
                const data = JSON.parse(stdout);
                resolve({ ok: true, data });
            } catch (parseErr) {
                resolve({ ok: false, error: `Failed to parse ffprobe output: ${parseErr.message}` });
            }
        });
    });
}

/**
 * Convert raw ffprobe json output into a curated, LLM-friendly summary.
 * @param {object} data Parsed ffprobe json with format and streams.
 * @param {string} filename Name of the file.
 * @returns {object} Curated media summary.
 */
export function summarizeMediaInfo(data, filename) {
    const format = data.format || {};
    const streams = Array.isArray(data.streams) ? data.streams : [];

    const durationSec = format.duration ? parseFloat(format.duration) : null;
    let durationFormatted = null;
    if (durationSec !== null && !isNaN(durationSec)) {
        const total = Math.round(durationSec);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        durationFormatted = h > 0
            ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
            : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    const sizeBytes = format.size ? Number(format.size) : null;
    const sizeMb = sizeBytes ? Math.round((sizeBytes / (1024 * 1024)) * 10) / 10 : null;
    const bitrateKbps = format.bit_rate ? Math.round(Number(format.bit_rate) / 1000) : null;

    const videoStreams = [];
    const audioStreams = [];
    const subtitleStreams = [];

    for (const s of streams) {
        if (s.codec_type === 'video') {
            const isAttachedPic = s.disposition?.attached_pic === 1 || s.disposition?.still_image === 1;
            let fps = null;
            if (s.avg_frame_rate && s.avg_frame_rate !== '0/0') {
                const [num, den] = s.avg_frame_rate.split('/').map(Number);
                if (den && num) fps = Math.round((num / den) * 100) / 100;
            } else if (s.r_frame_rate && s.r_frame_rate !== '0/0') {
                const [num, den] = s.r_frame_rate.split('/').map(Number);
                if (den && num) fps = Math.round((num / den) * 100) / 100;
            }

            const info = {
                codec: s.codec_name || 'unknown',
                width: s.width || null,
                height: s.height || null,
                resolution: (s.width && s.height) ? `${s.width}x${s.height}` : null,
                aspect_ratio: s.display_aspect_ratio || null,
                fps,
                pixel_format: s.pix_fmt || null,
                bit_rate_kbps: s.bit_rate ? Math.round(Number(s.bit_rate) / 1000) : null
            };
            if (isAttachedPic) {
                info.is_attached_pic = true;
            }
            videoStreams.push(info);
        } else if (s.codec_type === 'audio') {
            audioStreams.push({
                codec: s.codec_name || 'unknown',
                channels: s.channels ?? null,
                channel_layout: s.channel_layout || null,
                sample_rate_hz: s.sample_rate ? Number(s.sample_rate) : null,
                bit_rate_kbps: s.bit_rate ? Math.round(Number(s.bit_rate) / 1000) : null,
                language: s.tags?.language || null,
                title: s.tags?.title || null
            });
        } else if (s.codec_type === 'subtitle') {
            subtitleStreams.push({
                codec: s.codec_name || 'unknown',
                language: s.tags?.language || null,
                title: s.tags?.title || null,
                is_forced: s.disposition?.forced === 1,
                is_default: s.disposition?.default === 1
            });
        }
    }

    const mainVideo = videoStreams.find((v) => !v.is_attached_pic) || videoStreams[0] || null;
    const mainAudio = audioStreams[0] || null;

    const result = {
        ok: true,
        file: filename,
        format: format.format_name || null,
        duration: durationFormatted,
        duration_seconds: durationSec ? Math.round(durationSec * 100) / 100 : null,
        size_mb: sizeMb,
        bit_rate_kbps: bitrateKbps,
        video: mainVideo,
        audio: mainAudio
    };

    if (videoStreams.length > 1) result.video_streams = videoStreams;
    if (audioStreams.length > 1) result.audio_streams = audioStreams;
    if (subtitleStreams.length > 0) result.subtitle_streams = subtitleStreams;

    return result;
}

/**
 * Determine the most suitable file extension for an audio stream.
 * @param {string} format 'best' | 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav'
 * @param {string} [nativeCodec] e.g. 'aac', 'opus', 'mp3', 'flac'
 * @returns {string} File extension without leading dot.
 */
export function determineAudioExtension(format, nativeCodec = '') {
    if (format === 'best') {
        const codec = (nativeCodec || '').toLowerCase();
        if (codec === 'aac') return 'm4a';
        if (codec === 'opus') return 'opus';
        if (codec === 'mp3') return 'mp3';
        if (codec === 'flac') return 'flac';
        if (codec === 'vorbis') return 'ogg';
        if (codec === 'alac') return 'm4a';
        if (codec === 'wav' || codec.startsWith('pcm_')) return 'wav';
        return 'm4a';
    }
    return format;
}

/**
 * Construct FFmpeg arguments to extract audio from a video file.
 * @param {object} params
 * @param {string} params.inputPath
 * @param {string} params.outputPath
 * @param {string} [params.format='best']
 * @param {string} [params.nativeCodec='']
 * @returns {string[]}
 */
export function buildFfmpegExtractAudioArgs({ inputPath, outputPath, format = 'best', nativeCodec = '' }) {
    const args = ['-y', '-i', inputPath, '-vn'];

    if (format === 'best') {
        args.push('-c:a', 'copy');
    } else if (format === 'mp3') {
        if (nativeCodec === 'mp3') {
            args.push('-c:a', 'copy');
        } else {
            args.push('-c:a', 'libmp3lame', '-q:a', '2');
        }
    } else if (format === 'm4a') {
        if (nativeCodec === 'aac') {
            args.push('-c:a', 'copy');
        } else {
            args.push('-c:a', 'aac', '-b:a', '192k');
        }
    } else if (format === 'opus') {
        if (nativeCodec === 'opus') {
            args.push('-c:a', 'copy');
        } else {
            args.push('-c:a', 'libopus', '-b:a', '160k');
        }
    } else if (format === 'flac') {
        if (nativeCodec === 'flac') {
            args.push('-c:a', 'copy');
        } else {
            args.push('-c:a', 'flac');
        }
    } else if (format === 'wav') {
        args.push('-c:a', 'pcm_s16le');
    } else {
        args.push('-c:a', 'copy');
    }

    args.push(outputPath);
    return args;
}

/**
 * Run a generic FFmpeg process attached to a task, streaming progress.
 * @param {object} params
 * @param {object} params.task
 * @param {string[]} params.args
 * @param {function} [params.onProgress]
 * @param {string} [params.logPrefix='FFmpeg']
 * @returns {Promise<{success: boolean, code: number, error: string, isCancelled: boolean}>}
 */
export async function runFfmpegProcess({ task, args, onProgress = () => {}, logPrefix = 'FFmpeg' }) {
    logger.info(`${logPrefix} FFmpeg args:`, args);

    const stderrLines = [];
    let totalDurationSeconds = 0;
    let headerBuffer = '';

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

            if (!totalDurationSeconds) {
                headerBuffer += str;
                const durMatch = headerBuffer.match(/Duration:\s*(\d{2}):(\d{2}):([\d.]+)/);
                if (durMatch) {
                    const durSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
                    if (durSec > 0.5) {
                        totalDurationSeconds = durSec;
                        headerBuffer = '';
                    }
                } else if (headerBuffer.length > 4096) {
                    headerBuffer = headerBuffer.slice(-1024);
                }
            }

            if (str.includes('time=')) {
                const timeMatch = str.match(/time=\s*(\d{2}):(\d{2}):([\d.]+)/);
                const speedMatch = str.match(/speed=\s*([\d.]+)x/i);
                if (timeMatch && totalDurationSeconds > 0) {
                    const curSec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
                    const pct = Math.min(99.9, Math.max(0, (curSec / totalDurationSeconds) * 100));
                    const speedVal = speedMatch ? parseFloat(speedMatch[1]) : 0;
                    const speedStr = speedVal > 0 ? ` at ${speedVal.toFixed(1)}x` : '';
                    onProgress(`[ffmpeg] ${pct.toFixed(1)}%${speedStr}`);
                } else {
                    onProgress(`${logPrefix}: ${str.trim()}`);
                }
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
        child.on('close', (code) => resolve(code));
    });

    const errorSnippet = stderrLines.slice(-15).join('\n');
    return {
        success: exitCode === 0 && !task.isCancelled,
        code: exitCode,
        error: exitCode === 0 ? '' : errorSnippet,
        isCancelled: task.isCancelled
    };
}
