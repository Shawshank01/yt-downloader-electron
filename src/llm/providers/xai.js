import { ProviderError, errorFromResponse } from '../errors.js';
import { requestJson, DEFAULT_RETRIES } from './http.js';

export const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';
export const DEFAULT_XAI_MODEL = 'grok-4.3';
export const XAI_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

/** xAI's native Responses API provider. */
export class XaiProvider {
    /**
     * @param {object} config
     * @param {string} config.model
     * @param {string} [config.apiKey]
     * @param {'none'|'low'|'medium'|'high'|'xhigh'} [config.reasoningEffort]
     * @param {number} [config.retries]
     * @param {number} [config.retryDelayMs]
     * @param {typeof fetch} [config.fetchImpl]
     */
    constructor({
        apiKey,
        model = DEFAULT_XAI_MODEL,
        reasoningEffort = 'none',
        retries = DEFAULT_RETRIES,
        retryDelayMs = 1500,
        fetchImpl = globalThis.fetch
    } = {}) {
        this.id = 'xai';
        this.displayName = 'xAI';
        this.requireApiKey = true;
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
        this.apiKey = apiKey;
        this.model = model;
        this.reasoningEffort = XAI_REASONING_EFFORTS.includes(reasoningEffort) ? reasoningEffort : 'none';
        this.baseUrl = DEFAULT_XAI_BASE_URL;
        this.fetchImpl = fetchImpl;
    }

    #headers() {
        if (this.requireApiKey && !this.apiKey) {
            throw new ProviderError(`No ${this.displayName} API key is configured. Add one in settings.`, { kind: 'auth' });
        }
        return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    }

    /** Check connectivity by listing models. */
    async testConnection({ signal } = {}) {
        try {
            const data = await requestJson({
                fetchImpl: this.fetchImpl,
                providerName: this.displayName,
                url: `${this.baseUrl}/models`,
                method: 'GET',
                headers: this.#headers(),
                signal,
                timeoutMs: 15000
            });
            const ids = (data.data || []).map((m) => m.id);
            if (ids.length > 0 && !ids.includes(this.model)) {
                return {
                    ok: false,
                    message: `Connected, but model "${this.model}" was not in the server's model list. Check the spelling (some servers do not list aliases).`
                };
            }
            return { ok: true, message: `Connected to ${this.baseUrl}.` };
        } catch (err) {
            if (err instanceof ProviderError && err.kind === 'not_found') {
                return { ok: true, message: `Server reachable (it does not list models, so "${this.model}" is unverified).` };
            }
            throw err;
        }
    }

    #toInput(messages) {
        const input = [];
        for (const msg of messages) {
            if (msg.role === 'user') {
                input.push({ role: 'user', content: msg.text });
            } else if (msg.role === 'assistant') {
                if (msg.text) input.push({ role: 'assistant', content: msg.text });
                for (const call of msg.toolCalls || []) {
                    input.push({
                        type: 'function_call',
                        call_id: call.providerCallId || call.id,
                        name: call.name,
                        arguments: JSON.stringify(call.args || {})
                    });
                }
            } else if (msg.role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: msg.providerCallId || msg.toolCallId,
                    output: JSON.stringify(msg.result)
                });
            }
        }
        return input;
    }

    async chat({ system, messages, tools = [], signal, onTextDelta, onRetry }) {
        if (!this.model) {
            throw new ProviderError('No model is configured for the xAI provider.', { kind: 'bad_request' });
        }

        const request = {
            fetchImpl: this.fetchImpl,
            providerName: this.displayName,
            url: `${this.baseUrl}/responses`,
            headers: this.#headers(),
            body: {
                model: this.model,
                instructions: system || undefined,
                input: this.#toInput(messages),
                ...(this.reasoningEffort !== 'none' ? { reasoning_effort: this.reasoningEffort } : {}),
                ...(tools.length > 0
                    ? {
                        tools: tools.map((t) => ({
                            type: 'function',
                            name: t.name,
                            description: t.description,
                            parameters: t.parameters
                        }))
                    }
                    : {})
            },
            signal,
            model: this.model,
            timeoutMs: 240000,
            retries: this.retries,
            retryDelayMs: this.retryDelayMs,
            onRetry
        };
        if (onTextDelta) {
            request.body.stream = true;
            return this.#streamResponse(request, onTextDelta, signal);
        }
        const data = await requestJson(request);
        return this.#parseResponse(data);
    }

    async #streamResponse(request, onTextDelta, signal) {
        const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
        const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let response;
        try {
            response = await request.fetchImpl(request.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...request.headers },
                body: JSON.stringify(request.body),
                signal: combinedSignal
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
                return this.#parseResponse(JSON.parse(await response.text()));
            } catch {
                throw new ProviderError(`${this.displayName} did not return a streaming response.`, { kind: 'bad_response' });
            }
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let completed;
        const processEvent = (raw) => {
            const data = raw.split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');
            if (!data || data === '[DONE]') return;
            let event;
            try { event = JSON.parse(data); } catch { return; }
            if (event.type === 'response.output_text.delta' && event.delta) onTextDelta(event.delta);
            if (event.type === 'response.completed' && event.response) completed = event.response;
        };

        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            for (const event of events) processEvent(event);
            if (done) break;
        }
        if (buffer) processEvent(buffer);
        if (!completed) throw new ProviderError(`${this.displayName} ended the stream without a completed response.`, { kind: 'bad_response' });
        return this.#parseResponse(completed);
    }

    #parseResponse(data) {

        const output = Array.isArray(data.output) ? data.output : [];
        const toolCalls = output
            .filter((item) => item.type === 'function_call')
            .map((call, index) => {
                let args = {};
                if (typeof call.arguments === 'string' && call.arguments.trim()) {
                    try { args = JSON.parse(call.arguments); } catch { args = {}; }
                } else if (call.arguments && typeof call.arguments === 'object') {
                    args = call.arguments;
                }
                return {
                    id: call.call_id || call.id || `xai-call-${Date.now()}-${index}`,
                    providerCallId: call.call_id || call.id,
                    name: call.name,
                    args
                };
            });
        const text = output
            .filter((item) => item.type === 'message')
            .flatMap((item) => item.content || [])
            .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('')
            .trim();

        if (!text && toolCalls.length === 0 && data.status !== 'completed') {
            throw new ProviderError(`${this.displayName} returned no answer.`, { kind: 'bad_response' });
        }
        return { text, toolCalls, raw: null };
    }
}
