import { MAX_HISTORY_MESSAGES } from './limits.js';
import { MESSAGES } from './messages.js';

const DEFAULT_MAX_MESSAGES = MAX_HISTORY_MESSAGES;

/** Trim the oldest whole turns so history never starts with a dangling tool result. */
export function trimHistory(history, maxMessages = DEFAULT_MAX_MESSAGES) {
    while (history.length > maxMessages) {
        const nextUser = history.findIndex((m, i) => i > 0 && m.role === 'user');
        if (nextUser === -1) break;
        history.splice(0, nextUser);
    }
}

/**
 * The conversation sent to the model, in the provider-neutral message format.
 *
 * This class owns the invariants providers rely on: the history is bounded, it never starts in the
 * middle of a turn, and every tool call is answered before the next user message. The agent loop
 * appends to `messages` while a turn runs; `failTurn` restores the invariants if the turn dies.
 */
export class Conversation {
    constructor({ maxMessages = DEFAULT_MAX_MESSAGES } = {}) {
        this.maxMessages = maxMessages;
        this.messages = [];
    }

    get length() {
        return this.messages.length;
    }

    /** Call before running a new user message. */
    startTurn() {
        trimHistory(this.messages, this.maxMessages);
    }

    /**
     * Close a turn that ended with an error: answer any tool calls that never got a result and record
     * the failure, so the next turn (and the model) can see what happened.
     */
    failTurn(text) {
        const messages = this.messages;
        if (messages.length === 0) return;

        const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
        if (lastAssistant !== -1) {
            const answered = new Set(
                messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => m.toolCallId)
            );
            for (const call of messages[lastAssistant].toolCalls || []) {
                if (answered.has(call.id)) continue;
                messages.push({
                    role: 'tool',
                    toolCallId: call.id,
                    providerCallId: call.providerCallId,
                    name: call.name,
                    result: { ok: false, error: MESSAGES.toolNotRun }
                });
            }
        }

        if (messages[messages.length - 1].role !== 'assistant') {
            messages.push({ role: 'assistant', text });
        }
    }

    reset() {
        this.messages = [];
    }
}
