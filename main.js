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
            preload: join(__dirname, 'preload.js'), // Preload script
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
        exec(args, (error, stdout, stderr) => {
            let output = '';
            if (stdout) output += stdout;
            if (stderr) output += '\n' + stderr;
            if (error) output += '\nError: ' + error;
            resolve(output.trim());
        });
    });
});
