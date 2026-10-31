// Errors raised by LLM providers, with a stable `kind` so the UI can show a helpful message.
//
// kind: 'auth' | 'rate_limit' | 'not_found' | 'bad_request' | 'server' | 'network' | 'aborted' | 'bad_response'

export class ProviderError extends Error {
    constructor(message, { kind = 'server', status = 0 } = {}) {
        super(message);
        this.name = 'ProviderError';
        this.kind = kind;
        this.status = status;
    }
}

/** Pull a human-readable message out of a provider error response body. */
function extractMessage(bodyText) {
    if (!bodyText) return '';
    try {
        const body = JSON.parse(bodyText);
        if (typeof body?.error === 'string') return body.error;
        if (typeof body?.error?.message === 'string') return body.error.message;
        if (typeof body?.message === 'string') return body.message;
    } catch { /* not JSON */ }
    return bodyText.slice(0, 300);
}

/**
 * Convert a non-2xx HTTP response into a ProviderError with an actionable message.
 * @param {string} providerName  Display name, e.g. "Gemini".
 * @param {number} status        HTTP status.
 * @param {string} bodyText      Raw response body.
 * @param {{model?: string}} [info]
 */
export function errorFromResponse(providerName, status, bodyText, { model } = {}) {
    const detail = extractMessage(bodyText);

    if (status === 429) {
        return new ProviderError(
            `${providerName} rate limit or quota reached. Wait a moment, switch provider, or use Classic mode.${detail ? ` (${detail})` : ''}`,
            { kind: 'rate_limit', status }
        );
    }
    if (status === 401 || status === 403 || /api key not valid|API_KEY_INVALID/i.test(detail)) {
        return new ProviderError(
            `${providerName} rejected the API key. Check it in settings.${detail ? ` (${detail})` : ''}`,
            { kind: 'auth', status }
        );
    }
    if (status === 404) {
        return new ProviderError(
            `${providerName} could not find ${model ? `model "${model}"` : 'the requested resource'}. Check the model ID in settings.${detail ? ` (${detail})` : ''}`,
            { kind: 'not_found', status }
        );
    }
    if (status >= 500) {
        return new ProviderError(
            `${providerName} is having problems (HTTP ${status}). This is on their side, not yours: try again in a minute, switch provider in AI Settings, or use Classic mode.${detail ? ` (${detail})` : ''}`,
            { kind: 'server', status }
        );
    }
    return new ProviderError(
        `${providerName} rejected the request (HTTP ${status})${detail ? `: ${detail}` : '.'}`,
        { kind: 'bad_request', status }
    );
}
