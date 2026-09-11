import { exec } from 'child_process';
import { delimiter } from 'path';

// Ensure standard binary directories are included in PATH across all environments
const extraPaths = process.platform === 'win32'
    ? []
    : [
        '/opt/homebrew/opt/ffmpeg-full/bin',
        '/usr/local/opt/ffmpeg-full/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
    ];
process.env.PATH = [...new Set([...(process.env.PATH || '').split(delimiter), ...extraPaths])]
    .filter(Boolean)
    .join(delimiter);

// 20 MB maximum buffer size for command output capture
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

/**
 * Execute a shell command and return captured stdout, stderr, and success status.
 */
export function runCommandWithOutput(command) {
    return new Promise((resolve) => {
        exec(command, { maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    stdout: stdout?.trim() || '',
                    stderr: stderr?.trim() || '',
                    error: error.message
                });
                return;
            }

            resolve({
                ok: true,
                stdout: stdout?.trim() || '',
                stderr: stderr?.trim() || '',
                error: ''
            });
        });
    });
}

/**
 * Check if a CLI binary exists on the system and fetch its version.
 */
export async function getDependencyInfo(name, versionCommand) {
    const pathCommand = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const pathResult = await runCommandWithOutput(pathCommand);
    if (!pathResult.ok || !pathResult.stdout) {
        return {
            name,
            installed: false,
            path: '',
            version: ''
        };
    }

    const versionResult = await runCommandWithOutput(versionCommand);
    const versionLine =
        versionResult.stdout.split('\n')[0]?.trim() ||
        versionResult.stderr.split('\n')[0]?.trim() ||
        'Version unavailable';

    return {
        name,
        installed: true,
        path: pathResult.stdout.split('\n')[0].trim(),
        version: versionLine
    };
}

/**
 * Check if the installed FFmpeg binary supports the subtitles filter (built with libass).
 */
export async function checkFfmpegSubtitlesSupport() {
    const result = await runCommandWithOutput('ffmpeg -filters');
    if (!result.ok || !result.stdout) return false;
    return /^\s*[.TSRC]{2,3}\s+subtitles\s+/m.test(result.stdout);
}

/**
 * Check system dependencies (yt-dlp, ffmpeg, and brew on macOS).
 */
export async function checkSystemDependencies() {
    try {
        const isMac = process.platform === 'darwin';
        const checkList = [
            getDependencyInfo('yt-dlp', 'yt-dlp --version'),
            getDependencyInfo('ffmpeg', 'ffmpeg -version')
        ];

        if (isMac) {
            checkList.unshift(getDependencyInfo('brew', 'brew --version'));
        }

        const dependencies = await Promise.all(checkList);
        const missing = dependencies.filter((dep) => !dep.installed).map((dep) => dep.name);

        const ffmpegDep = dependencies.find((dep) => dep.name === 'ffmpeg');
        if (ffmpegDep && ffmpegDep.installed) {
            ffmpegDep.hasSubtitlesFilter = await checkFfmpegSubtitlesSupport();
        }

        return {
            success: true,
            allInstalled: missing.length === 0,
            dependencies,
            missing,
            platform: process.platform
        };
    } catch (error) {
        return {
            success: false,
            message: error.message || 'Failed to check dependencies.'
        };
    }
}

/**
 * Automatically install missing dependencies on macOS via Homebrew.
 */
export async function installMissingDependencies(options = {}) {
    if (process.platform !== 'darwin') {
        return {
            success: false,
            message: 'Automatic installation is supported on macOS only.'
        };
    }

    try {
        const installHomebrew = Boolean(options.installHomebrew);
        let brewInfo = await getDependencyInfo('brew', 'brew --version');

        if (!brewInfo.installed) {
            if (!installHomebrew) {
                return {
                    success: false,
                    message:
                        'Homebrew is not installed. Please install it first, then restart the dependency check.'
                };
            }

            if (options.onProgress) {
                options.onProgress('Installing Homebrew...');
            }

            const brewInstallCommand =
                '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
            const brewInstallResult = await runCommandWithOutput(brewInstallCommand);
            if (!brewInstallResult.ok) {
                return {
                    success: false,
                    message:
                        brewInstallResult.stderr ||
                        brewInstallResult.error ||
                        'Failed to install Homebrew.'
                };
            }

            brewInfo = await getDependencyInfo('brew', 'brew --version');
            if (!brewInfo.installed) {
                return {
                    success: false,
                    message:
                        'Homebrew installation command finished, but brew is still not found in PATH.'
                };
            }
        }

        const ytDlpInfo = await getDependencyInfo('yt-dlp', 'yt-dlp --version');
        const ffmpegInfo = await getDependencyInfo('ffmpeg', 'ffmpeg -version');

        const missing = [];
        if (!ytDlpInfo.installed) missing.push('yt-dlp');
        if (!ffmpegInfo.installed) missing.push('ffmpeg');

        if (missing.length === 0) {
            return {
                success: true,
                installed: [],
                failed: [],
                message: 'Nothing to install.',
                dependencies: [brewInfo, ytDlpInfo, ffmpegInfo]
            };
        }

        const installed = [];
        const failed = [];
        const details = {};

        for (const dep of missing) {
            if (options.onProgress) {
                options.onProgress(`Installing ${dep} via Homebrew...`);
            }
            const cmd = `brew install ${dep}`;
            const result = await runCommandWithOutput(cmd);
            details[dep] = result;

            if (result.ok) {
                installed.push(dep);
            } else {
                failed.push(dep);
            }
        }

        const finalDependencies = await Promise.all([
            getDependencyInfo('brew', 'brew --version'),
            getDependencyInfo('yt-dlp', 'yt-dlp --version'),
            getDependencyInfo('ffmpeg', 'ffmpeg -version')
        ]);

        return {
            success: failed.length === 0,
            installed,
            failed,
            message:
                failed.length === 0
                    ? 'Installation completed.'
                    : 'Installation finished with some failures.',
            dependencies: finalDependencies,
            details
        };
    } catch (error) {
        return {
            success: false,
            message: error.message || 'Failed to install dependencies.'
        };
    }
}
