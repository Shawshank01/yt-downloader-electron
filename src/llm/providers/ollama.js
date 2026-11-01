import { ProviderError } from '../errors.js';
import { CONNECTION_TEST_TIMEOUT_MS, LOCAL_MODEL_REQUEST_TIMEOUT_MS } from '../limits.js';
import { requestJson, requestStream, DEFAULT_RETRIES } from './http.js';
import { isStreamable, parseStreamJson, readJsonBody, readNdjson } from './stream.js';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'lfm3:1.7b';

/** Local models through Ollama's /api/chat endpoint (requires a model that supports tool calling). */
export class OllamaProvider {
    /**
     * @param {object} config
     * @param {string} [config.model]
     * @param {string} [config.baseUrl]
     * @param {typeof fetch} [config.fetchImpl]
     */
    constructor({ model, baseUrl, retries = DEFAULT_RETRIES, retryDelayMs = 1500, fetchImpl = globalThis.fetch } = {}) {
        this.id = 'ollama';
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
        this.displayName = 'Ollama';
        this.model = model || DEFAULT_OLLAMA_MODEL;
        this.baseUrl = (baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
    }

    /** Check that Ollama is reachable and the model has been pulled. */
    async testConnection({ signal } = {}) {
        const data = await requestJson({
            fetchImpl: this.fetchImpl,
            providerName: this.displayName,
            url: `${this.baseUrl}/api/tags`,
            method: 'GET',
            signal,
            timeoutMs: CONNECTION_TEST_TIMEOUT_MS
        });
        const names = (data.models || []).map((m) => m.name);
        const found = names.some((n) => n === this.model || n === `${this.model}:latest`);
        if (!found) {
            return {
                ok: false,
                message: `Ollama is running but model "${this.model}" is not installed. Run: ollama pull ${this.model}`
            };
        }
        return { ok: true, message: `Connected to Ollama, model "${this.model}" is available.` };
    }

    #toMessages(system, messages) {
        const out = [];
        if (system) out.push({ role: 'system', content: system });
        for (const msg of messages) {
            if (msg.role === 'user') {
                out.push({ role: 'user', content: msg.text });
            } else if (msg.role === 'assistant') {
                out.push({
                    role: 'assistant',
                    content: msg.text || '',
                    ...(msg.toolCalls?.length
                        ? {
                            tool_calls: msg.toolCalls.map((c) => ({
                                function: { name: c.name, arguments: c.args || {} }
                            }))
                        }
                        : {})
                });
            } else if (msg.role === 'tool') {
                out.push({ role: 'tool', tool_name: msg.name, content: JSON.stringify(msg.result) });
            }
        }
        return out;
    }


    async chat({ system, messages, tools = [], signal, onTextDelta, onRetry }) {
        const request = {
            fetchImpl: this.fetchImpl,
            providerName: this.displayName,
            url: `${this.baseUrl}/api/chat`,
            body: {
                model: this.model,
                messages: this.#toMessages(system, messages),
                stream: Boolean(onTextDelta),
                options: { temperature: 0.2 },
                ...(tools.length > 0
                    ? {
                        tools: tools.map((t) => ({
                            type: 'function',
                            function: { name: t.name, description: t.description, parameters: t.parameters }
                        }))
                    }
                    : {})
            },
            signal,
            model: this.model,
            timeoutMs: LOCAL_MODEL_REQUEST_TIMEOUT_MS,
            retries: this.retries,
            retryDelayMs: this.retryDelayMs,
            onRetry
        };

        try {
            return onTextDelta
                ? await this.#stream(request, signal, onTextDelta)
                : this.#toReply((await requestJson(request)).message || {});
        } catch (err) {
            throw this.#explain(err);
        }
    }

    /** Replace generic transport errors with messages that tell the user what to do. */
    #explain(err) {
        if (!(err instanceof ProviderError)) return err;
        if (/does not support tools/i.test(err.message)) {
            return new ProviderError(
                `The Ollama model "${this.model}" does not support tool calling. Choose a model with tool support (for example qwen3 or llama3.1).`,
                { kind: 'bad_request', status: err.status }
            );
        }
        if (err.kind === 'network') {
            return new ProviderError(`Cannot reach Ollama at ${this.baseUrl}. Is Ollama running?`, { kind: 'network' });
        }
        return err;
    }

    async #stream(request, signal, onTextDelta) {
        const response = await requestStream(request);
        if (!isStreamable(response)) {
            return this.#toReply((await readJsonBody(response, this.displayName)).message || {});
        }

        let text = '';
        let toolCalls = [];
        await readNdjson(response, { signal, providerName: this.displayName }, (line) => {
            const message = parseStreamJson(line, this.displayName).message || {};
            if (message.content) {
                text += message.content;
                onTextDelta(message.content);
            }
            if (message.tool_calls) toolCalls = this.#toToolCalls(message.tool_calls);
        });
        return { text: text.trim(), toolCalls, raw: null };
    }

    #toReply(message) {
        return {
            text: (message.content || '').trim(),
            toolCalls: this.#toToolCalls(message.tool_calls || []),
            raw: null
        };
    }

    #toToolCalls(calls) {
        return calls.map((call, index) => {
            let args = call.function?.arguments ?? {};
            if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { args = {}; }
            }
            return {
                id: `ollama-call-${Date.now()}-${index}`,
                name: call.function?.name,
                args
            };
        });
    }
}
