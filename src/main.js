import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { checkAppUpdate, getCurrentVersion, isAutoUpdaterSupported } from './update.js';
import {
    setupEnvironmentPaths
} from './dependencies.js';
import {
    cancelCurrentTask,
    runYtDlp,
    getFormatInfo,
    listSubtitles,
    reEncodeToMp4,
    downloadWithHardsub,
    deleteTemporaryFiles
} from './core/tools.js';
import { ChatService, AiSettingsError } from './llm/chat-service.js';
import { KeyStore } from './llm/key-store.js';

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
    const filePath = await getSettingsPath();
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch {
        try {
            await fs.access(filePath);
            return {};
        } catch {
            return { aiMode: 'ai' };
        }
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

async function mergeSettings(updates) {
    const current = await readSettings();
    const merged = { ...current, ...updates };
    await writeSettings(merged);
    return merged;
}

ipcMain.handle('set-settings', async (_event, updates) => {
    // Keys starting with "ai" are reserved for the AI mode and may only be changed through the
    // validated ai-* handlers below (they hold provider URLs, model names and security options).
    const safeUpdates = Object.fromEntries(
        Object.entries(updates && typeof updates === 'object' ? updates : {}).filter(([key]) => !key.startsWith('ai'))
    );
    return mergeSettings(safeUpdates);
});

// Fix PATH globally so yt-dlp and ffmpeg are found across all environments (MacPorts, Homebrew, system)
setupEnvironmentPaths();

// Helper: forward progress text from core operations to the renderer that requested them
function progressReporter(event) {
    return (text) => event.sender.send('download-progress', text);
}

// Unified IPC handler for cancelling the current action
ipcMain.handle('cancel-command', async () => {
    return cancelCurrentTask();
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
ipcMain.handle('get-format-info', async (_event, args) => getFormatInfo(args));

// IPC handler for running yt-dlp commands
ipcMain.handle('run-command', async (event, args) => runYtDlp(args, progressReporter(event)));

// IPC handler for re-encoding videos to MP4 with H.264 and AAC
ipcMain.handle('re-encode-to-mp4', async (event, downloadFolder, videoId) =>
    reEncodeToMp4(downloadFolder, videoId, progressReporter(event))
);

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
ipcMain.handle('list-subtitles', async (_event, url, browser, proxy) => listSubtitles(url, browser, proxy));

// IPC handler for downloading video with hardcoded subtitles
ipcMain.handle('download-with-hardsub', async (event, options) =>
    downloadWithHardsub(options, progressReporter(event))
);

ipcMain.handle('delete-temporary-files', async (_event, paths) => deleteTemporaryFiles(paths));

// ---------------------------------------------------------------------------
// AI mode (prompt-driven assistant). The service is created lazily because
// safeStorage and userData paths are only reliable once the app is ready.
// API keys never leave the main process: the renderer can set/remove them and
// learn whether one exists, but cannot read them back.
// ---------------------------------------------------------------------------
let chatService = null;
let aiEventSender = null;

function getChatService() {
    if (!chatService) {
        const keyStore = new KeyStore({
            filePath: join(app.getPath('userData'), 'ai-keys.json'),
            crypto: {
                // On Linux without a keyring Electron falls back to a hard-coded password ("basic_text"),
                // which is not real protection, so treat that as unavailable.
                isAvailable: () => {
                    if (!safeStorage.isEncryptionAvailable()) return false;
                    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
                        return safeStorage.getSelectedStorageBackend() !== 'basic_text';
                    }
                    return true;
                },
                encrypt: (plain) => safeStorage.encryptString(plain),
                decrypt: (encrypted) => safeStorage.decryptString(encrypted)
            }
        });

        chatService = new ChatService({
            settings: { read: readSettings, merge: mergeSettings },
            keyStore,
            log: (message) => console.log(`[ai] ${message}`),
            emit: (payload) => {
                if (aiEventSender && !aiEventSender.isDestroyed()) {
                    aiEventSender.send('ai-event', payload);
                }
            }
        });
    }
    return chatService;
}

// Wrap a handler so expected validation errors come back as { ok: false, error } instead of
// an opaque "Error invoking remote method" rejection.
function aiHandler(fn) {
    return async (event, ...args) => {
        try {
            return { ok: true, ...(await fn(event, ...args)) };
        } catch (err) {
            if (err instanceof AiSettingsError) return { ok: false, error: err.message };
            console.error('AI handler error:', err.message);
            return { ok: false, error: 'Unexpected error.' };
        }
    };
}

ipcMain.handle('ai-get-settings', aiHandler(async () => ({ settings: await getChatService().getSettings() })));

ipcMain.handle('ai-set-settings', aiHandler(async (_event, update) => ({
    settings: await getChatService().setSettings(update)
})));

ipcMain.handle('ai-set-api-key', aiHandler(async (_event, type, apiKey) => getChatService().setApiKey(type, apiKey)));

ipcMain.handle('ai-remove-api-key', aiHandler(async (_event, type) => ({
    settings: await getChatService().removeApiKey(type)
})));

ipcMain.handle('ai-test-connection', async (_event, overrides) => getChatService().testConnection(overrides || {}));

// Returns { ok: true, text, stoppedBecause, steps } or { ok: false, error: { kind, message } }.
// Live events (assistant text, tool start/result, progress, confirmation requests) arrive on 'ai-event'.
ipcMain.handle('ai-send', async (event, message, context) => {
    aiEventSender = event.sender;
    return getChatService().send(message, context || {});
});

ipcMain.handle('ai-cancel', async () => getChatService().cancel());

ipcMain.handle('ai-reset', async () => getChatService().reset());

ipcMain.handle('ai-confirm-response', async (_event, requestId, approved) =>
    getChatService().resolveConfirmation(requestId, approved === true)
);
