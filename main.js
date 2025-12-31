import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
    checkAppUpdate,
    getCurrentVersion,
    isAutoUpdaterSupported
} from './update.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Fix PATH so yt-dlp is found ===
const extraPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(':'), ...extraPaths])].join(':');

function createWindow() {
    const win = new BrowserWindow({
        fullscreenable: true,
        webPreferences: {
            preload: join(__dirname, 'preload.js'), // Preload script with explicit .js extension
            nodeIntegration: false,                 // Do NOT use node integration!
            contextIsolation: true,                 // Isolate context for security
        }
    });
    win.loadFile('index.html');

    // Maximize the window instead of fullscreen to keep it in current desktop
    win.maximize();
}

app.whenReady().then(createWindow).catch(console.error);

// IPC handler for folder picker
ipcMain.handle('choose-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
    });
    return (result.canceled || result.filePaths.length === 0) ? '' : result.filePaths[0];
});

// IPC handler for running yt-dlp commands
ipcMain.handle('run-command', async (event, args) => {
    console.log("Executing:", args);
    console.log("process.env.PATH:", process.env.PATH);

    return new Promise((resolve) => {
        const process = exec(args);
        let output = '';

        process.stdout.on('data', (data) => {
            output += data;
            // Check if the line contains download progress
            if (data.includes('[download]')) {
                event.sender.send('download-progress', data.trim());
            }
        });

        process.stderr.on('data', (data) => {
            output += '\n' + data;
            // Check if the line contains download progress
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
        const fs = await import('fs');
        const path = await import('path');

        // Find the specific downloaded file by looking for video files containing the video ID
        const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];
        const files = fs.default.readdirSync(downloadFolder).filter(file => {
            const lowerFile = file.toLowerCase();
            return videoExtensions.some(ext => lowerFile.endsWith(ext)) && file.includes(videoId);
        });

        if (files.length === 0) {
            return "No matching video file found to re-encode.";
        }

        // Only process the first matching file (should be the one just downloaded)
        const file = files[0];
        const filePath = path.default.join(downloadFolder, file);
        const fileExt = path.default.extname(file);
        const filename = path.default.basename(file, fileExt);
        const outputPath = path.default.join(downloadFolder, `${filename}_reencoded.mp4`);

        console.log(`Re-encoding file: ${file}`);
        event.sender.send('download-progress', `Re-encoding ${file}...`);

        return new Promise((resolve) => {
            // Try with libfdk_aac first, fallback to aac if it fails
            const tryReEncode = (audioCodec) => {
                const ffmpegCmd = `ffmpeg -i "${filePath}" -c:v libx264 -crf 18 -preset veryslow -c:a ${audioCodec} -tag:v avc1 "${outputPath}"`;
                const process = exec(ffmpegCmd);

                process.stdout.on('data', (data) => {
                    // Send progress updates for ffmpeg
                    if (data.includes('time=')) {
                        event.sender.send('download-progress', `Re-encoding ${file} (${audioCodec}): ${data.trim()}`);
                    }
                });

                process.stderr.on('data', (data) => {
                    // ffmpeg sends progress to stderr
                    if (data.includes('time=')) {
                        event.sender.send('download-progress', `Re-encoding ${file} (${audioCodec}): ${data.trim()}`);
                    }
                });

                process.on('close', (code) => {
                    if (code === 0) {
                        // Success - replace original file with re-encoded version
                        fs.default.unlinkSync(filePath);
                        fs.default.renameSync(outputPath, filePath);
                        console.log(`Successfully re-encoded: ${file} with ${audioCodec}`);
                        resolve(`Re-encoding completed successfully for ${file}`);
                    } else if (code !== 0 && audioCodec === 'libfdk_aac') {
                        // libfdk_aac failed, try with aac
                        console.log(`libfdk_aac failed for ${file}, trying with aac...`);
                        event.sender.send('download-progress', `libfdk_aac not available, trying with aac...`);
                        tryReEncode('aac');
                    } else {
                        // Both codecs failed
                        console.log(`Failed to re-encode: ${file}`);
                        // Clean up temporary file if it exists
                        if (fs.default.existsSync(outputPath)) {
                            fs.default.unlinkSync(outputPath);
                        }
                        resolve(`Failed to re-encode ${file}`);
                    }
                });
            };

            // Start with libfdk_aac
            tryReEncode('libfdk_aac');
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
