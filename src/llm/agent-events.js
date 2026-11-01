/**
 * Build the `onEvent` handler for one agent run: diagnostics go to `log` (never message text or keys),
 * and events the user should see are forwarded to `emit`.
 *
 * @param {{log: (line: string) => void, emit: (event: object) => void}} sinks
 * @returns {(event: object) => void}
 */
export function createEventHandler({ log, emit }) {
    return (event) => {
        switch (event.type) {
            case 'model_call':
                // Timing and token counts only; not shown in the chat.
                log(
                    `model call ${event.step}: ${event.ms} ms, thinking=${event.thinkingLevel}, ` +
                    `tokens prompt=${event.promptTokens ?? '?'} thought=${event.thoughtTokens ?? '?'} output=${event.outputTokens ?? '?'}`
                );
                return;
            case 'retrying':
                log(`retrying after ${event.reason}: attempt ${event.attempt} of ${event.retries}, waiting ${event.delayMs} ms`);
                emit(event);
                return;
            default:
                log(`event: ${event.type}${event.name ? ` ${event.name}` : ''}${event.ok === false ? ' (failed)' : ''}`);
                emit(event);
        }
    };
}
