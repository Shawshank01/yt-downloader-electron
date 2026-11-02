import { promises as fs } from 'fs';
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
