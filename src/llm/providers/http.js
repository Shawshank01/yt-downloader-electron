import { ProviderError, errorFromResponse } from '../errors.js';
import { MODEL_REQUEST_TIMEOUT_MS } from '../limits.js';


/** Default number of retries for model calls (so up to 3 attempts in total). */
export const DEFAULT_RETRIES = 2;

/** Wait `ms`, but stop immediately (with an "aborted" error) if the user cancels. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new ProviderError('Request cancelled.', { kind: 'aborted' }));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new ProviderError('Request cancelled.', { kind: 'aborted' }));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Overloaded or unreachable servers are usually back within seconds, so these are worth retrying. */
function isTransient(err) {
    if (!(err instanceof ProviderError)) return false;
    if (err.retryable === false) return false;
    if (err.kind === 'network') return true;
    return err.kind === 'server' && [500, 502, 503, 504].includes(err.status);
}

/** One HTTP attempt. Resolves with a successful Response; every failure becomes a ProviderError. */
async function attemptFetch({ fetchImpl, providerName, url, method, headers, body, signal, model, timeoutMs }) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response;
    try {
        response = await fetchImpl(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: combined
        });
    } catch (err) {
        if (signal?.aborted) {
            throw new ProviderError('Request cancelled.', { kind: 'aborted' });
        }
        if (timeoutSignal.aborted) {
            // Retrying a request that already waited the full timeout would just double the wait.
            const timeoutError = new ProviderError(`${providerName} did not respond in time.`, { kind: 'network' });
            timeoutError.retryable = false;
            throw timeoutError;
        }
        throw new ProviderError(
            `Cannot reach ${providerName} (${err.cause?.code || err.message}).`,
            { kind: 'network' }
        );
    }

    if (!response.ok) {
        throw errorFromResponse(providerName, response.status, await response.text(), { model });
    }
    return response;
}

async function attemptRequest(options) {
    const { providerName } = options;
    const response = await attemptFetch(options);
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new ProviderError(`${providerName} returned an invalid response.`, { kind: 'bad_response' });
    }
}

/** Run `attempt`, retrying transient failures with a delay that doubles each time. */
async function withRetries(attempt, { retries, retryDelayMs, signal, onRetry }) {
    for (let n = 0; ; n += 1) {
        try {
            return await attempt();
        } catch (err) {
            if (n >= retries || !isTransient(err) || signal?.aborted) throw err;
            const delayMs = retryDelayMs * 2 ** n;
            if (onRetry) {
                onRetry({
                    attempt: n + 1,
                    retries,
                    delayMs,
                    reason: err.status ? `HTTP ${err.status}` : 'connection problem'
                });
            }
            await sleep(delayMs, signal);
        }
    }
}

/**
 * Send a JSON request and return the parsed JSON response, translating failures into ProviderErrors.
 *
 * Transient failures (HTTP 500/502/503/504 and connection errors) are retried with a growing delay.
 * Only use `retries` for requests that are safe to repeat, such as model calls and read-only GETs.
 *
 * @param {object} opts
 * @param {typeof fetch} opts.fetchImpl
 * @param {string} opts.providerName  Display name used in error messages.
 * @param {string} opts.url
 * @param {'GET'|'POST'} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {object} [opts.body]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.model]       Used for "model not found" messages.
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]     How many times to retry after the first attempt. Default 0.
 * @param {number} [opts.retryDelayMs] Delay before the first retry; doubles each time. Default 1500.
 * @param {(info: {attempt: number, retries: number, delayMs: number, reason: string}) => void} [opts.onRetry]
 */
export function requestJson({
    fetchImpl,
    providerName,
    url,
    method = 'POST',
    headers = {},
    body,
    signal,
    model,
    timeoutMs = 120000,
    retries = 0,
    retryDelayMs = 1500,
    onRetry
}) {
    return withRetries(
        () => attemptRequest({ fetchImpl, providerName, url, method, headers, body, signal, model, timeoutMs }),
        { retries, retryDelayMs, signal, onRetry }
    );
}

/**
 * Like `requestJson`, but resolves with the successful Response so the caller can read a streamed
 * body (see ./stream.js). Retries only cover failures before the response starts; `timeoutMs`
 * limits the whole stream.
 * Takes the same options as `requestJson`.
 */
export function requestStream({
    fetchImpl,
    providerName,
    url,
    method = 'POST',
    headers = {},
    body,
    signal,
    model,
    timeoutMs = MODEL_REQUEST_TIMEOUT_MS,
    retries = 0,
    retryDelayMs = 1500,
    onRetry
}) {
    return withRetries(
        () => attemptFetch({ fetchImpl, providerName, url, method, headers, body, signal, model, timeoutMs }),
        { retries, retryDelayMs, signal, onRetry }
    );
}
