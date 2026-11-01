// Tools built on ffmpeg (slow and CPU-intensive, so they always need confirmation by default).
import { reEncodeToMp4, downloadWithHardsub } from '../../core/tools.js';
import { requireFolder } from '../context.js';
import { validateUrl, validateLang, validateFileHint, validateEnum } from '../validate.js';
import { TOOL_NAMES } from './names.js';
import { defineTool, mediaOutcome, progressOf, resolveSubtitle, urlProperty } from './common.js';

const CODECS = ['h264', 'hevc'];
const POSITIONS = ['bottom', 'top'];

export const mediaTools = [
    defineTool({
        name: TOOL_NAMES.downloadWithHardsub,
        description:
            'Download a video and burn (hardcode) a subtitle language into it with ffmpeg. Slow and CPU-intensive. Call list_subtitles first to see which language codes exist.',
        risk: 'high',
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
        required: ['url', 'lang'],
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
                progressOf(ctx)
            );
            return mediaOutcome(res);
        }
    }),
    defineTool({
        name: TOOL_NAMES.reencodeMp4,
        description:
            'Re-encode a video that is already in the download folder to a high-quality, widely compatible MP4 (H.264/AAC) with ffmpeg. Slow. If the source is already an .mp4 it is replaced by the re-encoded file.',
        risk: 'high',
        properties: {
            file: {
                type: 'string',
                description: 'File name (or unique part of it, e.g. the video ID) of a video from list_downloads.'
            }
        },
        required: ['file'],
        describe: (a) => `Re-encode "${a.file}" to MP4 (H.264/AAC); an existing .mp4 of the same name is replaced`,
        async run(args, ctx) {
            const file = validateFileHint(args.file);
            const folder = requireFolder(ctx);
            return mediaOutcome(await reEncodeToMp4(folder, file, progressOf(ctx)));
        }
    })
];
