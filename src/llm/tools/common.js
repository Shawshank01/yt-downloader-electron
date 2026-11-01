// Helpers shared by the tool definitions.
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { runYtDlp, listSubtitles } from '../../core/tools.js';
import { ValidationError } from '../validate.js';
import { requireFolder } from '../context.js';

const noop = () => { };

/**
 * Per-run context supplied by the app (not by the model).
 * @typedef {object} ToolContext
 * @property {string} downloadFolder  Folder the user chose. Required for anything that writes files.
 * @property {string} [browser]       Browser to read cookies from (e.g. "chrome"), or empty.
 * @property {string} [proxy]         Proxy URL (e.g. "socks5://127.0.0.1:1080/"), or empty.
 * @property {(text: string) => void} [onProgress]
 */

/**
 * Declare a tool.
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description    Shown to the model.
 * @param {'low'|'high'|((args: object) => 'low'|'high')} [spec.risk]  Default 'low'.
 * @param {object} [spec.properties]   JSON-schema properties of the parameters.
 * @param {string[]} [spec.required]
 * @param {(args: object) => string} spec.describe  Human-readable summary shown in the UI.
 * @param {(args: object, ctx: ToolContext) => Promise<object>} spec.run
 */
export function defineTool({ name, description, risk = 'low', properties = {}, required = [], describe, run }) {
    return {
        name,
        description,
        risk,
        parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
        describe,
        run
    };
}

export const urlProperty = {
    type: 'string',
    description: 'The http(s) URL of the video or page, exactly as given by the user.'
};

export const playlistProperty = {
    type: 'boolean',
    description: 'Set true ONLY if the user explicitly asked to download a whole playlist.'
};

/** Whole-playlist operations are high risk; everything else is low. */
export const playlistRisk = (args) => (args.playlist === true ? 'high' : 'low');

/** Proxy and cookie arguments, in the same form the classic UI uses. */
export function commonArgs(ctx) {
    const args = [];
    if (ctx.proxy) args.push('--proxy', ctx.proxy);
    if (ctx.browser) args.push('--cookies-from-browser', ctx.browser);
    return args;
}

export function lastLines(text, count = 30) {
    return String(text || '').split('\n').slice(-count).join('\n').trim();
}

/** Run yt-dlp, reporting progress to the user. */
export function runYtDlpIn(ctx, args) {
    return runYtDlp(args, ctx.onProgress || noop);
}

/** Progress callback of a context (a no-op if there is none). */
export function progressOf(ctx) {
    return ctx.onProgress || noop;
}

/** Turn a `{success, cancelled, error}` result from core/tools.js into a tool result. */
export function outcome(res, extra = {}) {
    return {
        ok: res.success,
        cancelled: res.cancelled,
        ...(res.success ? {} : { error: res.error }),
        ...extra
    };
}

/** Run a yt-dlp download and capture the final file paths via a temporary manifest file. */
export async function runDownload(specificArgs, url, ctx, { playlist = false } = {}) {
    const folder = requireFolder(ctx);
    const manifestFile = join(
        tmpdir(),
        `ytdl-ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`
    );

    const res = await runYtDlpIn(ctx, [
        ...commonArgs(ctx),
        ...(playlist ? [] : ['--no-playlist']),
        ...specificArgs,
        '--print-to-file', 'after_move:filepath', manifestFile,
        '-P', folder,
        url
    ]);

    let files = [];
    try {
        const content = await fs.readFile(manifestFile, 'utf8');
        files = content.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    } catch { /* manifest is only written on success */ }
    try { await fs.unlink(manifestFile); } catch { /* ignore */ }

    return outcome(res, {
        saved_to_folder: folder,
        files: files.map((p) => basename(p)),
        output: lastLines(res.output)
    });
}

/** Result of an ffmpeg-based operation (hardsub, re-encode). */
export function mediaOutcome(res) {
    return outcome(res, {
        message: res.message,
        // The classic UI asks the user before deleting these; the agent must do the same
        // (via the confirmed delete_files tool) instead of deleting automatically.
        temporary_files: (res.tmpFiles || []).map((p) => basename(p))
    });
}

/** Resolve the subtitle track type for `lang`, since the model should not have to guess it. */
export async function resolveSubtitle(url, lang, ctx) {
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
