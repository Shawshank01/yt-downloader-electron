interface ElectronAPI {
    chooseFolder: () => Promise<string>;
    runCommand: (cmd: string) => Promise<string>;
    onProgress: (callback: (progress: string) => void) => () => void;
    checkAppUpdate: () => Promise<{ error?: boolean; hasUpdate?: boolean; version?: string; releaseNotes?: string; message?: string }>;
    getCurrentVersion: () => Promise<string>;
    isAutoUpdaterSupported: () => Promise<boolean>;
    reEncodeToMp4: (downloadFolder: string, videoId: string) => Promise<string>;
    openExternal: (url: string) => Promise<boolean>;
    cancelReEncode: () => Promise<boolean>;
    getFormatInfo: (args: string[]) => Promise<{ ok: boolean; output: string; error: string }>;
}

interface Window {
    electronAPI: ElectronAPI;
    chooseFolder: () => Promise<void>;
    checkUpdate: () => Promise<void>;
    runCommand: () => Promise<void>;
}
