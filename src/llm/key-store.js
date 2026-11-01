import { promises as fs } from 'fs';

/**
 * Stores API keys encrypted at rest. The encryption itself is injected (`crypto`) so this class
 * has no Electron dependency; main.js passes an adapter around Electron's `safeStorage`.
 *
 * - Keys are kept per provider type in a small JSON file, base64 of the encrypted bytes.
 * - If the OS cannot provide real encryption (e.g. Linux without a keyring), keys are NOT written
 *   to disk. They are kept in memory for the current session only, and `isPersistent()` is false
 *   so the UI can tell the user.
 * - Keys are only ever returned to main-process code via `get()`. Nothing here is sent to the renderer.
 *
 * @typedef {object} CryptoAdapter
 * @property {() => boolean} isAvailable
 * @property {(plain: string) => Buffer} encrypt
 * @property {(encrypted: Buffer) => string} decrypt
 */
export class KeyStore {
    /**
     * @param {object} opts
     * @param {string} opts.filePath
     * @param {CryptoAdapter} opts.crypto
     */
    constructor({ filePath, crypto }) {
        this.filePath = filePath;
        this.crypto = crypto;
        /** @type {Map<string,string>} */
        this.sessionKeys = new Map();
    }

    isPersistent() {
        try {
            return this.crypto.isAvailable() === true;
        } catch {
            return false;
        }
    }

    async #readFile() {
        try {
            const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    async #writeFile(data) {
        await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }

    /** @returns {Promise<string>} The key, or '' if none is stored. */
    async get(providerType) {
        if (this.sessionKeys.has(providerType)) return this.sessionKeys.get(providerType);
        if (!this.isPersistent()) return '';
        const data = await this.#readFile();
        const encoded = data[providerType];
        if (typeof encoded !== 'string' || !encoded) return '';
        try {
            return this.crypto.decrypt(Buffer.from(encoded, 'base64'));
        } catch {
            // Unreadable (e.g. different OS user or keychain reset). Treat as "no key".
            return '';
        }
    }

    /** Every stored key (all providers). Only for main-process use, e.g. to scrub secrets from messages. */
    async all() {
        const keys = new Set(this.sessionKeys.values());
        if (this.isPersistent()) {
            for (const providerType of Object.keys(await this.#readFile())) {
                const key = await this.get(providerType);
                if (key) keys.add(key);
            }
        }
        return [...keys];
    }

    async has(providerType) {
        return (await this.get(providerType)) !== '';
    }

    /**
     * @returns {Promise<{persisted: boolean}>}
     */
    async set(providerType, apiKey) {
        const key = typeof apiKey === 'string' ? apiKey.trim() : '';
        if (!key) {
            await this.remove(providerType);
            return { persisted: this.isPersistent() };
        }
        if (!this.isPersistent()) {
            this.sessionKeys.set(providerType, key);
            return { persisted: false };
        }
        const data = await this.#readFile();
        data[providerType] = this.crypto.encrypt(key).toString('base64');
        await this.#writeFile(data);
        this.sessionKeys.delete(providerType);
        return { persisted: true };
    }

    async remove(providerType) {
        this.sessionKeys.delete(providerType);
        const data = await this.#readFile();
        if (providerType in data) {
            delete data[providerType];
            await this.#writeFile(data);
        }
    }
}
