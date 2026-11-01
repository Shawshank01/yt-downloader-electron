// Where did a URL come from? A prompt-injected web page (video title, description, subtitles) can
// tell the model to fetch some other address. URLs the user typed are trusted; any other URL must be
// confirmed by the user before a tool uses it.

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function normalize(value) {
    try {
        return new URL(value).href;
    } catch {
        return null;
    }
}

/** All http(s) URLs in `text`, normalised. Trailing sentence punctuation is ignored. */
export function extractUrls(text) {
    const urls = new Set();
    for (const match of String(text || '').matchAll(URL_PATTERN)) {
        // Try the match as typed first (URLs may legitimately end in ")"), then without trailing punctuation.
        for (const candidate of [match[0], match[0].replace(TRAILING_PUNCTUATION, '')]) {
            const href = normalize(candidate);
            if (href) urls.add(href);
        }
    }
    return urls;
}

/**
 * Whether `url` is a well-formed http(s) address that none of the user's messages in `history`
 * contain. Malformed values are not "foreign": the tool rejects them itself, before anything runs.
 */
export function isForeignUrl(history, url) {
    const href = normalize(String(url || '').trim());
    if (!href || !/^https?:/.test(href)) return false;
    return !history.some((m) => m.role === 'user' && extractUrls(m.text).has(href));
}
