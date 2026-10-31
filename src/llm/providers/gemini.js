import { ProviderError, errorFromResponse } from '../errors.js';
import { requestJson, DEFAULT_RETRIES } from './http.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * How much the model "thinks" before answering. Gemini 3.8 Flash defaults to `medium`, which can take
 * a long time even for simple requests. Controlling a download tool rarely needs deep reasoning, so
 * the app defaults to `low`. (`minimal` is rejected by Gemini 3.8 Flash, so it is not offered.)
 */
export const THINKING_LEVELS = ['low', 'medium', 'high'];
export const DEFAULT_THINKING_LEVEL = 'low';

/**
 * Gemini's generateContent endpoint has rejected function declarations whose `parameters` object has
 * no properties ("parameters.properties: should be non-empty for OBJECT type"). Tools without
 * parameters are declared with just a name and description instead.
 */
export function toGeminiDeclaration({ name, description, parameters }) {
    const hasProperties = parameters && parameters.properties && Object.keys(parameters.properties).length > 0;
    return hasProperties ? { name, description, parameters } : { name, description };
}

/**
 * Google Gemini via the REST API (generateContent with function calling).
 *
 * Neutral message format used across providers:
 *   { role: 'user', text }
 *   { role: 'assistant', text, toolCalls: [{ id, name, args, providerCallId? }], raw? }
 *   { role: 'tool', toolCallId, providerCallId?, name, result }
 *
 * Gemini 3 models return "thought signatures" inside the response parts and require them to be
 * sent back with the function call on the next turn. To keep that working for any model, the
 * assistant message stores the original response parts in `raw` and they are replayed verbatim.
 */
export class GeminiProvider {
    /**
     * @param {object} config
     * @param {string} config.apiKey
     * @param {string} [config.model]
     * @param {string} [config.baseUrl]
     * @param {'low'|'medium'|'high'|''} [config.thinkingLevel]  '' sends nothing (the model's default).
     * @param {number} [config.retries]       Retries for temporary errors such as HTTP 503.
     * @param {number} [config.retryDelayMs]
     * @param {typeof fetch} [config.fetchImpl]
     */
    constructor({ apiKey, model, baseUrl, thinkingLevel, retries = DEFAULT_RETRIES, retryDelayMs = 1500, fetchImpl = globalThis.fetch } = {}) {
        this.id = 'gemini';
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
        this.thinkingLevel = thinkingLevel === '' ? '' : THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : DEFAULT_THINKING_LEVEL;
        this.displayName = 'Gemini';
        this.apiKey = apiKey;
        this.model = (model || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
        this.baseUrl = (baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
    }

    #requireKey() {
        if (!this.apiKey) {
            throw new ProviderError('No Gemini API key is configured. Add one in settings.', { kind: 'auth' });
        }
    }

    #modelUrl() {
        return `${this.baseUrl}/models/${encodeURIComponent(this.model)}`;
    }

    #headers() {
        return { 'x-goog-api-key': this.apiKey };
    }

    /** Check that the key and model are valid without spending any tokens. */
    async testConnection({ signal } = {}) {
        this.#requireKey();
        const info = await requestJson({
            fetchImpl: this.fetchImpl,
            providerName: this.displayName,
            url: this.#modelUrl(),
            method: 'GET',
            headers: this.#headers(),
            signal,
            model: this.model,
            timeoutMs: 15000
        });
        return { ok: true, message: `Connected to ${info.displayName || info.name || this.model}.` };
    }

    #toContents(messages) {
        const contents = [];
        for (const msg of messages) {
            if (msg.role === 'user') {
                contents.push({ role: 'user', parts: [{ text: msg.text }] });
            } else if (msg.role === 'assistant') {
                if (msg.raw?.provider === this.id && Array.isArray(msg.raw.parts)) {
                    contents.push({ role: 'model', parts: msg.raw.parts });
                } else {
                    const parts = [];
                    if (msg.text) parts.push({ text: msg.text });
                    for (const call of msg.toolCalls || []) {
                        parts.push({ functionCall: { name: call.name, args: call.args || {} } });
                    }
                    if (parts.length > 0) contents.push({ role: 'model', parts });
                }
            } else if (msg.role === 'tool') {
                const part = {
                    functionResponse: {
                        name: msg.name,
                        response: msg.result && typeof msg.result === 'object' ? msg.result : { result: msg.result },
                        ...(msg.providerCallId ? { id: msg.providerCallId } : {})
                    }
                };
                // Consecutive tool results belong in a single user turn.
                const last = contents[contents.length - 1];
                if (last && last.role === 'user' && last.parts.every((p) => p.functionResponse)) {
                    last.parts.push(part);
                } else {
                    contents.push({ role: 'user', parts: [part] });
                }
            }
        }
        return contents;
    }

    /**
     * @param {object} req
     * @param {string} req.system
     * @param {Array} req.messages
     * @param {Array<{name:string, description:string, parameters:object}>} [req.tools]
     * @param {AbortSignal} [req.signal]
     * @param {(info: object) => void} [req.onRetry]  Called before each automatic retry.
     * @returns {Promise<{text: string, toolCalls: Array, raw: object}>}
     */
    async chat({ system, messages, tools = [], signal, onTextDelta, onRetry }) {
        this.#requireKey();

        const body = {
            contents: this.#toContents(messages),
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools.map(toGeminiDeclaration) }] } : {})
        };

        if (onTextDelta) {
            return this.#stream(body, onTextDelta, signal, onRetry);
        }

        const send = (requestBody) =>
            requestJson({
                fetchImpl: this.fetchImpl,
                providerName: this.displayName,
                url: `${this.#modelUrl()}:generateContent`,
                headers: this.#headers(),
                body: requestBody,
                signal,
                model: this.model,
                retries: this.retries,
                retryDelayMs: this.retryDelayMs,
                onRetry
            });

        const startedAt = Date.now();
        let data;
        if (this.thinkingLevel) {
            try {
                data = await send({
                    ...body,
                    generationConfig: { thinkingConfig: { thinkingLevel: this.thinkingLevel } }
                });
            } catch (err) {
                // Older models (e.g. Gemini 2.5) do not accept thinkingLevel. Retry once without it
                // instead of failing the whole request.
                if (err instanceof ProviderError && err.kind === 'bad_request' && /thinking/i.test(err.message)) {
                    data = await send(body);
                } else {
                    throw err;
                }
            }
        } else {
            data = await send(body);
        }
        const elapsedMs = Date.now() - startedAt;

        const candidate = data.candidates?.[0];
        if (!candidate?.content) {
            const reason = data.promptFeedback?.blockReason || candidate?.finishReason || 'no content';
            throw new ProviderError(`Gemini returned no answer (${reason}).`, { kind: 'bad_response' });
        }
        if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL') {
            throw new ProviderError('Gemini produced an invalid tool call. Try rephrasing the request.', {
                kind: 'bad_response'
            });
        }

        const parts = candidate.content.parts || [];
        const text = parts
            .filter((p) => typeof p.text === 'string' && !p.thought)
            .map((p) => p.text)
            .join('')
            .trim();

        const toolCalls = [];
        parts.forEach((p, index) => {
            if (p.functionCall) {
                toolCalls.push({
                    id: p.functionCall.id || `gemini-call-${Date.now()}-${index}`,
                    providerCallId: p.functionCall.id,
                    name: p.functionCall.name,
                    args: p.functionCall.args || {}
                });
            }
        });

        const usage = data.usageMetadata || {};
        return {
            text,
            toolCalls,
            raw: { provider: this.id, parts },
            stats: {
                ms: elapsedMs,
                thinkingLevel: this.thinkingLevel || 'default',
                promptTokens: usage.promptTokenCount,
                thoughtTokens: usage.thoughtsTokenCount,
                outputTokens: usage.candidatesTokenCount
            }
        };
    }

    async #stream(body, onTextDelta, signal, onRetry) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await this.#streamOnce(body, onTextDelta, signal);
            } catch (err) {
                const retryable = err instanceof ProviderError &&
                    (err.kind === 'network' || (err.kind === 'server' && [500, 502, 503, 504].includes(err.status)));
                if (!retryable || attempt >= this.retries || signal?.aborted) throw err;
                const delayMs = this.retryDelayMs * 2 ** attempt;
                onRetry?.({ attempt: attempt + 1, retries: this.retries, delayMs, reason: err.status ? `HTTP ${err.status}` : 'connection problem' });
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, delayMs);
                    signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        reject(new ProviderError('Request cancelled.', { kind: 'aborted' }));
                    }, { once: true });
                });
            }
        }
    }

    async #streamOnce(body, onTextDelta, signal) {
        const startedAt = Date.now();
        const url = `${this.#modelUrl()}:streamGenerateContent?alt=sse`;
        const timeoutSignal = AbortSignal.timeout(240000);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let response;
        try {
            response = await this.fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.#headers() },
                body: JSON.stringify({
                    ...body,
                    ...(this.thinkingLevel ? { generationConfig: { thinkingConfig: { thinkingLevel: this.thinkingLevel } } } : {})
                }),
                signal: combined
            });
        } catch (err) {
            if (signal?.aborted) throw new ProviderError('Request cancelled.', { kind: 'aborted' });
            throw new ProviderError(`Cannot reach ${this.displayName} (${err.cause?.code || err.message}).`, { kind: 'network' });
        }
        if (!response.ok) {
            const text = await response.text();
            throw errorFromResponse(this.displayName, response.status, text, { model: this.model });
        }
        if (!response.body?.getReader) {
            try {
                return this.#parseStreamData(JSON.parse(await response.text()), undefined, startedAt);
            } catch {
                throw new ProviderError('Gemini did not return a streaming response.', { kind: 'bad_response' });
            }
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalData = null;
        const process = (raw) => {
            const line = raw.split(/\r?\n/).find((item) => item.startsWith('data:'));
            if (!line) return;
            try {
                const data = JSON.parse(line.slice(5).trim());
                const parts = data.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (typeof part.text === 'string' && !part.thought) onTextDelta(part.text);
                }
                finalData = data;
            } catch {
                // Incomplete SSE records are retained by the buffer.
            }
        };
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const records = buffer.split(/\r?\n\r?\n/);
            buffer = records.pop() || '';
            records.forEach(process);
            if (done) break;
        }
        if (buffer) process(buffer);
        if (!finalData) throw new ProviderError('Gemini ended the stream without a response.', { kind: 'bad_response' });
        return this.#parseStreamData(finalData, undefined, startedAt);
    }

    #parseStreamData(finalData, onTextDelta, startedAt = Date.now()) {
        const candidate = finalData.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        if (onTextDelta) {
            for (const part of parts) {
                if (typeof part.text === 'string' && !part.thought) onTextDelta(part.text);
            }
        }
        const toolCalls = parts.filter((part) => part.functionCall).map((part, index) => ({
            id: part.functionCall.id || `gemini-call-${Date.now()}-${index}`,
            providerCallId: part.functionCall.id,
            name: part.functionCall.name,
            args: part.functionCall.args || {}
        }));
        return {
            text: parts.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('').trim(),
            toolCalls,
            raw: { provider: this.id, parts },
            stats: {
                ms: Date.now() - startedAt,
                thinkingLevel: this.thinkingLevel || 'default',
                promptTokens: finalData.usageMetadata?.promptTokenCount,
                thoughtTokens: finalData.usageMetadata?.thoughtsTokenCount,
                outputTokens: finalData.usageMetadata?.candidatesTokenCount
            }
        };
    }
}
