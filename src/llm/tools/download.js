// Tools that download media or sidecar files into the user's download folder.
import {
    validateUrl,
    validateLang,
    validateFormatCode,
    validateEnum,
    validateIntRange,
    validateBool
} from '../validate.js';
import { TOOL_NAMES } from './names.js';
import { defineTool, playlistProperty, playlistRisk, resolveSubtitle, runDownload, urlProperty } from './common.js';

const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'best'];
const MERGE_FORMATS = ['mp4', 'mkv', 'webm'];

const langProperty = { type: 'string', description: 'Subtitle language code from list_subtitles, e.g. "en".' };

export const downloadTools = [
    defineTool({
        name: TOOL_NAMES.downloadVideo,
        description:
            'Download a video to the user\'s download folder with thumbnail embedded. Can download specific quality (max_height), specific format codes from list_formats (format_code), or specific container (e.g. container: "mp4" for direct native MP4 without re-encoding). Only downloads a single video unless playlist is true.',
        risk: playlistRisk,
        properties: {
            url: urlProperty,
            max_height: {
                type: 'integer',
                description: 'Optional maximum video height in pixels, e.g. 1080, 720 or 480. Omit for best quality.'
            },
            format_code: {
                type: 'string',
                description: 'Optional exact yt-dlp format code from list_formats, e.g. "299+140" or "137+140" (prefer avc1+m4a for broad device compatibility). Overrides max_height.'
            },
            container: {
                type: 'string',
                enum: MERGE_FORMATS,
                description: 'Optional output container. Default: "mp4". When "mp4", automatically favors universally compatible H.264 (avc1) video and AAC (mp4a) audio streams without re-encoding.'
            },
            playlist: playlistProperty
        },
        required: ['url'],
        describe: (a) =>
            `Download ${a.playlist ? 'playlist' : 'video'} ${a.url}` +
            (a.max_height ? ` (max ${a.max_height}p)` : '') +
            (a.format_code ? ` (format ${a.format_code})` : '') +
            (a.container ? ` [${a.container}]` : ''),
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const maxHeight = validateIntRange(args.max_height, 144, 4320, 'max_height');
            const formatCode = args.format_code ? validateFormatCode(args.format_code) : undefined;
            const container = args.container
                ? validateEnum(args.container, MERGE_FORMATS, 'container')
                : 'mp4';
            const playlist = validateBool(args.playlist, 'playlist');

            const specific = [];
            if (formatCode) {
                specific.push('-f', formatCode);
            } else if (container === 'mp4') {
                if (maxHeight) {
                    specific.push(
                        '-f',
                        `bv*[height<=${maxHeight}][vcodec^=avc]+ba[acodec^=mp4a]/` +
                        `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/` +
                        `b[height<=${maxHeight}][ext=mp4]/` +
                        `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]`
                    );
                } else {
                    specific.push(
                        '-f',
                        'bv*[vcodec^=avc]+ba[acodec^=mp4a]/' +
                        'bv*[ext=mp4]+ba[ext=m4a]/' +
                        'b[ext=mp4]/' +
                        'bv*+ba/b'
                    );
                }
            } else if (maxHeight) {
                specific.push('-f', `bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]`);
            }

            if (container) {
                specific.push('--merge-output-format', container);
                specific.push('--remux-video', container);
                if (container === 'mp4') {
                    specific.push('--format-sort', 'res,vcodec:h264,ext:mp4:m4a');
                }
            }

            if (container !== 'webm') {
                specific.push('--convert-thumbnails', 'jpg', '--embed-thumbnail');
            }

            return runDownload(specific, url, ctx, { playlist });
        }
    }),
    defineTool({
        name: TOOL_NAMES.downloadAudio,
        description: 'Download only the audio of a video and convert it to an audio format (default mp3).',
        risk: playlistRisk,
        properties: {
            url: urlProperty,
            format: {
                type: 'string',
                enum: AUDIO_FORMATS,
                description: 'Audio format. "best" keeps the original audio codec. Default: mp3.'
            },
            playlist: playlistProperty
        },
        required: ['url'],
        describe: (a) => `Download audio (${a.format || 'mp3'}) from ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            const format = validateEnum(args.format, AUDIO_FORMATS, 'format', 'mp3');
            const playlist = validateBool(args.playlist, 'playlist');

            const specific = ['-f', 'bestaudio/best', '-x', '--audio-format', format];
            if (format === 'mp3' || format === 'm4a') {
                specific.push('--convert-thumbnails', 'jpg', '--embed-thumbnail');
            }

            return runDownload(specific, url, ctx, { playlist });
        }
    }),
    defineTool({
        name: TOOL_NAMES.downloadThumbnail,
        description: 'Download only the thumbnail image of a video.',
        properties: { url: urlProperty },
        required: ['url'],
        describe: (a) => `Download thumbnail of ${a.url}`,
        async run(args, ctx) {
            const url = validateUrl(args.url);
            return runDownload(['--write-thumbnail', '--skip-download'], url, ctx);
        }
    }),
    defineTool({
        name: TOOL_NAMES.downloadSubtitles,
        description:
            'Download a subtitle file (converted to .vtt) for a video without downloading the video. Call list_subtitles first to see which language codes exist.',
        properties: { url: urlProperty, lang: langProperty },
        required: ['url', 'lang'],
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
    })
];
