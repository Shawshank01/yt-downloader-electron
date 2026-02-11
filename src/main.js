import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, extname, basename } from 'path';
import { promises as fs } from 'fs';
import { checkAppUpdate, getCurrentVersion, isAutoUpdaterSupported } from './update.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Global state for re-encoding process
let activeReEncodeProcess = null;
let reEncodeCancelled = false;

// Global state for hardsub process
let activeHardsubProcess = null;
let hardsubCancelled = false;

// IPC handler for cancelling re-encoding
ipcMain.handle('cancel-re-encode', async () => {
    if (activeReEncodeProcess) {
        reEncodeCancelled = true;
        const pid = activeReEncodeProcess.pid;
        console.log(`Cancelling re-encode process with PID: ${pid}`);

        try {
            process.kill(pid, 'SIGKILL');
        } catch (e) {
            console.error("Error killing process:", e);
        }

        console.log("Re-encoding process kill signal sent.");
        return true;
    }
    return false;
});

function createWindow() {
    const win = new BrowserWindow({
        fullscreenable: true,
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    win.loadFile(join(__dirname, 'index.html'));

    // Maximize the window instead of fullscreen to keep it in current desktop
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

// IPC handler for running yt-dlp commands
ipcMain.handle('run-command', async (event, args) => {
    console.log('Executing:', args);
    console.log('process.env.PATH:', process.env.PATH);

    return new Promise((resolve) => {
        const process = exec(args);
        let output = '';

        process.stdout.on('data', (data) => {
            output += data;
            if (data.includes('[download]')) {
                event.sender.send('download-progress', data.trim());
            }
        });

        process.stderr.on('data', (data) => {
            output += '\n' + data;
            if (data.includes('[download]')) {
                event.sender.send('download-progress', data.trim());
            }
        });

        process.on('close', (code) => {
            if (code !== 0) {
                output += `\nProcess exited with code ${code}`;
            }
            resolve(output.trim());
        });
    });
});

// IPC handler for re-encoding videos to MP4 with H.264 and AAC
ipcMain.handle('re-encode-to-mp4', async (event, downloadFolder, videoId) => {
    console.log("Re-encoding video in folder:", downloadFolder, "for video ID:", videoId);

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
        reEncodeCancelled = false;

        console.log(`Re-encoding file: ${file}`);
        event.sender.send('download-progress', `Re-encoding ${file}...`);

        return new Promise((resolve) => {
            const tryReEncode = (audioCodec) => {
                const args = [
                    '-i', filePath,
                    '-c:v', 'libx264',
                    '-crf', '22',
                    '-preset', 'veryslow',
                    '-c:a', audioCodec,
                    '-tag:v', 'avc1',
                    outputPath
                ];

                activeReEncodeProcess = spawn('ffmpeg', args);

                activeReEncodeProcess.stdout.on('data', (data) => {
                    if (reEncodeCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=')) {
                        event.sender.send('download-progress', `Re-encoding ${file} (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeReEncodeProcess.stderr.on('data', (data) => {
                    if (reEncodeCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=')) {
                        event.sender.send('download-progress', `Re-encoding ${file} (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeReEncodeProcess.on('close', async (code) => {
                    activeReEncodeProcess = null;

                    if (reEncodeCancelled) {
                        console.log("Re-encoding was cancelled. Cleaning up...");
                        try {
                            await fs.unlink(outputPath);
                        } catch (e) { /* ignore if output file doesn't exist */ }
                        try {
                            await fs.unlink(filePath);
                            console.log(`Deleted original file: ${filePath}`);
                        } catch (e) { /* ignore if input file doesn't exist */ }

                        resolve("Re-encoding cancelled by user. Files cleaned up.");
                        return;
                    }

                    if (code === 0) {
                        try {
                            await fs.unlink(filePath);
                            const finalPath = join(downloadFolder, `${filename}.mp4`);
                            await fs.rename(outputPath, finalPath);

                            console.log(`Successfully re-encoded: ${file} to ${finalPath}`);
                            resolve(`Re-encoding completed successfully. Saved as: ${filename}.mp4`);
                        } catch (err) {
                            console.error("Error replacing file:", err);
                            resolve(`Re-encoding finished but failed to replace file: ${err.message}`);
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
                        } catch (e) { /* ignore */ }

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

// IPC handler for cancelling hardsub process
ipcMain.handle('cancel-hardsub', async () => {
    if (activeHardsubProcess) {
        hardsubCancelled = true;
        const pid = activeHardsubProcess.pid;
        console.log(`Cancelling hardsub process with PID: ${pid}`);

        try {
            process.kill(pid, 'SIGKILL');
        } catch (e) {
            console.error("Error killing hardsub process:", e);
        }

        console.log("Hardsub process kill signal sent.");
        return true;
    }
    return false;
});

// IPC handler for listing available subtitles
ipcMain.handle('list-subtitles', async (_event, url, browser) => {
    console.log('Listing subtitles for:', url);

    return new Promise((resolve) => {
        const cookiesParam = browser ? `--cookies-from-browser ${browser}` : '';
        const cmd = `yt-dlp -j --skip-download ${cookiesParam} "${url}"`;

        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
            if (error) {
                console.error('Error getting video info:', error);
                resolve({ error: true, message: error.message, subtitles: [], isAutoGenerated: false });
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
    const { url, browser, downloadFolder, subtitleLang, subtitleType, codec } = options;
    console.log('Download with hardsub:', { url, subtitleLang, subtitleType, codec, downloadFolder });

    try {
        // Step 1: Download video with subtitle (limit to avc1/H.264)
        const cookiesParam = browser ? `--cookies-from-browser ${browser}` : '';
        // Use --write-auto-subs for auto-generated captions, --write-subs for manual subtitles
        const subsFlag = subtitleType === 'manual' ? '--write-subs' : '--write-auto-subs';
        const downloadCmd = `yt-dlp -f "bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]" ${subsFlag} --sub-langs "${subtitleLang}" --convert-subs vtt -P "${downloadFolder}" ${cookiesParam} "${url}"`;

        event.sender.send('download-progress', 'Downloading video and subtitles...');
        console.log('Download command:', downloadCmd);

        // Execute download
        await new Promise((resolve, reject) => {
            const proc = exec(downloadCmd);

            proc.stdout.on('data', (data) => {
                if (data.includes('[download]')) {
                    event.sender.send('download-progress', data.trim());
                }
            });

            proc.stderr.on('data', (data) => {
                if (data.includes('[download]')) {
                    event.sender.send('download-progress', data.trim());
                }
            });

            proc.on('close', (code) => {
                if (code === 0) {
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

        const videoPath = join(downloadFolder, videoFile);
        const subtitlePath = join(downloadFolder, subtitleFile);
        const videoExt = extname(videoFile);
        const videoName = basename(videoFile, videoExt);
        const codecSuffix = codec === 'hevc' ? '_HEVC' : '_H264';
        const outputPath = join(downloadFolder, `${videoName}${codecSuffix}_temp.mp4`);

        console.log('Video file:', videoPath);
        console.log('Subtitle file:', subtitlePath);
        console.log('Output path:', outputPath);

        // Step 3: Run ffmpeg with hardsub
        event.sender.send('download-progress', `Hardcoding subtitles using ${codec.toUpperCase()}...`);
        hardsubCancelled = false;

        return new Promise((resolve) => {
            const tryHardsub = (audioCodec) => {
                let args;

                // Escape the subtitle path for ffmpeg filter
                const escapedSubPath = subtitlePath.replace(/'/g, "'\\''").replace(/:/g, '\\:');

                if (codec === 'hevc') {
                    args = [
                        '-hwaccel', 'videotoolbox',
                        '-i', videoPath,
                        '-vf', `subtitles='${escapedSubPath}':force_style='FontName=Songti SC'`,
                        '-c:v', 'hevc_videotoolbox',
                        '-pix_fmt', 'p010le',
                        '-b:v', '2500k',
                        '-c:a', audioCodec,
                        '-tag:v', 'hev1',
                        outputPath
                    ];
                } else {
                    // Default to H.264
                    args = [
                        '-hwaccel', 'videotoolbox',
                        '-i', videoPath,
                        '-vf', `subtitles='${escapedSubPath}':force_style='FontName=Songti SC'`,
                        '-c:v', 'h264_videotoolbox',
                        '-b:v', '4000k',
                        '-c:a', audioCodec,
                        '-tag:v', 'avc1',
                        outputPath
                    ];
                }

                console.log('FFmpeg args:', args);
                activeHardsubProcess = spawn('ffmpeg', args);

                activeHardsubProcess.stdout.on('data', (data) => {
                    if (hardsubCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=') || str.includes('frame=')) {
                        event.sender.send('download-progress', `Hardcoding (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeHardsubProcess.stderr.on('data', (data) => {
                    if (hardsubCancelled) return;
                    const str = data.toString();
                    if (str.includes('time=') || str.includes('frame=')) {
                        event.sender.send('download-progress', `Hardcoding (${audioCodec}): ${str.trim()}`);
                    }
                });

                activeHardsubProcess.on('close', async (code) => {
                    activeHardsubProcess = null;

                    if (hardsubCancelled) {
                        console.log("Hardsub was cancelled. Cleaning up...");
                        try { await fs.unlink(outputPath); } catch (e) { /* ignore */ }
                        resolve("Hardsub cancelled by user.");
                        return;
                    }

                    if (code === 0) {
                        try {
                            // Clean up original video and subtitle files
                            await fs.unlink(videoPath);
                            await fs.unlink(subtitlePath);

                            // Rename output to final name
                            const finalPath = join(downloadFolder, `${videoName}${codecSuffix}.mp4`);
                            await fs.rename(outputPath, finalPath);

                            console.log(`Successfully created hardsub video: ${finalPath}`);
                            resolve(`Hardsub completed! Saved as: ${videoName}${codecSuffix}.mp4`);
                        } catch (err) {
                            console.error("Error cleaning up files:", err);
                            resolve(`Hardsub finished but failed to clean up: ${err.message}`);
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
                        try { await fs.unlink(outputPath); } catch (e) { /* ignore */ }
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
