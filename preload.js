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
    checkYtDlpUpdate: () => ipcRenderer.invoke('check-yt-dlp-update'),
    checkFfmpegUpdate: () => ipcRenderer.invoke('check-ffmpeg-update'),
    updateYtDlp: () => ipcRenderer.invoke('update-yt-dlp'),
    updateFfmpeg: () => ipcRenderer.invoke('update-ffmpeg'),
    checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
    checkYtDlp: () => ipcRenderer.invoke('check-yt-dlp'),
    reEncodeToMp4: (downloadFolder, videoId) => ipcRenderer.invoke('re-encode-to-mp4', downloadFolder, videoId)
});
