import { CONFIRMATION_TIMEOUT_MS } from './limits.js';

/**
 * Tracks the confirmation prompts that are waiting for the user.
 *
 * Every request settles exactly once: the user answers, the request is denied (cancel / end of
 * turn), or the timeout expires. A timed-out or denied request resolves to `false`, which the agent
 * reports to the model as "the user declined" (and the UI uses to close the dialog).
 */
export class ConfirmationBroker {
    /** @param {{timeoutMs?: number}} [options]  How long to wait before an unanswered prompt counts as "no". */
    constructor({ timeoutMs = CONFIRMATION_TIMEOUT_MS } = {}) {
        this.timeoutMs = timeoutMs;
        this.counter = 0;
        /** @type {Map<string, (approved: boolean) => void>} */
        this.pending = new Map();
    }

    /**
     * Ask the user.
     * @param {{name: string, description: string, risk: string, reason?: string, args: object}} request
     * @param {(event: object) => void} emit  Delivers the prompt to the user's window.
     * @returns {Promise<boolean>}
     */
    request(request, emit) {
        const requestId = `confirm-${Date.now()}-${++this.counter}`;
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.resolve(requestId, false), this.timeoutMs);
            this.pending.set(requestId, (approved) => {
                clearTimeout(timer);
                resolve(approved);
            });
            emit({
                type: 'confirm_request',
                requestId,
                name: request.name,
                description: request.description,
                risk: request.risk,
                reason: request.reason,
                args: request.args
            });
        });
    }

    /** Called when the user clicks Allow / Deny. Returns false for unknown or already settled ids. */
    resolve(requestId, approved) {
        const settle = this.pending.get(requestId);
        if (!settle) return false;
        this.pending.delete(requestId);
        settle(approved === true);
        return true;
    }

    denyAll() {
        for (const id of [...this.pending.keys()]) this.resolve(id, false);
    }
}
