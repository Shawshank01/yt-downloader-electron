import { ProviderError } from '../errors.js';
import { CONNECTION_TEST_TIMEOUT_MS, MODEL_REQUEST_TIMEOUT_MS } from '../limits.js';
import { requestJson, requestStream, DEFAULT_RETRIES } from './http.js';
import { isStreamable, parseStreamJson, readJsonBody, readSse } from './stream.js';


export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * How much the model "thinks" before answering.
 */
export const THINKING_LEVELS = ['low', 'medium', 'high'];
export const DEFAULT_THINKING_LEVEL = 'low';

/**
 * Format a tool declaration for the Interactions API (`tools: [{ type: 'function', ... }]`).
 * Tools without parameters omit the parameters property.
 */
export function toGeminiDeclaration({ name, description, parameters }) {
    const hasProperties = parameters && parameters.properties && Object.keys(parameters.properties).length > 0;
    return {
        type: 'function',
        name,
        description,
        ...(hasProperties ? { parameters } : {})
    };
}

/**
 * Google Gemini via the Interactions API (POST /v1beta/interactions with function calling & streaming).
 *
 * Neutral message format used across providers:
 *   { role: 'user', text }
 *   { role: 'assistant', text, toolCalls: [{ id, name, args, providerCallId? }], raw? }
 *   { role: 'tool', toolCallId, providerCallId?, name, result }
 *
 * Multi-turn state is maintained server-side via `previous_interaction_id`, linking execution
 * steps and function calls without having to resend historical turns.
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

    #headers() {
        return { 'x-goog-api-key': this.apiKey };
    }

    #interactionsUrl() {
        return `${this.baseUrl}/interactions`;
    }

    #modelUrl() {
        return `${this.baseUrl}/models/${encodeURIComponent(this.model)}`;
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
            timeoutMs: CONNECTION_TEST_TIMEOUT_MS
        });
        return { ok: true, message: `Connected to ${info.displayName || info.name || this.model}.` };
    }

    /**
     * Determine `input` and `previous_interaction_id` from the neutral message history.
     * If an earlier assistant message recorded a Gemini interactionId, we chain from it using
     * `previous_interaction_id` and send only subsequent messages (tool results or new user input).
     */
    #toInputAndPreviousId(messages) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return { input: '', previousInteractionId: undefined };
        }

        const lastAssistantIdx = messages.findLastIndex(
            (m) => m.role === 'assistant' && m.raw?.provider === this.id && typeof m.raw?.interactionId === 'string'
        );

        let previousInteractionId;
        let pendingMessages;

        if (lastAssistantIdx !== -1) {
            previousInteractionId = messages[lastAssistantIdx].raw.interactionId;
            pendingMessages = messages.slice(lastAssistantIdx + 1);
        } else {
            pendingMessages = messages;
        }

        // If single user message, send as plain string
        if (pendingMessages.length === 1 && pendingMessages[0].role === 'user') {
            return { input: pendingMessages[0].text, previousInteractionId };
        }

        // Convert pending messages into input items
        const input = [];
        for (const msg of pendingMessages) {
            if (msg.role === 'user') {
                input.push({
                    role: 'user',
                    content: [{ type: 'text', text: msg.text }]
                });
            } else if (msg.role === 'assistant') {
                input.push({
                    role: 'model',
                    content: [{ type: 'text', text: msg.text || '' }]
                });
            } else if (msg.role === 'tool') {
                const textResult = typeof msg.result === 'string'
                    ? msg.result
                    : JSON.stringify(msg.result);
                input.push({
                    type: 'function_result',
                    name: msg.name,
                    call_id: msg.providerCallId || msg.toolCallId,
                    result: [{ type: 'text', text: textResult }]
                });
            }
        }

        return { input: input.length === 1 && typeof input[0] === 'string' ? input[0] : input, previousInteractionId };
    }

    /**
     * @param {object} req
     * @param {string} req.system
     * @param {Array} req.messages
     * @param {Array<{name:string, description:string, parameters:object}>} [req.tools]
     * @param {AbortSignal} [req.signal]
     * @param {(text: string) => void} [req.onTextDelta]  When given, the answer is streamed.
     * @param {(info: object) => void} [req.onRetry]  Called before each automatic retry.
     * @returns {Promise<{text: string, toolCalls: Array, raw: object, stats: object}>}
     */
    async chat({ system, messages, tools = [], signal, onTextDelta, onRetry }) {
        this.#requireKey();

        const { input, previousInteractionId } = this.#toInputAndPreviousId(messages);
        const body = {
            model: this.model,
            input,
            ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
            ...(system ? { system_instruction: system } : {}),
            ...(tools.length > 0 ? { tools: tools.map(toGeminiDeclaration) } : {})
        };
        const options = { signal, onTextDelta, onRetry };

        const startedAt = Date.now();
        let data;
        try {
            data = await this.#generate(body, this.thinkingLevel, options);
        } catch (err) {
            // Older models do not accept thinking_level. Retry once without it
            // instead of failing the whole request.
            const thinkingRejected =
                this.thinkingLevel &&
                err instanceof ProviderError &&
                err.kind === 'bad_request' &&
                /thinking/i.test(err.message);
            if (!thinkingRejected) throw err;
            data = await this.#generate(body, '', options);
        }
        return this.#toReply(data, Date.now() - startedAt);
    }

    /** Call the API (streaming when `onTextDelta` is set) and return one interaction document. */
    async #generate(body, thinkingLevel, { signal, onTextDelta, onRetry }) {
        const payload = thinkingLevel
            ? { ...body, generation_config: { thinking_level: thinkingLevel } }
            : body;

        const request = {
            fetchImpl: this.fetchImpl,
            providerName: this.displayName,
            url: this.#interactionsUrl(),
            headers: this.#headers(),
            body: payload,
            signal,
            model: this.model,
            retries: this.retries,
            retryDelayMs: this.retryDelayMs,
            onRetry
        };

        if (!onTextDelta) {
            return requestJson(request);
        }
        const response = await requestStream({
            ...request,
            headers: { ...this.#headers(), Accept: 'text/event-stream' },
            body: { ...payload, stream: true },
            timeoutMs: MODEL_REQUEST_TIMEOUT_MS
        });
        return this.#readStream(response, signal, onTextDelta);
    }

    /** Read the SSE stream into an interaction-shaped document. */
    async #readStream(response, signal, onTextDelta) {
        if (!isStreamable(response)) return readJsonBody(response, this.displayName);

        let completedInteraction = null;
        let lastInteractionId = null;
        const accumulatedSteps = [];
        let currentStep = null;

        await readSse(response, { signal, providerName: this.displayName }, (payload) => {
            const data = parseStreamJson(payload, this.displayName);

            // 1. interaction.completed or full interaction payload
            if (data.event_type === 'interaction.completed' && data.interaction) {
                completedInteraction = data.interaction;
            } else if (data.interaction) {
                completedInteraction = data.interaction;
                if (data.interaction.id) lastInteractionId = data.interaction.id;
            } else if (data.id && Array.isArray(data.steps)) {
                completedInteraction = data;
            }

            if (data.interaction_id) lastInteractionId = data.interaction_id;
            if (data.id) lastInteractionId = data.id;

            // 2. step.start
            if (data.event_type === 'step.start' || data.type === 'step.start') {
                currentStep = {
                    ...(data.step || {}),
                    index: data.index ?? accumulatedSteps.length
                };
                if (!currentStep.type && data.step?.type) currentStep.type = data.step.type;
                if (data.step?.arguments) {
                    currentStep.arguments = typeof data.step.arguments === 'object'
                        ? JSON.stringify(data.step.arguments)
                        : String(data.step.arguments);
                } else if (data.step?.args) {
                    currentStep.arguments = typeof data.step.args === 'object'
                        ? JSON.stringify(data.step.args)
                        : String(data.step.args);
                }
                accumulatedSteps[currentStep.index] = currentStep;
            }

            // 3. step.delta
            if (data.event_type === 'step.delta' || data.type === 'step.delta') {
                const delta = data.delta;
                if (delta) {
                    if (typeof delta.text === 'string' && delta.type !== 'thought') {
                        onTextDelta(delta.text);
                        const idx = data.index ?? (currentStep ? currentStep.index : 0);
                        if (!accumulatedSteps[idx]) {
                            accumulatedSteps[idx] = { type: 'model_output', content: [{ type: 'text', text: '' }] };
                        }
                        const step = accumulatedSteps[idx];
                        if (typeof step.content === 'string') {
                            step.content += delta.text;
                        } else if (Array.isArray(step.content)) {
                            const lastPart = step.content[step.content.length - 1];
                            if (lastPart && lastPart.type === 'text') {
                                lastPart.text += delta.text;
                            } else {
                                step.content.push({ type: 'text', text: delta.text });
                            }
                        } else {
                            step.content = [{ type: 'text', text: delta.text }];
                        }
                    }
                    const argsDelta = delta.partial_arguments
                        || delta.arguments_delta
                        || delta.arguments
                        || delta.args
                        || (delta.type === 'arguments' && typeof delta.text === 'string' ? delta.text : undefined);
                    if (argsDelta) {
                        const idx = data.index ?? (currentStep ? currentStep.index : 0);
                        if (!accumulatedSteps[idx]) {
                            accumulatedSteps[idx] = { type: 'function_call', arguments: '' };
                        }
                        const step = accumulatedSteps[idx];
                        if (typeof step.arguments === 'string') {
                            step.arguments += argsDelta;
                        } else if (step.arguments && typeof step.arguments === 'object') {
                            step.arguments = JSON.stringify(step.arguments);
                        } else {
                            step.arguments = argsDelta;
                        }
                    }
                }
            }

            // 4. step.stop
            if (data.event_type === 'step.stop' || data.type === 'step.stop') {
                currentStep = null;
            }

            // 5. Fallback for candidate chunks (legacy / backwards compatibility)
            if (data.candidates?.[0]?.content?.parts) {
                const parts = data.candidates[0].content.parts;
                for (const part of parts) {
                    if (typeof part.text === 'string' && !part.thought) {
                        onTextDelta(part.text);
                    }
                }
                const existingModelStep = accumulatedSteps.find((s) => s?.type === 'model_output');
                const textPart = parts.find((p) => typeof p.text === 'string' && !p.thought);
                if (textPart) {
                    if (existingModelStep) {
                        if (Array.isArray(existingModelStep.content)) {
                            existingModelStep.content[0].text += textPart.text;
                        }
                    } else {
                        accumulatedSteps.push({ type: 'model_output', content: [{ type: 'text', text: textPart.text }] });
                    }
                }
                for (const part of parts) {
                    if (part.functionCall) {
                        accumulatedSteps.push({
                            type: 'function_call',
                            id: part.functionCall.id,
                            name: part.functionCall.name,
                            arguments: part.functionCall.args || {}
                        });
                    }
                }
                if (data.usageMetadata && !completedInteraction?.usage) {
                    completedInteraction = { ...completedInteraction, usage: data.usageMetadata };
                }
            }
        });

        if (completedInteraction) {
            if ((!completedInteraction.steps || completedInteraction.steps.length === 0) && accumulatedSteps.length > 0) {
                completedInteraction.steps = accumulatedSteps.filter(Boolean);
            }
            if (!completedInteraction.id) {
                completedInteraction.id = lastInteractionId || `int_${Date.now()}`;
            }
            if (!completedInteraction.status) {
                completedInteraction.status = 'completed';
            }
            return completedInteraction;
        }

        if (accumulatedSteps.length > 0 || lastInteractionId) {
            return {
                id: lastInteractionId || `int_${Date.now()}`,
                status: 'completed',
                model: this.model,
                steps: accumulatedSteps.filter(Boolean)
            };
        }

        throw new ProviderError('Gemini ended the stream without a response.', { kind: 'bad_response' });
    }

    #toReply(data, elapsedMs) {
        if (!data || typeof data !== 'object') {
            throw new ProviderError('Gemini returned no answer (empty response).', { kind: 'bad_response' });
        }

        if (data.promptFeedback?.blockReason) {
            throw new ProviderError(`Gemini returned no answer (${data.promptFeedback.blockReason}).`, { kind: 'bad_response' });
        }

        if (data.status === 'failed') {
            const reason = data.error?.message || data.status;
            throw new ProviderError(`Gemini returned no answer (${reason}).`, { kind: 'bad_response' });
        }

        // Support both Interactions API steps and candidates fallback
        let steps = Array.isArray(data.steps) ? data.steps : [];

        if (steps.length === 0 && Array.isArray(data.candidates)) {
            const candidate = data.candidates[0];
            if (candidate?.finishReason === 'MALFORMED_FUNCTION_CALL') {
                throw new ProviderError('Gemini produced an invalid tool call. Try rephrasing the request.', {
                    kind: 'bad_response'
                });
            }
            if (candidate?.content?.parts) {
                const parts = candidate.content.parts;
                const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
                const toolCalls = parts
                    .filter((p) => p.functionCall)
                    .map((p, idx) => ({
                        id: p.functionCall.id || `gemini-call-${Date.now()}-${idx}`,
                        providerCallId: p.functionCall.id,
                        name: p.functionCall.name,
                        args: p.functionCall.args || {}
                    }));
                const usage = data.usageMetadata || data.usage || {};
                return {
                    text,
                    toolCalls,
                    raw: { provider: this.id, interactionId: data.id || `int_${Date.now()}`, steps: [] },
                    stats: {
                        ms: elapsedMs,
                        thinkingLevel: this.thinkingLevel || 'default',
                        promptTokens: usage.total_input_tokens ?? usage.promptTokenCount,
                        thoughtTokens: usage.total_thought_tokens ?? usage.thoughtsTokenCount,
                        outputTokens: usage.total_output_tokens ?? usage.candidatesTokenCount
                    }
                };
            }
        }

        const textParts = [];
        const toolCalls = [];

        for (const [index, step] of steps.entries()) {
            if (!step || typeof step !== 'object') continue;

            if (step.type === 'model_output') {
                if (typeof step.content === 'string') {
                    textParts.push(step.content);
                } else if (Array.isArray(step.content)) {
                    for (const part of step.content) {
                        if (typeof part.text === 'string' && !part.thought && part.type !== 'thought') {
                            textParts.push(part.text);
                        }
                    }
                } else if (typeof step.text === 'string') {
                    textParts.push(step.text);
                }
            } else if (step.type === 'function_call' || step.type === 'tool_call') {
                let args = {};
                const rawArgs = step.arguments ?? step.args;
                if (typeof rawArgs === 'string' && rawArgs.trim()) {
                    try { args = JSON.parse(rawArgs); } catch { args = {}; }
                } else if (rawArgs && typeof rawArgs === 'object') {
                    args = rawArgs;
                }
                toolCalls.push({
                    id: step.id || step.call_id || `gemini-call-${Date.now()}-${index}`,
                    providerCallId: step.id || step.call_id,
                    name: step.name,
                    args
                });
            }
        }

        let text = textParts.join('').trim();
        if (!text && typeof data.output_text === 'string') {
            text = data.output_text.trim();
        }

        if (!text && toolCalls.length === 0 && data.status !== 'completed' && data.status !== 'requires_action') {
            const reason = data.finishReason || data.status || 'no content';
            throw new ProviderError(`Gemini returned no answer (${reason}).`, { kind: 'bad_response' });
        }

        const usage = data.usage || data.usageMetadata || {};
        return {
            text,
            toolCalls,
            raw: { provider: this.id, interactionId: data.id || `int_${Date.now()}`, steps },
            stats: {
                ms: elapsedMs,
                thinkingLevel: this.thinkingLevel || 'default',
                promptTokens: usage.total_input_tokens ?? usage.promptTokenCount ?? usage.input_tokens,
                thoughtTokens: usage.total_thought_tokens ?? usage.thoughtsTokenCount ?? usage.thought_tokens,
                outputTokens: usage.total_output_tokens ?? usage.candidatesTokenCount ?? usage.output_tokens
            }
        };
    }
}
