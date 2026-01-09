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
                    '-crf', '18',
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
