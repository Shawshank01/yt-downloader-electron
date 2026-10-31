import { ProviderError } from '../errors.js';
import { requestJson, DEFAULT_RETRIES } from './http.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Any server that speaks the OpenAI "chat completions" API: OpenAI, OpenRouter, Groq,
 * LM Studio, llama.cpp server, vLLM, and others. Configure `baseUrl`, `apiKey` and `model`.
 */
export class OpenAICompatibleProvider {
    /**
     * @param {object} config
     * @param {string} config.model
     * @param {string} [config.apiKey]   Optional for local servers.
     * @param {string} [config.baseUrl]
     * @param {string} [config.id]           Identifier for presets built on this adapter (e.g. "xai").
     * @param {string} [config.displayName]  Name used in error messages.
     * @param {boolean} [config.requireApiKey]  Refuse to send requests without a key (hosted services).
     * @param {number} [config.retries]
     * @param {number} [config.retryDelayMs]
     * @param {typeof fetch} [config.fetchImpl]
     */
    constructor({
        apiKey,
        model,
        baseUrl,
        id = 'openai-compatible',
        displayName = 'OpenAI-compatible server',
        requireApiKey = false,
        retries = DEFAULT_RETRIES,
        retryDelayMs = 1500,
        fetchImpl = globalThis.fetch
    } = {}) {
        this.id = id;
        this.displayName = displayName;
        this.requireApiKey = requireApiKey;
        this.retries = retries;
        this.retryDelayMs = retryDelayMs;
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = (baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
        this.fetchImpl = fetchImpl;
    }

    #headers() {
        if (this.requireApiKey && !this.apiKey) {
            throw new ProviderError(`No ${this.displayName} API key is configured. Add one in settings.`, { kind: 'auth' });
        }
        return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    }

    /** Check connectivity by listing models. Not every server supports this, so 404 is non-fatal. */
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

    #toMessages(system, messages) {
        const out = [];
        if (system) out.push({ role: 'system', content: system });
        for (const msg of messages) {
            if (msg.role === 'user') {
                out.push({ role: 'user', content: msg.text });
            } else if (msg.role === 'assistant') {
                out.push({
                    role: 'assistant',
                    content: msg.text || null,
                    ...(msg.toolCalls?.length
                        ? {
                            tool_calls: msg.toolCalls.map((c) => ({
                                id: c.id,
                                type: 'function',
                                function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
                            }))
                        }
                        : {})
                });
            } else if (msg.role === 'tool') {
                out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: JSON.stringify(msg.result) });
            }
        }
        return out;
    }

    async chat({ system, messages, tools = [], signal, onRetry }) {
        if (!this.model) {
            throw new ProviderError('No model is configured for the OpenAI-compatible provider.', {
                kind: 'bad_request'
            });
        }

        const data = await requestJson({
            fetchImpl: this.fetchImpl,
            providerName: this.displayName,
            url: `${this.baseUrl}/chat/completions`,
            headers: this.#headers(),
            body: {
                model: this.model,
                messages: this.#toMessages(system, messages),
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
            // Reasoning models can legitimately take a few minutes.
            timeoutMs: 240000,
            retries: this.retries,
            retryDelayMs: this.retryDelayMs,
            onRetry
        });

        const message = data.choices?.[0]?.message;
        if (!message) {
            throw new ProviderError(`${this.displayName} returned no answer.`, { kind: 'bad_response' });
        }

        const toolCalls = (message.tool_calls || []).map((call, index) => {
            let args = {};
            const rawArgs = call.function?.arguments;
            if (typeof rawArgs === 'string' && rawArgs.trim()) {
                try { args = JSON.parse(rawArgs); } catch { args = {}; }
            } else if (rawArgs && typeof rawArgs === 'object') {
                args = rawArgs;
            }
            return {
                id: call.id || `openai-call-${Date.now()}-${index}`,
                name: call.function?.name,
                args
            };
        });

        return { text: (message.content || '').trim(), toolCalls, raw: null };
    }
}
