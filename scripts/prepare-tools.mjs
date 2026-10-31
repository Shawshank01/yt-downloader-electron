import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { request } from 'node:https';
import { platform, arch } from 'node:process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(await readFile(join(root, 'tools-versions.json'), 'utf8'));
const target = `${platform}-${arch}`;
const outputDir = join(root, 'build-tools', target);

const targets = {
    'darwin-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos',
        ffmpeg: 'https://evermeet.cx/ffmpeg/getrelease/zip'
    },
    'darwin-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_macos',
        ffmpeg: 'https://evermeet.cx/ffmpeg/getrelease/zip'
    },
    'linux-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_linux_aarch64',
        ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz'
    },
    'linux-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp_linux',
        ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz'
    },
    'win32-x64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe',
        ffmpeg: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    },
    'win32-arm64': {
        ytDlp: 'https://github.com/yt-dlp/yt-dlp/releases/download/{yt}/yt-dlp.exe',
        ffmpeg: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-winarm64-gpl.zip'
    }
};

const targetInfo = targets[target];
if (!targetInfo) throw new Error(`Unsupported tool bundle target: ${target}`);

function download(url, destination) {
    return new Promise((resolve, reject) => {
        const follow = (currentUrl) => {
            request(currentUrl, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    follow(new URL(response.headers.location, currentUrl));
                    return;
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`Download failed (${response.statusCode}): ${currentUrl}`));
                    return;
                }
                pipeline(response, createWriteStream(destination)).then(resolve, reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const ytDlpPath = join(outputDir, platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
await download(targetInfo.ytDlp.replace('{yt}', versions['yt-dlp']), ytDlpPath);

const archiveExtension = platform === 'linux' ? '.tar.xz' : '.zip';
const archivePath = join(outputDir, `ffmpeg-archive${archiveExtension}`);
await download(targetInfo.ffmpeg, archivePath);
const extract = platform === 'win32'
    ? ['-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outputDir}' -Force`]
    : platform === 'darwin'
        ? ['-q', archivePath, '-d', outputDir]
        : ['-xf', archivePath, '-C', outputDir];
const command = platform === 'win32' ? 'powershell' : platform === 'darwin' ? 'unzip' : 'tar';
const { spawn } = await import('node:child_process');
await new Promise((resolve, reject) => {
    const child = spawn(command, extract, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});
await rm(archivePath);

const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const findBinary = async (directory) => {
    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            const result = await findBinary(path);
            if (result) return result;
        } else if (entry.name === ffmpegName) {
            return path;
        }
    }
    return null;
};
const extractedFfmpeg = await findBinary(outputDir);
if (!extractedFfmpeg) throw new Error(`Could not find ${ffmpegName} in downloaded archive`);
const finalFfmpegPath = join(outputDir, ffmpegName);
if (extractedFfmpeg !== finalFfmpegPath) {
    const { rename } = await import('node:fs/promises');
    await rename(extractedFfmpeg, finalFfmpegPath);
}
if (platform !== 'win32') {
    await chmod(ytDlpPath, 0o755);
    await chmod(finalFfmpegPath, 0o755);
}
await writeFile(join(outputDir, 'manifest.json'), JSON.stringify({ ...versions, target }, null, 2));
console.log(`Prepared ${target} tool bundle in ${outputDir}`);
