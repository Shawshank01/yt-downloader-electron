// AI settings: reading/validating/saving them, API key slots, and turning the saved settings into a
// provider. Electron-free; storage is injected.
import { createProvider, PROVIDER_TYPES } from './providers/index.js';
import {
    AiSettingsError,
    MODES,
    CONFIRM_MODES,
    assertKnownProvider,
    normalizeProviderType,
    resolveProviderOptions,
    sanitizeProviderConfig
} from './provider-settings.js';

import { MAX_API_KEY_CHARS } from './limits.js';

export class AiSettings {
    /**
     * @param {object} deps
     * @param {{ read: () => Promise<object>, merge: (updates: object) => Promise<object> }} deps.store
     * @param {import('./key-store.js').KeyStore} deps.keyStore
     * @param {typeof fetch} [deps.fetchImpl]
     */
    constructor({ store, keyStore, fetchImpl }) {
        this.store = store;
        this.keyStore = keyStore;
        this.fetchImpl = fetchImpl;
    }

    /** Settings safe to send to the renderer. Never includes API keys. */
    async get() {
        const saved = await this.store.read();
        const configs =
            saved.aiProviderConfigs && typeof saved.aiProviderConfigs === 'object' ? saved.aiProviderConfigs : {};

        const providers = {};
        for (const [id, info] of Object.entries(PROVIDER_TYPES)) {
            const cfg = configs[id] || {};
            const options = resolveProviderOptions(id, cfg);
            providers[id] = {
                label: info.label,
                needsApiKey: info.needsApiKey,
                editableBaseUrl: info.editableBaseUrl,
                supportsThinkingLevel: 'thinkingLevel' in info.options,
                supportsReasoningEffort: 'reasoningEffort' in info.options,
                thinkingLevel: options.thinkingLevel ?? '',
                reasoningEffort: options.reasoningEffort ?? '',
                model: cfg.model || info.defaultModel || '',
                baseUrl: (info.editableBaseUrl && cfg.baseUrl) || info.defaultBaseUrl || '',
                defaultModel: info.defaultModel || '',
                defaultBaseUrl: info.defaultBaseUrl || '',
                hasApiKey: await this.keyStore.has(id)
            };
        }

        return {
            mode: MODES.includes(saved.aiMode) ? saved.aiMode : 'classic',
            provider: normalizeProviderType(saved.aiProvider),
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
    async set(update = {}) {
        const toSave = {};

        if (update.mode !== undefined) {
            if (!MODES.includes(update.mode)) throw new AiSettingsError('Unknown mode.');
            toSave.aiMode = update.mode;
        }
        if (update.provider !== undefined) {
            assertKnownProvider(update.provider);
            toSave.aiProvider = update.provider;
        }
        if (update.confirmMode !== undefined) {
            if (!CONFIRM_MODES.includes(update.confirmMode)) throw new AiSettingsError('Unknown confirmation mode.');
            toSave.aiConfirmMode = update.confirmMode;
        }
        if (update.providerConfig !== undefined) {
            const { type, ...rest } = update.providerConfig || {};
            assertKnownProvider(type);
            const current = await this.store.read();
            const configs = { ...(current.aiProviderConfigs || {}) };
            configs[type] = { ...(configs[type] || {}), ...sanitizeProviderConfig(type, rest) };
            toSave.aiProviderConfigs = configs;
        }

        if (Object.keys(toSave).length > 0) await this.store.merge(toSave);
        return this.get();
    }

    async setApiKey(type, apiKey) {
        assertKnownProvider(type);
        if (typeof apiKey !== 'string' || apiKey.length > MAX_API_KEY_CHARS) {
            throw new AiSettingsError('Invalid API key.');
        }
        const { persisted } = await this.keyStore.set(type, apiKey);
        return { persisted, settings: await this.get() };
    }

    async removeApiKey(type) {
        assertKnownProvider(type);
        await this.keyStore.remove(type);
        return this.get();
    }

    /** Every API key that must never appear in messages: all stored keys plus any `extra` typed ones. */
    async secrets(...extra) {
        return [...(await this.keyStore.all()), ...extra.filter((s) => typeof s === 'string')];
    }

    /**
     * Build a provider from the saved settings, optionally overridden by unsaved values from the
     * settings form (used by "Test connection").
     */
    async buildProvider(overrides = {}) {
        const saved = await this.store.read();
        const type = overrides.type || normalizeProviderType(saved.aiProvider);
        const info = assertKnownProvider(type);
        const cfg = (saved.aiProviderConfigs || {})[type] || {};
        const clean = sanitizeProviderConfig(type, overrides);

        const typedKey = typeof overrides.apiKey === 'string' ? overrides.apiKey.trim() : '';
        const apiKey = typedKey || (await this.keyStore.get(type));

        const model = clean.model ?? cfg.model ?? '';
        const baseUrl = info.editableBaseUrl ? clean.baseUrl ?? cfg.baseUrl ?? '' : '';

        return createProvider(
            {
                type,
                apiKey,
                model: model || info.defaultModel || undefined,
                baseUrl: baseUrl || info.defaultBaseUrl || undefined,
                ...resolveProviderOptions(type, { ...cfg, ...clean })
            },
            { fetchImpl: this.fetchImpl }
        );
    }
}
