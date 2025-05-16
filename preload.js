const { contextBridge, ipcRenderer } = require('electron');

console.log("preload.js running!");

contextBridge.exposeInMainWorld('electronAPI', {
    chooseFolder: () => ipcRenderer.invoke('choose-folder'),
    runCommand: (cmd) => ipcRenderer.invoke('run-command', cmd)
});
