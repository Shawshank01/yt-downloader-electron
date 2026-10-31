// Main-process orchestration for the AI mode. Electron-free so it can be unit tested:
// everything it needs from the app (settings storage, key storage, event delivery) is injected.
import { promises as fs } from 'fs';
import { isAbsolute } from 'path';
import { runAgent } from './agent.js';
import { cancelCurrentTask } from '../core/tools.js';
import { buildSystemPrompt } from './prompt.js';
import { createProvider, PROVIDER_TYPES } from './providers/index.js';
import { XAI_REASONING_EFFORTS } from './providers/xai.js';
import { ProviderError } from './errors.js';

export const MODES = ['classic', 'ai'];
export const CONFIRM_MODES = ['always', 'risky', 'never'];
const THINKING_LEVEL_CHOICES = ['low', 'medium', 'high'];
export const ALLOWED_BROWSERS = ['', 'brave', 'chrome', 'firefox', 'safari'];

const MAX_HISTORY_MESSAGES = 40;
const MAX_USER_MESSAGE_CHARS = 4000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const PROXY_PATTERN = /^(socks5h?|socks4a?|https?):\/\/[A-Za-z0-9.\-[\]:]+\/?$/;

export class AiSettingsError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AiSettingsError';
    }
}

function assertHttpUrl(value, name) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new AiSettingsError(`${name} is not a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AiSettingsError(`${name} must start with http:// or https://.`);
    }
    return value.trim().replace(/\/+$/, '');
}

/** Validate a per-provider config update ({model, baseUrl}) from the renderer. */
export function sanitizeProviderConfig(type, update = {}) {
    const out = {};
    if (update.model !== undefined) {
        const model = String(update.model).trim();
        if (model && !MODEL_PATTERN.test(model)) {
            throw new AiSettingsError('The model name contains unsupported characters.');
        }
        out.model = model;
    }
    if (update.thinkingLevel !== undefined || update.reasoningEffort !== undefined) {
        if (type === 'gemini') {
            if (update.reasoningEffort !== undefined || !THINKING_LEVEL_CHOICES.includes(update.thinkingLevel)) {
                throw new AiSettingsError('Gemini thinking level must be low, medium or high.');
            }
            out.thinkingLevel = update.thinkingLevel;
        } else if (type === 'xai') {
            if (update.thinkingLevel !== undefined || !XAI_REASONING_EFFORTS.includes(update.reasoningEffort)) {
                throw new AiSettingsError('xAI reasoning effort must be none, low, medium, high or xhigh.');
            }
            out.reasoningEffort = update.reasoningEffort;
        } else {
            throw new AiSettingsError('Reasoning effort is not available for this provider.');
        }
    }
    // Gemini always uses Google's endpoint so the API key can never be redirected elsewhere.
    if (update.baseUrl !== undefined && type === 'xai') {
        throw new AiSettingsError('The xAI server URL is fixed.');
    }
    if (update.baseUrl !== undefined && type !== 'gemini') {
        const baseUrl = String(update.baseUrl).trim();
        out.baseUrl = baseUrl ? assertHttpUrl(baseUrl, 'The server URL') : '';
    }
    return out;
}

/** Trim the oldest whole turns so history never starts with a dangling tool result. */
export function trimHistory(history, maxMessages = MAX_HISTORY_MESSAGES) {
    while (history.length > maxMessages) {
        const nextUser = history.findIndex((m, i) => i > 0 && m.role === 'user');
        if (nextUser === -1) break;
        history.splice(0, nextUser);
    }
}

/**
 * @typedef {object} ChatServiceDeps
 * @property {{ read: () => Promise<object>, merge: (updates: object) => Promise<object> }} settings
 * @property {import('./key-store.js').KeyStore} keyStore
 * @property {(event: object) => void} emit            Deliver an event to the renderer.
 * @property {typeof fetch} [fetchImpl]
 * @property {(path: string) => Promise<boolean>} [isDirectory]
 * @property {(message: string) => void} [log]   Diagnostic logging (never receives API keys or message text).
 */
export class ChatService {
    /** @param {ChatServiceDeps} deps */
    constructor({ settings, keyStore, emit, fetchImpl, isDirectory, log }) {
        this.log = log || (() => {});
        this.settings = settings;
        this.keyStore = keyStore;
        this.emit = emit;
        this.fetchImpl = fetchImpl;
        this.isDirectory = isDirectory || (async (p) => {
            try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
        });

        this.history = [];
        this.running = null; // { controller }
        this.pendingConfirmations = new Map();
        this.confirmCounter = 0;
    }

    // ---------- settings ----------

    /** Settings safe to send to the renderer. Never includes API keys. */
    async getSettings() {
        const saved = await this.settings.read();
        const type = PROVIDER_TYPES[saved.aiProvider] ? saved.aiProvider : 'gemini';
        const configs = saved.aiProviderConfigs && typeof saved.aiProviderConfigs === 'object'
            ? saved.aiProviderConfigs
            : {};

        const providers = {};
        for (const [id, info] of Object.entries(PROVIDER_TYPES)) {
            const cfg = configs[id] || {};
            providers[id] = {
                label: info.label,
                needsApiKey: info.needsApiKey === true,
                editableBaseUrl: id !== 'gemini' && id !== 'xai',
                supportsThinkingLevel: id === 'gemini',
                supportsReasoningEffort: id === 'xai',
                thinkingLevel: id === 'gemini' && THINKING_LEVEL_CHOICES.includes(cfg.thinkingLevel) ? cfg.thinkingLevel : 'low',
                reasoningEffort: id === 'xai' && XAI_REASONING_EFFORTS.includes(cfg.reasoningEffort) ? cfg.reasoningEffort : 'none',
                model: cfg.model || info.defaultModel || '',
                baseUrl: cfg.baseUrl || info.defaultBaseUrl || '',
                defaultModel: info.defaultModel || '',
                defaultBaseUrl: info.defaultBaseUrl || '',
                hasApiKey: await this.keyStore.has(id)
            };
        }

        return {
            mode: MODES.includes(saved.aiMode) ? saved.aiMode : 'classic',
            provider: type,
            confirmMode: CONFIRM_MODES.includes(saved.aiConfirmMode) ? saved.aiConfirmMode : 'risky',
            keyStorageSecure: this.keyStore.isPersistent(),
            providers
        };
    }

    /**
     * Update non-secret AI settings.
     * @param {{mode?: string, provider?: string, confirmMode?: string,
     *          providerConfig?: {type: string, model?: string, baseUrl?: string}}} update
     */
    async setSettings(update = {}) {
        const toSave = {};

        if (update.mode !== undefined) {
            if (!MODES.includes(update.mode)) throw new AiSettingsError('Unknown mode.');
            toSave.aiMode = update.mode;
        }
        if (update.provider !== undefined) {
            if (!PROVIDER_TYPES[update.provider]) throw new AiSettingsError('Unknown AI provider.');
            toSave.aiProvider = update.provider;
        }
        if (update.confirmMode !== undefined) {
            if (!CONFIRM_MODES.includes(update.confirmMode)) throw new AiSettingsError('Unknown confirmation mode.');
            toSave.aiConfirmMode = update.confirmMode;
        }
        if (update.providerConfig !== undefined) {
            const { type, ...rest } = update.providerConfig || {};
            if (!PROVIDER_TYPES[type]) throw new AiSettingsError('Unknown AI provider.');
            const current = await this.settings.read();
            const configs = { ...(current.aiProviderConfigs || {}) };
            configs[type] = { ...(configs[type] || {}), ...sanitizeProviderConfig(type, rest) };
            toSave.aiProviderConfigs = configs;
        }

        if (Object.keys(toSave).length > 0) await this.settings.merge(toSave);
        return this.getSettings();
    }

    async setApiKey(type, apiKey) {
        if (!PROVIDER_TYPES[type]) throw new AiSettingsError('Unknown AI provider.');
        if (typeof apiKey !== 'string' || apiKey.length > 500) throw new AiSettingsError('Invalid API key.');
        const { persisted } = await this.keyStore.set(type, apiKey);
        return { persisted, settings: await this.getSettings() };
    }

    async removeApiKey(type) {
        if (!PROVIDER_TYPES[type]) throw new AiSettingsError('Unknown AI provider.');
        await this.keyStore.remove(type);
        return this.getSettings();
    }

    // ---------- providers ----------

    /**
     * Build a provider from saved settings, optionally overridden by unsaved values from the
     * settings form (used by "Test connection").
     */
    async #buildProvider(overrides = {}) {
        const saved = await this.settings.read();
        const type = overrides.type || (PROVIDER_TYPES[saved.aiProvider] ? saved.aiProvider : 'gemini');
        if (!PROVIDER_TYPES[type]) throw new AiSettingsError('Unknown AI provider.');
        const info = PROVIDER_TYPES[type];
        const cfg = (saved.aiProviderConfigs || {})[type] || {};
        const clean = sanitizeProviderConfig(type, {
            ...(overrides.model !== undefined ? { model: overrides.model } : {}),
            ...(overrides.baseUrl !== undefined ? { baseUrl: overrides.baseUrl } : {}),
            ...(overrides.reasoningEffort !== undefined ? { reasoningEffort: overrides.reasoningEffort } : {})
        });

        const apiKey =
            typeof overrides.apiKey === 'string' && overrides.apiKey.trim()
                ? overrides.apiKey.trim()
                : await this.keyStore.get(type);

        const model = clean.model ?? cfg.model ?? '';
        const baseUrl = clean.baseUrl ?? cfg.baseUrl ?? '';

        return createProvider(
            {
                type,
                apiKey,
                model: model || info.defaultModel || undefined,
                baseUrl: type === 'gemini' ? undefined : baseUrl || info.defaultBaseUrl || undefined,
                ...(type === 'gemini' ? { thinkingLevel: clean.thinkingLevel ?? cfg.thinkingLevel } : {}),
                ...(type === 'xai' ? { reasoningEffort: clean.reasoningEffort ?? cfg.reasoningEffort } : {})
            },
            { fetchImpl: this.fetchImpl }
        );
    }

    /** @returns {Promise<{ok: boolean, message: string}>} Never throws. */
    async testConnection(overrides = {}) {
        try {
            const provider = await this.#buildProvider(overrides);
            const result = await provider.testConnection();
            return { ok: result.ok === true, message: this.#redact(result.message, overrides.apiKey) };
        } catch (err) {
            return { ok: false, message: this.#redact(err.message, overrides.apiKey) };
        }
    }

    // ---------- chat ----------

    isBusy() {
        return this.running !== null;
    }

    async #validateContext(context = {}) {
        const downloadFolder = typeof context.downloadFolder === 'string' ? context.downloadFolder.trim() : '';
        if (downloadFolder && (!isAbsolute(downloadFolder) || !(await this.isDirectory(downloadFolder)))) {
            throw new AiSettingsError('The selected download folder does not exist. Choose a folder again.');
        }
        const browser = context.browser || '';
        if (!ALLOWED_BROWSERS.includes(browser)) throw new AiSettingsError('Unsupported cookie browser.');
        const proxy = context.proxy || '';
        if (proxy && !PROXY_PATTERN.test(proxy)) throw new AiSettingsError('The proxy address is not valid.');
        return { downloadFolder, browser, proxy };
    }

    /**
     * Run one user message through the agent.
     * @param {string} message
     * @param {{downloadFolder?: string, browser?: string, proxy?: string}} context  Current UI values.
     * @returns {Promise<{ok: true, text: string, stoppedBecause: string, steps: number}
     *                  | {ok: false, error: {kind: string, message: string}}>}
     */
    async send(message, context = {}) {
        if (this.running) {
            return { ok: false, error: { kind: 'busy', message: 'The assistant is still working on the previous request.' } };
        }
        const text = typeof message === 'string' ? message.trim() : '';
        if (!text) return { ok: false, error: { kind: 'bad_request', message: 'Message is empty.' } };
        if (text.length > MAX_USER_MESSAGE_CHARS) {
            return { ok: false, error: { kind: 'bad_request', message: `Message is too long (max ${MAX_USER_MESSAGE_CHARS} characters).` } };
        }

        const controller = new AbortController();
        this.running = { controller };
        let apiKeyForRedaction = '';

        try {
            const ctx = await this.#validateContext(context);
            const saved = await this.getSettings();
            const type = saved.provider;
            apiKeyForRedaction = await this.keyStore.get(type);
            const provider = await this.#buildProvider();
            this.log(`request started: provider=${provider.id} model=${provider.model} history=${this.history.length}`);

            const system = buildSystemPrompt({
                downloadFolder: ctx.downloadFolder,
                browser: ctx.browser,
                proxyEnabled: Boolean(ctx.proxy)
            });

            trimHistory(this.history);

            const result = await runAgent({
                provider,
                system,
                history: this.history,
                userText: text,
                ctx: { ...ctx, onProgress: (line) => this.emit({ type: 'progress', text: line }) },
                onEvent: (event) => {
                    if (event.type === 'model_call') {
                        // Diagnostics only (timing and token counts); not shown in the chat.
                        this.log(
                            `model call ${event.step}: ${event.ms} ms, thinking=${event.thinkingLevel}, ` +
                            `tokens prompt=${event.promptTokens ?? '?'} thought=${event.thoughtTokens ?? '?'} output=${event.outputTokens ?? '?'}`
                        );
                        return;
                    }
                    if (event.type === 'retrying') {
                        this.log(`retrying after ${event.reason}: attempt ${event.attempt} of ${event.retries}, waiting ${event.delayMs} ms`);
                        this.emit(event);
                        return;
                    }
                    this.log(`event: ${event.type}${event.name ? ` ${event.name}` : ''}${event.ok === false ? ' (failed)' : ''}`);
                    this.emit(event);
                },
                confirm: (request) => this.#requestConfirmation(request),
                confirmMode: saved.confirmMode,
                signal: controller.signal
            });

            this.log(`request finished: ${result.stoppedBecause} after ${result.steps} model call(s), ${result.text.length} characters`);
            return { ok: true, text: result.text, stoppedBecause: result.stoppedBecause, steps: result.steps };
        } catch (err) {
            const kind = err instanceof ProviderError ? err.kind : err instanceof AiSettingsError ? 'settings' : 'unexpected';
            const messageText = this.#redact(err.message || 'Unexpected error.', apiKeyForRedaction);
            this.log(`request failed: kind=${kind} message=${messageText}`);
            // Keep the conversation well-formed: the next turn should see that this one failed.
            if (this.history.length > 0 && this.history[this.history.length - 1].role !== 'assistant') {
                this.history.push({ role: 'assistant', text: `(The request failed: ${messageText})` });
            }
            return { ok: false, error: { kind, message: messageText } };
        } finally {
            this.#denyAllConfirmations();
            this.running = null;
        }
    }

    /** Stop the current request: aborts the model call, cancels the running task, denies prompts. */
    cancel() {
        if (!this.running) return false;
        this.running.controller.abort();
        this.#denyAllConfirmations();
        // A download/encode may be mid-flight inside a tool call; stop it too.
        cancelCurrentTask();
        return true;
    }

    reset() {
        if (this.running) return false;
        this.history = [];
        return true;
    }

    // ---------- confirmations ----------

    #requestConfirmation(request) {
        const requestId = `confirm-${Date.now()}-${++this.confirmCounter}`;
        return new Promise((resolve) => {
            this.pendingConfirmations.set(requestId, resolve);
            this.emit({
                type: 'confirm_request',
                requestId,
                name: request.name,
                description: request.description,
                risk: request.risk,
                args: request.args
            });
        });
    }

    /** Called when the user clicks Allow / Deny in the renderer. */
    resolveConfirmation(requestId, approved) {
        const resolve = this.pendingConfirmations.get(requestId);
        if (!resolve) return false;
        this.pendingConfirmations.delete(requestId);
        resolve(approved === true);
        return true;
    }

    #denyAllConfirmations() {
        for (const [id, resolve] of this.pendingConfirmations) {
            this.pendingConfirmations.delete(id);
            resolve(false);
        }
    }

    #redact(text, ...secrets) {
        let out = String(text ?? '');
        for (const secret of secrets) {
            if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('***');
        }
        return out;
    }
}
