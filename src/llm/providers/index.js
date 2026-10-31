import { ProviderError } from '../errors.js';
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from './gemini.js';
import { OllamaProvider, DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_BASE_URL } from './ollama.js';
import { OpenAICompatibleProvider, DEFAULT_OPENAI_BASE_URL } from './openai-compatible.js';
import { XaiProvider, DEFAULT_XAI_BASE_URL, DEFAULT_XAI_MODEL } from './xai.js';

/** Provider types the app knows about, with the defaults the settings UI should pre-fill. */
export const PROVIDER_TYPES = {
    gemini: { label: 'Google Gemini', defaultModel: DEFAULT_GEMINI_MODEL, needsApiKey: true },
    xai: { label: 'xAI (Grok)', defaultModel: DEFAULT_XAI_MODEL, defaultBaseUrl: DEFAULT_XAI_BASE_URL, needsApiKey: true },
    ollama: { label: 'Ollama (local)', defaultModel: DEFAULT_OLLAMA_MODEL, defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL },
    'openai-compatible': {
        label: 'OpenAI-compatible',
        defaultModel: '',
        defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
        needsApiKey: false
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
