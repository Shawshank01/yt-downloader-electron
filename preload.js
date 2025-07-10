const { contextBridge, ipcRenderer } = require('electron');

console.log("preload.js running!");

contextBridge.exposeInMainWorld('electronAPI', {
    chooseFolder: () => ipcRenderer.invoke('choose-folder'),
    runCommand: (cmd) => ipcRenderer.invoke('run-command', cmd),
    onProgress: (callback) => {
        ipcRenderer.on('download-progress', (_, progress) => callback(progress));
        return () => {
            ipcRenderer.removeAllListeners('download-progress');
        };
    },
    checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
    getCurrentVersion: () => ipcRenderer.invoke('get-current-version'),
    isAutoUpdaterSupported: () => ipcRenderer.invoke('is-auto-updater-supported'),
    reEncodeToMp4: (downloadFolder, videoId) => ipcRenderer.invoke('re-encode-to-mp4', downloadFolder, videoId)
});
