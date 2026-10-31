// Tools that an LLM agent may call. Each tool:
//  - declares a JSON-schema for its parameters (sent to the model),
//  - validates every parameter itself (the model is not trusted),
//  - builds yt-dlp / ffmpeg argument ARRAYS from validated values (never a shell string),
//  - delegates the real work to the Electron-free functions in ../core/tools.js.
//
// The download folder, cookie browser and proxy come from the user's settings (the `ctx` object),
// never from the model, so the model cannot write outside the folder the user chose.
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import {
    runYtDlp,
    getFormatInfo,
    listSubtitles,
    reEncodeToMp4,
    downloadWithHardsub,
    cancelCurrentTask
} from '../core/tools.js';
import { VIDEO_EXTENSIONS } from '../core/media-files.js';
import {
    ValidationError,
    validateUrl,
    validateLang,
    validateFormatCode,
    validateFileHint,
    validateEnum,
    validateIntRange,
    validateBool
} from './validate.js';

const noop = () => {};

const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'best'];
const MERGE_FORMATS = ['mp4', 'mkv', 'webm'];
const CODECS = ['h264', 'hevc'];
const POSITIONS = ['bottom', 'top'];

const MAX_DELETE_FILES = 20;
const MAX_LISTED_FILES = 50;

/**
 * Per-run context supplied by the app (not by the model).
 * @typedef {object} ToolContext
 * @property {string} downloadFolder  Folder the user chose. Required for anything that writes files.
 * @property {string} [browser]       Browser to read cookies from (e.g. "chrome"), or empty.
 * @property {string} [proxy]         Proxy URL (e.g. "socks5://127.0.0.1:1080/"), or empty.
 * @property {(text: string) => void} [onProgress]
 */

function requireFolder(ctx) {
    if (!ctx.downloadFolder || typeof ctx.downloadFolder !== 'string') {
        throw new ValidationError(
            'No download folder is selected. Ask the user to choose a download folder in the app first.'
        );
    }
    return ctx.downloadFolder;
}

/** Proxy and cookie arguments, in the same form the classic UI uses. */
function commonArgs(ctx) {
    const args = [];
    if (ctx.proxy) args.push('--proxy', ctx.proxy);
    if (ctx.browser) args.push('--cookies-from-browser', ctx.browser);
    return args;
}

function lastLines(text, count = 30) {
    return String(text || '').split('\n').slice(-count).join('\n').trim();
}

/** Run a yt-dlp download and capture the final file paths via a temporary manifest file. */
async function runDownload(specificArgs, url, ctx, { playlist = false } = {}) {
    const folder = requireFolder(ctx);
    const manifestFile = join(
        tmpdir(),
        `ytdl-ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`
    );

    const args = [
        ...commonArgs(ctx),
        ...(playlist ? [] : ['--no-playlist']),
        ...specificArgs,
        '--print-to-file', 'after_move:filepath', manifestFile,
        '-P', folder,
        url
    ];

    const res = await runYtDlp(args, ctx.onProgress || noop);

    let files = [];
    try {
        const content = await fs.readFile(manifestFile, 'utf8');
        files = content.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    } catch { /* manifest is only written on success */ }
    try { await fs.unlink(manifestFile); } catch { /* ignore */ }

    const toName = (p) => p.split(/[/\\]/).pop();
    return {
        ok: res.success,
        cancelled: res.cancelled,
        saved_to_folder: folder,
        files: files.map(toName),
        ...(res.success ? {} : { error: res.error }),
        output: lastLines(res.output)
    };
}

function mapMediaResult(res) {
    return {
        ok: res.success,
        cancelled: res.cancelled,
        message: res.message,
        ...(res.success ? {} : { error: res.error }),
        // The classic UI asks the user before deleting these; the agent must do the same
        // (via the confirmed delete_files tool) instead of deleting automatically.
        temporary_files: (res.tmpFiles || []).map((p) => p.split(/[/\\]/).pop())
    };
}

/** Resolve the subtitle track type for `lang`, since the model should not have to guess it. */
async function resolveSubtitle(url, lang, ctx) {
    const listing = await listSubtitles(url, ctx.browser, ctx.proxy);
    if (listing.error) {
        throw new ValidationError(`Could not list subtitles: ${listing.message}`);
    }
    const available = listing.subtitles.map((s) => `${s.code} (${s.type})`).join(', ') || 'none';
    const match = listing.subtitles.find((s) => s.code === lang);
    if (!match) {
        throw new ValidationError(
            `Subtitle language "${lang}" is not available for this video. Available: ${available}.`
        );
    }
    return match;
}

const urlProperty = {
    type: 'string',
    description: 'The http(s) URL of the video or page, exactly as given by the user.'
};

export const TOOLS = [
    {
        name: 'get_video_info',
        description: 'Get basic information (title, uploader, duration) about a video URL without downloading it.',
        risk: 'low',
        parameters: {
            type: 'object',
            properties: { url: urlProperty },
            required: ['url']
        },
        describe: (a) => `Look up video info for ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const res = await getFormatInfo([
                ...commonArgs(ctx),
                '--no-playlist',
                '--skip-download',
                '--print', '%(title)s\t%(uploader)s\t%(duration_string)s\t%(is_live)s',
                url
            ]);
            if (!res.ok) return { ok: false, error: lastLines(res.error, 10) };
            const [title, uploader, duration, isLive] = res.output.split('\n')[0].split('\t');
            return { ok: true, title, uploader, duration, is_live: isLive === 'True' };
        }
    },
    {
        name: 'list_formats',
        description:
            'List the available formats/qualities of a video (yt-dlp -F). Use this when the user wants a specific quality or format and you need the format codes.',
        risk: 'low',
        parameters: {
            type: 'object',
            properties: { url: urlProperty },
            required: ['url']
        },
        describe: (a) => `List formats for ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const res = await runYtDlp(
                [...commonArgs(ctx), '--no-playlist', '-F', url],
                ctx.onProgress || noop
            );
            return {
                ok: res.success,
                cancelled: res.cancelled,
                ...(res.success ? {} : { error: res.error }),
                output: res.output
            };
        }
    },
    {
        name: 'download_video',
        description:
            'Download a video to the user\'s download folder. By default downloads the best quality with the thumbnail embedded. Only downloads a single video unless playlist is true.',
        risk: (a) => (a.playlist === true ? 'high' : 'low'),
        parameters: {
            type: 'object',
            properties: {
                url: urlProperty,
                max_height: {
                    type: 'integer',
                    description: 'Optional maximum video height in pixels, e.g. 1080, 720 or 480. Omit for best quality.'
                },
                format_code: {
                    type: 'string',
                    description: 'Optional exact yt-dlp format code from list_formats, e.g. "137+140". Overrides max_height.'
                },
                container: {
                    type: 'string',
                    enum: MERGE_FORMATS,
                    description: 'Optional output container for merged video+audio.'
                },
                playlist: {
                    type: 'boolean',
                    description: 'Set true ONLY if the user explicitly asked to download a whole playlist.'
                }
            },
            required: ['url']
        },
        describe: (a) =>
            `Download ${a.playlist ? 'playlist' : 'video'} ${a.url}` +
            (a.max_height ? ` (max ${a.max_height}p)` : '') +
            (a.format_code ? ` (format ${a.format_code})` : ''),
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const maxHeight = validateIntRange(args.max_height, 144, 4320, 'max_height');
            const formatCode = args.format_code ? validateFormatCode(args.format_code) : undefined;
            const container = args.container
                ? validateEnum(args.container, MERGE_FORMATS, 'container')
                : undefined;
            const playlist = validateBool(args.playlist, 'playlist');

            const specific = [];
            if (formatCode) {
                specific.push('-f', formatCode);
            } else if (maxHeight) {
                specific.push('-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]`);
            }
            if (container) specific.push('--merge-output-format', container);
            specific.push('--embed-thumbnail');

            return runDownload(specific, url, ctx, { playlist });
        }
    },
    {
        name: 'download_audio',
        description: 'Download only the audio of a video and convert it to an audio format (default mp3).',
        risk: (a) => (a.playlist === true ? 'high' : 'low'),
        parameters: {
            type: 'object',
            properties: {
                url: urlProperty,
                format: {
                    type: 'string',
                    enum: AUDIO_FORMATS,
                    description: 'Audio format. "best" keeps the original audio codec. Default: mp3.'
                },
                playlist: {
                    type: 'boolean',
                    description: 'Set true ONLY if the user explicitly asked to download a whole playlist.'
                }
            },
            required: ['url']
        },
        describe: (a) => `Download audio (${a.format || 'mp3'}) from ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const format = validateEnum(args.format, AUDIO_FORMATS, 'format', 'mp3');
            const playlist = validateBool(args.playlist, 'playlist');

            const specific = ['-f', 'bestaudio/best', '-x', '--audio-format', format];
            if (format === 'mp3' || format === 'm4a') specific.push('--embed-thumbnail');

            return runDownload(specific, url, ctx, { playlist });
        }
    },
    {
        name: 'download_thumbnail',
        description: 'Download only the thumbnail image of a video.',
        risk: 'low',
        parameters: {
            type: 'object',
            properties: { url: urlProperty },
            required: ['url']
        },
        describe: (a) => `Download thumbnail of ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            return runDownload(['--write-thumbnail', '--skip-download'], url, ctx);
        }
    },
    {
        name: 'list_subtitles',
        description:
            'List the subtitle languages available for a video. Returns manual subtitles, or the original-language auto-generated captions if there are none.',
        risk: 'low',
        parameters: {
            type: 'object',
            properties: { url: urlProperty },
            required: ['url']
        },
        describe: (a) => `List subtitles for ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const res = await listSubtitles(url, ctx.browser, ctx.proxy);
            if (res.error) return { ok: false, error: res.message };
            return { ok: true, is_auto_generated: res.isAutoGenerated, subtitles: res.subtitles };
        }
    },
    {
        name: 'download_subtitles',
        description:
            'Download a subtitle file (converted to .vtt) for a video without downloading the video. Call list_subtitles first to see which language codes exist.',
        risk: 'low',
        parameters: {
            type: 'object',
            properties: {
                url: urlProperty,
                lang: { type: 'string', description: 'Subtitle language code from list_subtitles, e.g. "en".' }
            },
            required: ['url', 'lang']
        },
        describe: (a) => `Download "${a.lang}" subtitles for ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const lang = validateLang(args.lang);
            const sub = await resolveSubtitle(url, lang, ctx);
            const subsFlag = sub.type === 'manual' ? '--write-subs' : '--write-auto-subs';
            return runDownload(
                [subsFlag, '--sub-langs', sub.code, '--skip-download', '--convert-subs', 'vtt'],
                url,
                ctx
            );
        }
    },
    {
        name: 'download_with_hardsub',
        description:
            'Download a video and burn (hardcode) a subtitle language into it with ffmpeg. Slow and CPU-intensive. Call list_subtitles first to see which language codes exist.',
        risk: 'high',
        parameters: {
            type: 'object',
            properties: {
                url: urlProperty,
                lang: { type: 'string', description: 'Subtitle language code from list_subtitles, e.g. "en".' },
                codec: { type: 'string', enum: CODECS, description: 'Output video codec. Default: h264.' },
                position: {
                    type: 'string',
                    enum: POSITIONS,
                    description: 'Where to place the subtitles. Default: bottom.'
                }
            },
            required: ['url', 'lang']
        },
        describe: (a) =>
            `Download ${a.url} and hardcode "${a.lang}" subtitles (${a.codec || 'h264'}, ${a.position || 'bottom'})`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const lang = validateLang(args.lang);
            const codec = validateEnum(args.codec, CODECS, 'codec', 'h264');
            const position = validateEnum(args.position, POSITIONS, 'position', 'bottom');
            const folder = requireFolder(ctx);

            const sub = await resolveSubtitle(url, lang, ctx);
            const res = await downloadWithHardsub(
                {
                    url,
                    browser: ctx.browser,
                    proxy: ctx.proxy,
                    downloadFolder: folder,
                    subtitleLang: sub.code,
                    subtitleType: sub.type,
                    codec,
                    subtitlePosition: position
                },
                ctx.onProgress || noop
            );
            return mapMediaResult(res);
        }
    },
    {
        name: 'reencode_mp4',
        description:
            'Re-encode a video that is already in the download folder to a high-quality, widely compatible MP4 (H.264/AAC) with ffmpeg. Slow. If the source is already an .mp4 it is replaced by the re-encoded file.',
        risk: 'high',
        parameters: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    description: 'File name (or unique part of it, e.g. the video ID) of a video from list_downloads.'
                }
            },
            required: ['file']
        },
        describe: (a) => `Re-encode "${a.file}" to MP4 (H.264/AAC); an existing .mp4 of the same name is replaced`,
        async run(args, ctx) {
            const file = validateFileHint(args.file);
            const folder = requireFolder(ctx);
            const res = await reEncodeToMp4(folder, file, ctx.onProgress || noop);
            return mapMediaResult(res);
        }
    },
    {
        name: 'list_downloads',
        description:
            'List the most recent files in the download folder (name, size, modified time). Use it to find exact file names before re-encoding or deleting.',
        risk: 'low',
        parameters: { type: 'object', properties: {} },
        describe: () => 'List files in the download folder',
        async run(_args, ctx) {
            const folder = requireFolder(ctx);
            let entries;
            try {
                entries = await fs.readdir(folder, { withFileTypes: true });
            } catch (e) {
                return { ok: false, error: `Cannot read the download folder: ${e.message}` };
            }
            const files = [];
            for (const entry of entries) {
                if (!entry.isFile() || entry.name.startsWith('.')) continue;
                try {
                    const stat = await fs.stat(join(folder, entry.name));
                    files.push({
                        name: entry.name,
                        size_mb: Math.round((stat.size / 1024 / 1024) * 10) / 10,
                        modified: new Date(stat.mtimeMs).toISOString(),
                        is_video: VIDEO_EXTENSIONS.includes(extname(entry.name).toLowerCase()),
                        mtimeMs: stat.mtimeMs
                    });
                } catch { /* file vanished, skip */ }
            }
            files.sort((a, b) => b.mtimeMs - a.mtimeMs);
            const shown = files
                .slice(0, MAX_LISTED_FILES)
                .map(({ name, size_mb, modified, is_video }) => ({ name, size_mb, modified, is_video }));
            return { ok: true, folder, total_files: files.length, files: shown };
        }
    },
    {
        name: 'delete_files',
        description:
            'Delete files from the download folder by exact file name (e.g. leftover temporary files reported by another tool). Only deletes regular files inside the download folder.',
        risk: 'high',
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: `Exact file names (max ${MAX_DELETE_FILES}), as reported by list_downloads or other tools.`
                }
            },
            required: ['files']
        },
        describe: (a) => `Delete ${Array.isArray(a.files) ? a.files.length : '?'} file(s): ${
            Array.isArray(a.files) ? a.files.join(', ') : ''
        }`,
        async run(args, ctx) {
            const folder = requireFolder(ctx);
            if (!Array.isArray(args.files) || args.files.length === 0 || args.files.length > MAX_DELETE_FILES) {
                throw new ValidationError(`"files" must be a list of 1 to ${MAX_DELETE_FILES} file names.`);
            }
            const names = args.files.map((f) => validateFileHint(f, 'files[]'));
            const deleted = [];
            const skipped = [];
            for (const name of names) {
                const full = join(folder, name);
                try {
                    const stat = await fs.lstat(full);
                    if (!stat.isFile()) {
                        skipped.push(`${name} (not a regular file)`);
                        continue;
                    }
                    await fs.unlink(full);
                    deleted.push(name);
                } catch (e) {
                    skipped.push(`${name} (${e.code === 'ENOENT' ? 'not found' : e.message})`);
                }
            }
            return { ok: true, deleted, skipped };
        }
    },
    {
        name: 'cancel_task',
        description: 'Cancel the download or encoding that is currently running.',
        risk: 'low',
        parameters: { type: 'object', properties: {} },
        describe: () => 'Cancel the running task',
        async run() {
            return { ok: true, cancelled: cancelCurrentTask() };
        }
    }
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
    return TOOL_BY_NAME.get(name);
}

/** Resolve a tool's risk level for the given arguments ('low' | 'high'). */
export function getRisk(tool, args) {
    return typeof tool.risk === 'function' ? tool.risk(args || {}) : tool.risk;
}

/** Tool declarations in the neutral shape that providers translate to their own API format. */
export function getToolDeclarations() {
    return TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

