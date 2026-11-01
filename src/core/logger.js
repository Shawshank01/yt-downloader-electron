// Logging for the core (yt-dlp / ffmpeg) code. Everything passes through redaction first, because the
// command lines and URLs being logged can contain proxy credentials.

const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const SECRET_FLAGS = new Set(['--proxy', '--password', '--video-password', '--ap-password', '--username']);

/** Hide `user:password@` in URLs. */
export function redactText(text) {
    return String(text).replace(CREDENTIALS_IN_URL, '$1***@');
}

/** Redact a command-line argument list: values of secret flags and credentials inside URLs. */
export function redactArgs(args) {
    return args.map((arg, index) => {
        if (typeof arg !== 'string') return arg;
        if (index > 0 && SECRET_FLAGS.has(args[index - 1])) return '***';
        return redactText(arg);
    });
}

function redactValue(value) {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return redactArgs(value);
    if (value && typeof value === 'object' && !(value instanceof Error)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)]));
    }
    return value;
}

let sink = console;

/** Replace where log lines go (used by tests). Pass nothing to restore the console. */
export function setLogSink(next = console) {
    sink = next;
}

export const logger = {
    info: (...args) => sink.log(...args.map(redactValue)),
    warn: (...args) => sink.warn(...args.map(redactValue)),
    error: (...args) => sink.error(...args.map(redactValue))
};
