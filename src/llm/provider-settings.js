// Validation of the AI settings that come from the renderer. Pure functions, no I/O.
import { PROVIDER_TYPES } from './providers/index.js';

export const MODES = ['classic', 'ai'];
export const CONFIRM_MODES = ['always', 'risky', 'never'];
export const ALLOWED_BROWSERS = ['', 'brave', 'chrome', 'firefox', 'safari'];

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
export const PROXY_PATTERN = /^(socks5h?|socks4a?|https?):\/\/[A-Za-z0-9.\-[\]:]+\/?$/;

/** An invalid setting. The message is safe to show to the user. */
export class AiSettingsError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AiSettingsError';
    }
}

/** The provider type to use: `candidate` if it is known, otherwise the default. */
export function normalizeProviderType(candidate) {
    return PROVIDER_TYPES[candidate] ? candidate : 'gemini';
}

export function assertKnownProvider(type) {
    if (!PROVIDER_TYPES[type]) throw new AiSettingsError('Unknown AI provider.');
    return PROVIDER_TYPES[type];
}

function assertHttpUrl(value, name) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new AiSettingsError(`${name} is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiSettingsError(`${name} must start with http:// or https://.`);
    }
    return value.trim().replace(/\/+$/, '');
}

/**
 * The tuning options (for example `thinkingLevel`) of a provider, using the saved value when it
 * is still valid and the provider's default otherwise.
 * @returns {Record<string, string>}
 */
export function resolveProviderOptions(type, saved = {}) {
    const resolved = {};
    for (const [name, spec] of Object.entries(PROVIDER_TYPES[type].options)) {
        resolved[name] = spec.choices.includes(saved[name]) ? saved[name] : spec.default;
    }
    return resolved;
}

/** Every option name any provider supports (used to detect options sent to the wrong provider). */
const ALL_OPTION_NAMES = [...new Set(Object.values(PROVIDER_TYPES).flatMap((info) => Object.keys(info.options)))];

/** Validate a per-provider config update ({model, baseUrl, <option>}) from the renderer. */
export function sanitizeProviderConfig(type, update = {}) {
    const info = assertKnownProvider(type);
    const out = {};

    if (update.model !== undefined) {
        const model = String(update.model).trim();
        if (model && !MODEL_PATTERN.test(model)) {
            throw new AiSettingsError('The model name contains unsupported characters.');
        }
        out.model = model;
    }

    for (const name of ALL_OPTION_NAMES) {
        if (update[name] === undefined) continue;
        const spec = info.options[name];
        if (!spec) throw new AiSettingsError(`${name} is not available for this provider.`);
        if (!spec.choices.includes(update[name])) {
            throw new AiSettingsError(`${spec.label} must be ${spec.choices.join(', ')}.`);
        }
        out[name] = update[name];
    }

    if (update.baseUrl !== undefined) {
        if (info.editableBaseUrl) {
            const baseUrl = String(update.baseUrl).trim();
            out.baseUrl = baseUrl ? assertHttpUrl(baseUrl, 'The server URL') : '';
        } else if (info.lockedBaseUrlError) {
            throw new AiSettingsError(info.lockedBaseUrlError);
        }
        // Otherwise the provider always uses its built-in endpoint and the value is ignored.
    }
    return out;
}
