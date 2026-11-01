/* global process */

import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-aarch64-apple-darwin.zip'
    },
    'darwin-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-x86_64-apple-darwin.zip'
    },
    'mac-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-aarch64-apple-darwin.zip'
    },
    'mac-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-x86_64-apple-darwin.zip'
    },
    'linux-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_linux_aarch64',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-aarch64-unknown-linux-gnu.zip',
        ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz'
    },
    'linux-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_linux',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-x86_64-unknown-linux-gnu.zip',
        ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz'
    },
    'win32-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-x86_64-pc-windows-msvc.zip'
    },
    'win32-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-aarch64-pc-windows-msvc.zip'
    },
    'win-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-x86_64-pc-windows-msvc.zip'
    },
    'win-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe',
        deno: 'https://github.com/denoland/deno/releases/download/v{deno}/deno-aarch64-pc-windows-msvc.zip'
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

async function extractArchive(archivePath, destination) {
    if (archivePath.endsWith('.tar.xz') || archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tar')) {
        await execFileAsync('tar', ['-xf', archivePath, '-C', destination]);
    } else if (archivePath.endsWith('.zip')) {
        try {
            await execFileAsync('unzip', ['-q', archivePath, '-d', destination]);
        } catch {
            await execFileAsync('tar', ['-xf', archivePath, '-C', destination]);
        }
    }
}

async function findBinary(directory, binaryName) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            const found = await findBinary(fullPath, binaryName);
            if (found) return found;
        } else if (entry.name === binaryName) {
            return fullPath;
        }
    }
    return null;
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const ytDlpPath = join(outputDir, isWindowsTarget ? 'yt-dlp.exe' : 'yt-dlp');
await download(targetInfo.ytDlp.replace('{yt}', versions['yt-dlp']), ytDlpPath);

if (!isWindowsTarget) {
    await chmod(ytDlpPath, 0o755);
}

if (targetInfo.ffmpeg) {
    const ext = targetInfo.ffmpeg.endsWith('.zip') ? '.zip' : '.tar.xz';
    const archivePath = join(outputDir, `ffmpeg-archive${ext}`);
    const tempExtractDir = join(outputDir, '_ffmpeg_extracted');
    await rm(tempExtractDir, { recursive: true, force: true });
    await mkdir(tempExtractDir, { recursive: true });
    await download(targetInfo.ffmpeg, archivePath);
    await extractArchive(archivePath, tempExtractDir);
    await rm(archivePath, { force: true });

    for (const bin of ['ffmpeg', 'ffprobe']) {
        const binName = isWindowsTarget ? `${bin}.exe` : bin;
        const found = await findBinary(tempExtractDir, binName);
        if (!found) throw new Error(`Could not find ${binName} in extracted FFmpeg archive`);
        const dest = join(outputDir, binName);
        await copyFile(found, dest);
        if (!isWindowsTarget) {
            await chmod(dest, 0o755);
        }
    }
    await rm(tempExtractDir, { recursive: true, force: true });
}

if (targetInfo.deno && versions.deno) {
    const archivePath = join(outputDir, 'deno-archive.zip');
    const tempExtractDir = join(outputDir, '_deno_extracted');
    await rm(tempExtractDir, { recursive: true, force: true });
    await mkdir(tempExtractDir, { recursive: true });
    await download(targetInfo.deno.replace('{deno}', versions.deno), archivePath);
    await extractArchive(archivePath, tempExtractDir);
    await rm(archivePath, { force: true });

    const binName = isWindowsTarget ? 'deno.exe' : 'deno';
    const found = await findBinary(tempExtractDir, binName);
    if (!found) throw new Error(`Could not find ${binName} in extracted Deno archive`);
    const dest = join(outputDir, binName);
    await copyFile(found, dest);
    if (!isWindowsTarget) {
        await chmod(dest, 0o755);
    }
    await rm(tempExtractDir, { recursive: true, force: true });
}

await writeFile(join(outputDir, 'yt-dlp-manifest.json'), JSON.stringify({
    'yt-dlp': versions['yt-dlp'],
    'deno': versions.deno || null,
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

    const availableFiles = await readdir(outputDir);
    for (const bin of ['ffmpeg', 'ffprobe', 'deno']) {
        const binName = isWindowsTarget ? `${bin}.exe` : bin;
        if (availableFiles.includes(binName)) {
            const src = join(outputDir, binName);
            const altBinPath = join(altDir, binName);
            await copyFile(src, altBinPath);
            if (!isWindowsTarget) {
                await chmod(altBinPath, 0o755);
            }
        }
    }

    await writeFile(join(altDir, 'yt-dlp-manifest.json'), JSON.stringify({
        'yt-dlp': versions['yt-dlp'],
        'deno': versions.deno || null,
        target: altTarget
    }, null, 2));
}

process.stdout.write(`Prepared ${target} tool bundle in ${outputDir}\n`);
