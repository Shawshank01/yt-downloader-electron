import { ProviderError } from '../errors.js';
import { GeminiProvider, DEFAULT_GEMINI_MODEL, THINKING_LEVELS, DEFAULT_THINKING_LEVEL } from './gemini.js';
import { OllamaProvider, DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_BASE_URL } from './ollama.js';
import { OpenAICompatibleProvider, DEFAULT_OPENAI_BASE_URL } from './openai-compatible.js';
import { XaiProvider, DEFAULT_XAI_BASE_URL, DEFAULT_XAI_MODEL, XAI_REASONING_EFFORTS } from './xai.js';

/**
 * Provider types the app knows about, with the defaults the settings UI should pre-fill.
 *
 * Capabilities are declared here so that settings code never has to special-case a provider:
 * - `needsApiKey`       the provider requires an API key.
 * - `editableBaseUrl`   the user may point the provider at another server. Providers that receive an
 *                       API key keep a fixed URL so the key cannot be redirected elsewhere.
 * - `lockedBaseUrlError` if set, attempts to change a fixed URL are rejected with this message
 *                       (otherwise they are silently ignored).
 * - `options`           extra per-provider tuning settings, each `{ choices, default, label }`.
 *                       The option name is also the key passed to the provider's constructor.
 */
export const PROVIDER_TYPES = {
    gemini: {
        label: 'Google Gemini',
        defaultModel: DEFAULT_GEMINI_MODEL,
        needsApiKey: true,
        editableBaseUrl: false,
        options: {
            thinkingLevel: { choices: THINKING_LEVELS, default: DEFAULT_THINKING_LEVEL, label: 'Gemini thinking level' }
        }
    },
    xai: {
        label: 'xAI (Grok)',
        defaultModel: DEFAULT_XAI_MODEL,
        defaultBaseUrl: DEFAULT_XAI_BASE_URL,
        needsApiKey: true,
        editableBaseUrl: false,
        lockedBaseUrlError: 'The xAI server URL is fixed.',
        options: {
            reasoningEffort: { choices: XAI_REASONING_EFFORTS, default: 'none', label: 'xAI reasoning effort' }
        }
    },
    ollama: {
        label: 'Ollama (local)',
        defaultModel: DEFAULT_OLLAMA_MODEL,
        defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL,
        needsApiKey: false,
        editableBaseUrl: true,
        options: {}
    },
    'openai-compatible': {
        label: 'OpenAI-compatible',
        defaultModel: '',
        defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
        needsApiKey: false,
        editableBaseUrl: true,
        options: {}
    }
};

/**
 * Build a provider from saved settings.
 * @param {{type?: string, apiKey?: string, model?: string, baseUrl?: string}} config
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export function createProvider(config = {}, options = {}) {
    const type = config.type || 'gemini';
    const common = { ...config, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };

    switch (type) {
        case 'gemini':
            return new GeminiProvider(common);
        case 'xai':
            return new XaiProvider({
                ...common,
                model: common.model || DEFAULT_XAI_MODEL
            });
        case 'ollama':
            return new OllamaProvider(common);
        case 'openai-compatible':
            return new OpenAICompatibleProvider(common);
        default:
            throw new ProviderError(`Unknown AI provider "${type}".`, { kind: 'bad_request' });
    }
}

export { GeminiProvider, OllamaProvider, OpenAICompatibleProvider, XaiProvider };
