import { ProviderError } from '../errors.js';
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
    async chat({ system, messages, tools = [], signal, onRetry }) {
        this.#requireKey();

        const body = {
            contents: this.#toContents(messages),
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            ...(tools.length > 0 ? { tools: [{ functionDeclarations: tools.map(toGeminiDeclaration) }] } : {})
        };

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
}
