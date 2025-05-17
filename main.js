import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
        fullscreen: true,
        webPreferences: {
            preload: join(__dirname, 'preload.js'), // Preload script with explicit .js extension
            nodeIntegration: false,                 // Do NOT use node integration!
            contextIsolation: true,                 // Isolate context for security
        }
    });
    win.loadFile('index.html');
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
