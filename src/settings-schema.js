// Settings the renderer may write through the generic 'set-settings' channel (the classic UI's own
// preferences). It is an allow-list: any other key, and any value of the wrong type, is dropped.
// AI settings are not on it; they can only change through the validated ai-* handlers, because they
// hold provider URLs, model names and security options.
import { ALLOWED_BROWSERS } from './llm/provider-settings.js';

const MAX_STRING_CHARS = 2048;
const isShortString = (v) => typeof v === 'string' && v.length <= MAX_STRING_CHARS;

/** Setting name -> predicate for an acceptable value. */
export const CLASSIC_SETTINGS = {
    downloadFolder: isShortString,
    browser: (v) => ALLOWED_BROWSERS.includes(v),
    subtitlePosition: (v) => v === 'bottom' || v === 'top',
    proxyEnabled: (v) => typeof v === 'boolean',
    proxyAddress: isShortString
};

/** Keep only the allowed settings that have valid values. */
export function sanitizeClassicSettings(updates) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return {};
    return Object.fromEntries(
        Object.entries(updates).filter(([key, value]) =>
            Object.hasOwn(CLASSIC_SETTINGS, key) && CLASSIC_SETTINGS[key](value)
        )
    );
}
