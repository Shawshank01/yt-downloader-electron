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
    }
});
