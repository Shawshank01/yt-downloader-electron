// Persistent user settings in one JSON file. Electron-free so it can be unit tested.
import { promises as fs } from 'fs';

export class SettingsStore {
    /**
     * @param {object} opts
     * @param {string} opts.filePath
     * @param {object} [opts.firstRunDefaults]  What `read()` returns while no settings file exists yet.
     * @param {(message: string) => void} [opts.log]
     */
    constructor({ filePath, firstRunDefaults = {}, log = () => { } }) {
        this.filePath = filePath;
        this.firstRunDefaults = firstRunDefaults;
        this.log = log;
        this.queue = Promise.resolve();
    }

    /** The saved settings. A missing file means first run; an unreadable one is treated as empty. */
    async read() {
        let text;
        try {
            text = await fs.readFile(this.filePath, 'utf-8');
        } catch (err) {
            if (err.code === 'ENOENT') return { ...this.firstRunDefaults };
            this.log(`Could not read settings: ${err.message}`);
            return {};
        }
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            // fall through
        }
        this.log('The settings file is not valid JSON; ignoring it.');
        return {};
    }

    /**
     * Merge `updates` into the saved settings and return the result. Calls are applied one after
     * another, so concurrent updates cannot overwrite each other. Rejects if the file cannot be written.
     */
    merge(updates) {
        const run = this.queue.then(async () => {
            const merged = { ...(await this.read()), ...updates };
            await this.#write(merged);
            return merged;
        });
        this.queue = run.catch(() => { });
        return run;
    }

    /** Write via a temporary file so a crash cannot leave a half-written settings file. */
    async #write(settings) {
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        try {
            await fs.writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');
            await fs.rename(tempPath, this.filePath);
        } catch (err) {
            await fs.unlink(tempPath).catch(() => { });
            throw err;
        }
    }
}
