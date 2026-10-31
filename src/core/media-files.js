import { join, extname, basename } from 'path';
import { promises as fs } from 'fs';

// Supported video file extensions for transcoding and discovery
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v'];

// Supported image extensions for video thumbnails
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.webp', '.png'];

// Find matching thumbnail file using exact basename match or basename prefix
export function findMatchingThumbnail(files, baseName) {
    const fileNames = files.map((f) => (typeof f === 'string' ? f : f.file));

    // Priority 1: Exact basename match (e.g., "title.jpg", "title.webp")
    for (const ext of IMAGE_EXTENSIONS) {
        const exact = `${baseName}${ext}`;
        if (fileNames.includes(exact)) {
            return exact;
        }
    }

    // Priority 2: File begins with baseName and has an image extension
    const basePrefix = `${baseName}.`;
    for (const name of fileNames) {
        const lower = name.toLowerCase();
        if ((name.startsWith(basePrefix) || name.startsWith(baseName)) &&
            IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
            return name;
        }
    }

    return null;
}

// Find video and thumbnail files for re-encoding
export async function findVideoToReEncode(downloadFolder, targetIdentifier) {
    const allFiles = await fs.readdir(downloadFolder);

    // Case 1: targetIdentifier matches a specific existing file in downloadFolder
    const directMatch = allFiles.find((f) => f === targetIdentifier || join(downloadFolder, f) === targetIdentifier);
    if (directMatch) {
        const filePath = join(downloadFolder, directMatch);
        const fileExt = extname(directMatch);
        const filename = basename(directMatch, fileExt);
        const thumbnailFile = findMatchingThumbnail(allFiles, filename);
        const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;
        return { file: directMatch, filePath, filename, thumbnailPath };
    }

    // Case 2: Match by video ID or name fragment
    const candidates = allFiles.filter((file) => {
        const lower = file.toLowerCase();
        return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext)) &&
            (!targetIdentifier || file.includes(targetIdentifier));
    });

    if (candidates.length === 0) return null;

    // If multiple candidates exist, sort only candidate files by mtime descending to get the most recent
    let chosenFile = candidates[0];
    if (candidates.length > 1) {
        const candidatesWithStats = await Promise.all(
            candidates.map(async (file) => {
                const stat = await fs.stat(join(downloadFolder, file));
                return { file, mtime: stat.mtimeMs };
            })
        );
        candidatesWithStats.sort((a, b) => b.mtime - a.mtime);
        chosenFile = candidatesWithStats[0].file;
    }

    const filePath = join(downloadFolder, chosenFile);
    const fileExt = extname(chosenFile);
    const filename = basename(chosenFile, fileExt);
    const thumbnailFile = findMatchingThumbnail(allFiles, filename);
    const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;

    return { file: chosenFile, filePath, filename, thumbnailPath };
}

// Find media, subtitles, and thumbnail for hardsubbing
export async function findHardsubSourceFiles(downloadFolder, subtitleLang, downloadedFilePath = null) {
    const allFiles = await fs.readdir(downloadFolder);

    let videoFile = null;
    if (downloadedFilePath) {
        const candidate = basename(downloadedFilePath);
        if (allFiles.includes(candidate)) {
            videoFile = candidate;
        }
    }

    // Fallback: search candidate video files in downloadFolder, statting only candidates
    if (!videoFile) {
        const candidates = allFiles.filter((file) => {
            const lower = file.toLowerCase();
            return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext)) && !file.includes('_hardsub');
        });

        if (candidates.length === 0) return null;

        if (candidates.length === 1) {
            videoFile = candidates[0];
        } else {
            const candidatesWithStats = await Promise.all(
                candidates.map(async (file) => {
                    const stat = await fs.stat(join(downloadFolder, file));
                    return { file, mtime: stat.mtimeMs };
                })
            );
            candidatesWithStats.sort((a, b) => b.mtime - a.mtime);
            videoFile = candidatesWithStats[0].file;
        }
    }

    const videoExt = extname(videoFile);
    const videoName = basename(videoFile, videoExt);

    // Locate matching subtitle file deterministically:
    // 1. Exact: ${videoName}.${subtitleLang}.vtt
    // 2. Subtitle starting with ${videoName} and containing subtitleLang
    // 3. Base: ${videoName}.vtt
    // 4. Any vtt starting with ${videoName}
    let subtitleFile = null;
    const exactSub = `${videoName}.${subtitleLang}.vtt`;
    if (allFiles.includes(exactSub)) {
        subtitleFile = exactSub;
    } else {
        const videoSubCandidates = allFiles.filter((f) => f.startsWith(videoName) && f.endsWith('.vtt'));
        if (videoSubCandidates.length > 0) {
            const langMatch = videoSubCandidates.find((f) => f.includes(subtitleLang));
            subtitleFile = langMatch || videoSubCandidates[0];
        }
    }

    if (!subtitleFile) return null;

    const thumbnailFile = findMatchingThumbnail(allFiles, videoName);

    const videoPath = join(downloadFolder, videoFile);
    const subtitlePath = join(downloadFolder, subtitleFile);
    const thumbnailPath = thumbnailFile ? join(downloadFolder, thumbnailFile) : null;

    return { videoFile, videoPath, subtitlePath, thumbnailPath, videoName };
}
