import pkg from 'electron-updater';
const { autoUpdater } = pkg;

// Check for app updates across all platforms (macOS, Windows, Linux)
export async function checkAppUpdate() {
    try {
        const result = await autoUpdater.checkForUpdates();
        if (result) {
            return {
                hasUpdate: true,
                message: 'Update available',
                version: result.updateInfo.version,
                releaseNotes: result.updateInfo.releaseNotes || 'No release notes available'
            };
        } else {
            return {
                hasUpdate: false,
                message: 'App is up to date'
            };
        }
    } catch (error) {
        return {
            hasUpdate: false,
            message: `Error checking app update: ${error.message}`,
            error: true
        };
    }
}

// Get current app version
export function getCurrentVersion() {
    try {
        const { app } = require('electron');
        return app.getVersion();
    } catch (error) {
        return 'Unknown';
    }
}

// Check if auto-updater is supported on current platform
export function isAutoUpdaterSupported() {
    try {
        return autoUpdater.isUpdaterActive();
    } catch (error) {
        return false;
    }
}
