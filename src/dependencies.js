import { exec, execSync } from 'child_process';
import { delimiter, join } from 'path';
import fs from 'fs';

/**
 * Get known standard binary directories across all environments.
 * Covers MacPorts, Homebrew, user paths, Linux package managers, and Windows paths.
 */
export function getGlobalExtraPaths() {
    const home = process.env.HOME || '';
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        const userProfile = process.env.USERPROFILE || '';
        const programFiles = process.env.ProgramFiles || '';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
        const programData = process.env.ALLUSERSPROFILE || process.env.ProgramData || '';
        return [
            localAppData ? `${localAppData}\\Microsoft\\WinGet\\Links` : '',
            userProfile ? `${userProfile}\\scoop\\shims` : '',
            programData ? `${programData}\\chocolatey\\bin` : '',
            programFiles ? `${programFiles}\\ffmpeg\\bin` : '',
            programFilesX86 ? `${programFilesX86}\\ffmpeg\\bin` : ''
        ].filter(Boolean);
    }

    return [
        // MacPorts
        '/opt/local/bin',
        '/opt/local/sbin',
        // Homebrew (Apple Silicon & Intel)
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/opt/homebrew/opt/ffmpeg-full/bin',
        '/opt/homebrew/opt/ffmpeg/bin',
        '/usr/local/bin',
        '/usr/local/sbin',
        '/usr/local/opt/ffmpeg-full/bin',
        '/usr/local/opt/ffmpeg/bin',
        // User paths (pip, pipx, cargo, custom binaries)
        home ? `${home}/.local/bin` : '',
        home ? `${home}/bin` : '',
        home ? `${home}/.cargo/bin` : '',
        // System paths
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
        '/Library/Apple/usr/bin',
        // Linux package managers / Nix
        '/snap/bin',
        '/var/lib/flatpak/exports/bin',
        home ? `${home}/.local/share/flatpak/exports/bin` : '',
        '/nix/var/nix/profiles/default/bin',
        home ? `${home}/.nix-profile/bin` : '',
        '/run/current-system/sw/bin'
    ].filter(Boolean);
}

/**
 * Retrieve system PATH entries from macOS path_helper files (/etc/paths and /etc/paths.d).
 */
function getSystemPathsFromMacHelper() {
    if (process.platform !== 'darwin') return [];
    const paths = [];
    try {
        if (fs.existsSync('/etc/paths')) {
            const content = fs.readFileSync('/etc/paths', 'utf-8');
            paths.push(...content.split('\n').map((l) => l.trim()).filter(Boolean));
        }
        if (fs.existsSync('/etc/paths.d')) {
            const files = fs.readdirSync('/etc/paths.d');
            for (const file of files) {
                const filePath = `/etc/paths.d/${file}`;
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    paths.push(...content.split('\n').map((l) => l.trim()).filter(Boolean));
                } catch {
                    // Ignore unreadable entries
                }
            }
        }
    } catch {
        // Ignore errors
    }
    return paths;
}

/**
 * Query the login shell for user-defined PATH on macOS / Linux.
 */
function getUserShellPaths() {
    if (process.platform === 'win32') return [];
    try {
        const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
        const output = execSync(`${shell} -l -c 'printf "%s" "$PATH"'`, {
            encoding: 'utf-8',
            timeout: 1500,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        return output.split(delimiter).map((p) => p.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Configure process.env.PATH globally so child processes find tools across any package manager.
 */
export function setupEnvironmentPaths() {
    const extraPaths = getGlobalExtraPaths();
    const systemMacPaths = getSystemPathsFromMacHelper();
    const userShellPaths = getUserShellPaths();
    const currentPaths = (process.env.PATH || '').split(delimiter).map((p) => p.trim()).filter(Boolean);

    const combined = [
        ...new Set([
            ...currentPaths,
            ...userShellPaths,
            ...extraPaths,
            ...systemMacPaths
        ])
    ].filter(Boolean);

    process.env.PATH = combined.join(delimiter);
    return process.env.PATH;
}

// Initialize PATH immediately on module load
setupEnvironmentPaths();

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
 * Find absolute path of an executable across PATH and known candidate directories globally.
 */
export async function findExecutable(name) {
    setupEnvironmentPaths();

    // 1. Try 'which' (or 'where' on Windows)
    const checkCommand = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    const result = await runCommandWithOutput(checkCommand);
    if (result.ok && result.stdout) {
        const firstLine = result.stdout.split('\n')[0].trim();
        if (firstLine && fs.existsSync(firstLine)) {
            return firstLine;
        }
    }

    // 2. Direct directory scan fallback
    const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = join(dir, `${name}${ext}`);
            try {
                if (fs.existsSync(candidate)) {
                    if (process.platform !== 'win32') {
                        fs.accessSync(candidate, fs.constants.X_OK);
                    }
                    return candidate;
                }
            } catch {
                // Not accessible or not executable
            }
        }
    }

    return null;
}

/**
 * Check if a CLI binary exists on the system globally and fetch its version.
 */
export async function getDependencyInfo(name, versionCommand) {
    const execPath = await findExecutable(name);
    if (!execPath) {
        return {
            name,
            installed: false,
            path: '',
            version: ''
        };
    }

    let cmdToRun = versionCommand;
    if (versionCommand) {
        const regex = new RegExp(`^${name}\\b`);
        if (regex.test(versionCommand)) {
            cmdToRun = versionCommand.replace(regex, `"${execPath}"`);
        }
    } else {
        cmdToRun = `"${execPath}" --version`;
    }

    let versionResult = await runCommandWithOutput(cmdToRun);
    if (!versionResult.ok && cmdToRun !== versionCommand && versionCommand) {
        versionResult = await runCommandWithOutput(versionCommand);
    }

    const versionLine =
        versionResult.stdout.split('\n')[0]?.trim() ||
        versionResult.stderr.split('\n')[0]?.trim() ||
        'Version unavailable';

    return {
        name,
        installed: true,
        path: execPath,
        version: versionLine
    };
}

/**
 * Check if the installed FFmpeg binary supports the subtitles filter (built with libass).
 */
export async function checkFfmpegSubtitlesSupport(ffmpegPath = 'ffmpeg') {
    const cmd = ffmpegPath && ffmpegPath !== 'ffmpeg' ? `"${ffmpegPath}" -filters` : 'ffmpeg -filters';
    let result = await runCommandWithOutput(cmd);
    if (!result.ok && cmd !== 'ffmpeg -filters') {
        result = await runCommandWithOutput('ffmpeg -filters');
    }
    if (!result.ok || !result.stdout) return false;
    return /^\s*[.TSRC]{2,3}\s+subtitles\s+/m.test(result.stdout);
}

/**
 * Detect available package managers globally across platforms.
 */
export async function detectPackageManagers() {
    const managers = {};
    if (process.platform === 'darwin') {
        const [portInfo, brewInfo] = await Promise.all([
            getDependencyInfo('port', 'port version'),
            getDependencyInfo('brew', 'brew --version')
        ]);
        managers.port = portInfo;
        managers.brew = brewInfo;
    } else if (process.platform === 'win32') {
        const [wingetInfo, chocoInfo, scoopInfo] = await Promise.all([
            getDependencyInfo('winget', 'winget --version'),
            getDependencyInfo('choco', 'choco --version'),
            getDependencyInfo('scoop', 'scoop --version')
        ]);
        managers.winget = wingetInfo;
        managers.choco = chocoInfo;
        managers.scoop = scoopInfo;
    } else {
        const [aptInfo, pacmanInfo, dnfInfo] = await Promise.all([
            getDependencyInfo('apt', 'apt --version'),
            getDependencyInfo('pacman', 'pacman --version'),
            getDependencyInfo('dnf', 'dnf --version')
        ]);
        managers.apt = aptInfo;
        managers.pacman = pacmanInfo;
        managers.dnf = dnfInfo;
    }
    return managers;
}

/**
 * Check required system dependencies (yt-dlp and ffmpeg) globally regardless of package source.
 */
export async function checkSystemDependencies() {
    try {
        setupEnvironmentPaths();

        const dependencies = await Promise.all([
            getDependencyInfo('yt-dlp', 'yt-dlp --version'),
            getDependencyInfo('ffmpeg', 'ffmpeg -version')
        ]);

        const missing = dependencies.filter((dep) => !dep.installed).map((dep) => dep.name);

        const ffmpegDep = dependencies.find((dep) => dep.name === 'ffmpeg');
        if (ffmpegDep && ffmpegDep.installed) {
            ffmpegDep.hasSubtitlesFilter = await checkFfmpegSubtitlesSupport(ffmpegDep.path || 'ffmpeg');
        }

        const packageManagers = await detectPackageManagers();

        return {
            success: true,
            allInstalled: missing.length === 0,
            dependencies,
            missing,
            packageManagers,
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
 * Automatically install missing dependencies on macOS via Homebrew if selected.
 */
export async function installMissingDependencies(options = {}) {
    if (process.platform !== 'darwin') {
        return {
            success: false,
            message: 'Automatic installation is supported on macOS only.'
        };
    }

    try {
        setupEnvironmentPaths();
        const installHomebrew = Boolean(options.installHomebrew);
        let brewInfo = await getDependencyInfo('brew', 'brew --version');

        if (!brewInfo.installed) {
            if (!installHomebrew) {
                return {
                    success: false,
                    message:
                        'Homebrew is not installed. Please install it first, or install missing dependencies manually via MacPorts or your preferred source.'
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

            setupEnvironmentPaths();
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
                message: 'All dependencies are already installed.',
                dependencies: [ytDlpInfo, ffmpegInfo]
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

        setupEnvironmentPaths();
        const finalDependencies = await Promise.all([
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
