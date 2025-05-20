import { exec } from 'child_process';
import { app } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

// Check if a package is installed via Homebrew
async function isInstalledViaHomebrew(packageName) {
    return new Promise((resolve) => {
        exec(`brew list ${packageName}`, (error) => {
            resolve(!error); // If no error, package is installed via Homebrew
        });
    });
}

// Check for app updates
export async function checkAppUpdate() {
    try {
        const result = await autoUpdater.checkForUpdates();
        return result ? 'Update available' : 'App is up to date';
    } catch (error) {
        return `Error checking app update: ${error.message}`;
    }
}

// Check if yt-dlp needs update
async function checkYtDlpUpdate() {
    return new Promise(async (resolve) => {
        try {
            const isHomebrew = await isInstalledViaHomebrew('yt-dlp');
            const command = isHomebrew ? 'brew outdated yt-dlp' : 'yt-dlp -U --dry-run';
            
            exec(command, (error, stdout, stderr) => {
                // For brew outdated, error code 1 means no updates available
                if (error && error.code === 1) {
                    resolve({ needsUpdate: false, message: 'yt-dlp is up to date' });
                    return;
                }
                // If there's no error or error code is not 1, check the output
                if (stdout.trim() || (error && error.code !== 1)) {
                    resolve({ needsUpdate: true, message: 'yt-dlp update available' });
                } else {
                    resolve({ needsUpdate: false, message: 'yt-dlp is up to date' });
                }
            });
        } catch (error) {
            resolve({ needsUpdate: false, message: `Error checking yt-dlp update: ${error.message}` });
        }
    });
}

// Update yt-dlp
export async function updateYtDlp() {
    return new Promise(async (resolve) => {
        try {
            const isHomebrew = await isInstalledViaHomebrew('yt-dlp');
            const command = isHomebrew ? 'brew upgrade yt-dlp' : 'yt-dlp -U';
            
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    resolve(`Error updating yt-dlp: ${error.message}`);
                    return;
                }
                if (stderr) {
                    resolve(`yt-dlp update output: ${stderr}`);
                    return;
                }
                resolve(`yt-dlp updated successfully: ${stdout}`);
            });
        } catch (error) {
            resolve(`Error checking yt-dlp installation method: ${error.message}`);
        }
    });
}

// Check if ffmpeg needs update
async function checkFfmpegUpdate() {
    return new Promise(async (resolve) => {
        try {
            const isHomebrew = await isInstalledViaHomebrew('ffmpeg');
            if (!isHomebrew) {
                resolve({ needsUpdate: false, message: 'ffmpeg is not installed via Homebrew' });
                return;
            }
            
            exec('brew outdated ffmpeg', (error, stdout, stderr) => {
                // For brew outdated, error code 1 means no updates available
                if (error && error.code === 1) {
                    resolve({ needsUpdate: false, message: 'ffmpeg is up to date' });
                    return;
                }
                // If there's no error or error code is not 1, check the output
                if (stdout.trim() || (error && error.code !== 1)) {
                    resolve({ needsUpdate: true, message: 'ffmpeg update available' });
                } else {
                    resolve({ needsUpdate: false, message: 'ffmpeg is up to date' });
                }
            });
        } catch (error) {
            resolve({ needsUpdate: false, message: `Error checking ffmpeg update: ${error.message}` });
        }
    });
}

// Check ffmpeg version
export async function checkFfmpeg() {
    return new Promise((resolve) => {
        exec('ffmpeg -version', (error, stdout, stderr) => {
            if (error) {
                resolve('ffmpeg is not installed');
                return;
            }
            const version = stdout.split('\n')[0];
            resolve(`ffmpeg version: ${version}`);
        });
    });
}

// Update ffmpeg
export async function updateFfmpeg() {
    return new Promise(async (resolve) => {
        try {
            const isHomebrew = await isInstalledViaHomebrew('ffmpeg');
            const command = isHomebrew ? 'brew upgrade ffmpeg' : 'ffmpeg -version';
            
            if (!isHomebrew) {
                resolve('ffmpeg is not installed via Homebrew. Please update it using your system package manager.');
                return;
            }
            
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    resolve(`Error updating ffmpeg: ${error.message}`);
                    return;
                }
                if (stderr) {
                    resolve(`ffmpeg update output: ${stderr}`);
                    return;
                }
                resolve(`ffmpeg updated successfully: ${stdout}`);
            });
        } catch (error) {
            resolve(`Error checking ffmpeg installation method: ${error.message}`);
        }
    });
}

// Check yt-dlp version
export async function checkYtDlp() {
    return new Promise((resolve) => {
        exec('yt-dlp --version', (error, stdout, stderr) => {
            if (error) {
                resolve('yt-dlp is not installed');
                return;
            }
            resolve(`yt-dlp version: ${stdout.trim()}`);
        });
    });
}

// Export the check update functions
export { checkYtDlpUpdate, checkFfmpegUpdate }; 