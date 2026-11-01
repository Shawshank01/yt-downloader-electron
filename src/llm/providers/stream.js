import { ProviderError } from '../errors.js';

/**
 * Helpers for reading streamed model responses (Server-Sent Events and newline-delimited JSON).
 * They are shared by all providers so that cancellation, interrupted connections and malformed
 * data are reported the same way everywhere.
 */

/** Read the body and call `onRecord` for every complete record, then once for any trailing data. */
async function readRecords(response, separator, { signal, providerName }, onRecord) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (; ;) {
        let chunk;
        try {
            chunk = await reader.read();
        } catch {
            if (signal?.aborted) throw new ProviderError('Request cancelled.', { kind: 'aborted' });
            throw new ProviderError(`The connection to ${providerName} was interrupted.`, { kind: 'network' });
        }
        const { done, value } = chunk;
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const records = buffer.split(separator);
        buffer = records.pop() || '';
        for (const record of records) onRecord(record);
        if (done) break;
    }
    if (buffer.trim()) onRecord(buffer);
}

/** Whether the response body can be read incrementally. */
export function isStreamable(response) {
    return typeof response.body?.getReader === 'function';
}

/** Parse the JSON payload of one streamed record, reporting garbage as a bad response. */
export function parseStreamJson(text, providerName) {
    try {
        return JSON.parse(text);
    } catch {
        throw new ProviderError(`${providerName} sent invalid streaming data.`, { kind: 'bad_response' });
    }
}

/**
 * Server-Sent Events: calls `onData(payload)` with the `data:` payload of each event.
 * Comment/keep-alive events and the `[DONE]` marker are skipped.
 */
export function readSse(response, context, onData) {
    return readRecords(response, /\r?\n\r?\n/, context, (record) => {
        const data = record
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
        if (data && data !== '[DONE]') onData(data);
    });
}

/** Newline-delimited JSON: calls `onLine(line)` for each non-empty line. */
export function readNdjson(response, context, onLine) {
    return readRecords(response, /\r?\n/, context, (line) => {
        if (line.trim()) onLine(line);
    });
}

/** Fallback for servers that ignore `stream: true` and return one JSON document. */
export async function readJsonBody(response, providerName) {
    return parseStreamJson(await response.text(), providerName);
}
