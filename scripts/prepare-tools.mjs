/* global process */

import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const versions = JSON.parse(await readFile(join(root, 'tools-versions.json'), 'utf8'));
const target = process.env.TOOL_TARGET || `${platform}-${arch}`;
const outputDir = join(root, 'build-tools', target);
const isWindowsTarget = target.startsWith('win32-') || target.startsWith('win-');

const targets = {
    'darwin-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos'
    },
    'darwin-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos'
    },
    'mac-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos'
    },
    'mac-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos'
    },
    'linux-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_linux_aarch64'
    },
    'linux-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_linux'
    },
    'win32-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe'
    },
    'win32-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe'
    },
    'win-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe'
    },
    'win-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe'
    }
};

const targetInfo = targets[target];
if (!targetInfo) throw new Error(`Unsupported tool bundle target: ${target}`);

async function download(url, destination) {
    await rm(destination, { force: true });
    try {
        await execFileAsync('curl', [
            '--fail',
            '--location',
            '--retry', '5',
            '--retry-delay', '3',
            '--retry-all-errors',
            '--connect-timeout', '30',
            '--max-time', '600',
            '--user-agent', 'yt-downloader-electron-build',
            '--output', destination,
            url
        ], { maxBuffer: 1024 * 1024 });
    } catch (error) {
        const detail = error.stderr?.trim() || error.message;
        throw new Error(`Failed to download ${url}: ${detail}`, { cause: error });
    }
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const ytDlpPath = join(outputDir, isWindowsTarget ? 'yt-dlp.exe' : 'yt-dlp');
await download(targetInfo.ytDlp.replace('{yt}', versions['yt-dlp']), ytDlpPath);

if (!isWindowsTarget) {
    await chmod(ytDlpPath, 0o755);
}
await writeFile(join(outputDir, 'yt-dlp-manifest.json'), JSON.stringify({
    'yt-dlp': versions['yt-dlp'],
    target
}, null, 2));

let altTarget = null;
if (target.startsWith('win32-')) {
    altTarget = `win-${target.slice(6)}`;
} else if (target.startsWith('win-')) {
    altTarget = `win32-${target.slice(4)}`;
} else if (target.startsWith('darwin-')) {
    altTarget = `mac-${target.slice(7)}`;
} else if (target.startsWith('mac-')) {
    altTarget = `darwin-${target.slice(4)}`;
}

if (altTarget) {
    const altDir = join(root, 'build-tools', altTarget);
    await rm(altDir, { recursive: true, force: true });
    await mkdir(altDir, { recursive: true });
    const altYtDlpPath = join(altDir, isWindowsTarget ? 'yt-dlp.exe' : 'yt-dlp');
    await copyFile(ytDlpPath, altYtDlpPath);
    if (!isWindowsTarget) {
        await chmod(altYtDlpPath, 0o755);
    }
    await writeFile(join(altDir, 'yt-dlp-manifest.json'), JSON.stringify({
        'yt-dlp': versions['yt-dlp'],
        target: altTarget
    }, null, 2));
}

process.stdout.write(`Prepared ${target} tool bundle in ${outputDir}\n`);
