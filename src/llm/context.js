// The per-request context (download folder, cookie browser, proxy) comes from the user's UI settings,
// never from the model. This is the single place that defines what a valid context is.
import { promises as fs } from 'fs';
import { isAbsolute } from 'path';
import { ValidationError } from './validate.js';
import { AiSettingsError, ALLOWED_BROWSERS, PROXY_PATTERN } from './provider-settings.js';
import { MESSAGES } from './messages.js';

/** True if `path` is an existing directory. */
export async function isDirectory(path) {
    try {
        return (await fs.stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Validate the context sent by the renderer before a request starts.
 * An empty download folder is allowed (the assistant can still answer questions); tools that write
 * files then refuse via `requireFolder`.
 * @param {{downloadFolder?: string, browser?: string, proxy?: string}} context
 * @param {(path: string) => Promise<boolean>} [isDir]
 */
export async function validateContext(context = {}, isDir = isDirectory) {
    const downloadFolder = typeof context.downloadFolder === 'string' ? context.downloadFolder.trim() : '';
    if (downloadFolder && (!isAbsolute(downloadFolder) || !(await isDir(downloadFolder)))) {
        throw new AiSettingsError('The selected download folder does not exist. Choose a folder again.');
    }
    const browser = context.browser || '';
    if (!ALLOWED_BROWSERS.includes(browser)) throw new AiSettingsError('Unsupported cookie browser.');
    const proxy = context.proxy || '';
    if (proxy && !PROXY_PATTERN.test(proxy)) throw new AiSettingsError('The proxy address is not valid.');
    return { downloadFolder, browser, proxy };
}

/** The download folder of a validated context, or a ValidationError the model can read. */
export function requireFolder(ctx) {
    if (!ctx.downloadFolder || typeof ctx.downloadFolder !== 'string') {
        throw new ValidationError(MESSAGES.noDownloadFolderForTool);
    }
    return ctx.downloadFolder;
}
