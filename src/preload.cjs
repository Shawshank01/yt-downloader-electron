/* global process */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    chooseFolder: () => ipcRenderer.invoke('choose-folder'),
    runCommand: (cmd) => ipcRenderer.invoke('run-command', cmd),
    onProgress: (callback) => {
        const listener = (_, progress) => callback(progress);
        ipcRenderer.on('download-progress', listener);
        return () => {
            ipcRenderer.removeListener('download-progress', listener);
        };
    },
    checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
    getCurrentVersion: () => ipcRenderer.invoke('get-current-version'),
    isAutoUpdaterSupported: () => ipcRenderer.invoke('is-auto-updater-supported'),
    reEncodeToMp4: (downloadFolder, videoId) =>
        ipcRenderer.invoke('re-encode-to-mp4', downloadFolder, videoId),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    openFilesAndFoldersSettings: () =>
        ipcRenderer.invoke(
            'open-external',
            'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_FilesAndFolders'
        ),
    // Hardsub feature APIs
    listSubtitles: (url, browser, proxy) => ipcRenderer.invoke('list-subtitles', url, browser, proxy),
    downloadWithHardsub: (options) => ipcRenderer.invoke('download-with-hardsub', options),
    // Generic command API
    cancelCommand: () => ipcRenderer.invoke('cancel-command'),
    deleteTemporaryFiles: (paths) => ipcRenderer.invoke('delete-temporary-files', paths),
    getFormatInfo: (args) => ipcRenderer.invoke('get-format-info', args),
    // Persistent user settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    setSettings: (updates) => ipcRenderer.invoke('set-settings', updates),
    // AI mode. API keys can be set or removed but are never readable from the renderer.
    ai: {
        getSettings: () => ipcRenderer.invoke('ai-get-settings'),
        setSettings: (update) => ipcRenderer.invoke('ai-set-settings', update),
        setApiKey: (type, apiKey) => ipcRenderer.invoke('ai-set-api-key', type, apiKey),
        removeApiKey: (type) => ipcRenderer.invoke('ai-remove-api-key', type),
        testConnection: (overrides) => ipcRenderer.invoke('ai-test-connection', overrides),
        send: (message, context) => ipcRenderer.invoke('ai-send', message, context),
        cancel: () => ipcRenderer.invoke('ai-cancel'),
        reset: () => ipcRenderer.invoke('ai-reset'),
        confirm: (requestId, approved) => ipcRenderer.invoke('ai-confirm-response', requestId, approved),
        onEvent: (callback) => {
            const listener = (_, payload) => callback(payload);
            ipcRenderer.on('ai-event', listener);
            return () => {
                ipcRenderer.removeListener('ai-event', listener);
            };
        }
    }
});
