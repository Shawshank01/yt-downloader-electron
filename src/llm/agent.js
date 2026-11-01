import { ProviderError } from './errors.js';
import { ValidationError } from './validate.js';
import { getTool, getRisk, getToolDeclarations, TOOL_NAMES } from './tool-registry.js';
import { cancelCurrentTask } from '../core/tools.js';
import { MAX_AGENT_STEPS, MAX_TOOL_RESULT_CHARS } from './limits.js';
import { MESSAGES } from './messages.js';
import { isForeignUrl, extractUrls } from './provenance.js';

const noop = () => { };

/** Keep tool results small enough for the model's context (small local models especially). */
export function shapeResult(result, maxChars) {
    let json = JSON.stringify(result);
    if (json.length <= maxChars) return result;

    const copy = { ...result, truncated: true };
    if (typeof copy.output === 'string') {
        const overflow = json.length - maxChars + 100;
        const keep = Math.max(400, copy.output.length - overflow);
        const head = copy.output.slice(0, Math.floor(keep * 0.6));
        const tail = copy.output.slice(copy.output.length - Math.floor(keep * 0.4));
        copy.output = `${head}\n... [output truncated] ...\n${tail}`;
        json = JSON.stringify(copy);
        if (json.length <= maxChars) return copy;
    }

    // Fallback: keep a prefix of the JSON. Re-serialising escapes quotes, so shrink until it fits.
    let keep = Math.max(200, maxChars - 100);
    let shaped = { ok: result.ok, truncated: true, partial_json: json.slice(0, keep) };
    while (JSON.stringify(shaped).length > maxChars && keep > 50) {
        keep = Math.floor(keep * 0.8);
        shaped = { ok: result.ok, truncated: true, partial_json: json.slice(0, keep) };
    }
    return shaped;
}

function needsConfirmation(confirmMode, toolName, risk) {
    if (toolName === TOOL_NAMES.cancelTask) return false;
    if (confirmMode === 'never') return false;
    if (confirmMode === 'always') return true;
    return risk === 'high';
}

/**
 * Run one user turn through the agent loop.
 *
 * The loop calls the model, executes any tool calls it requests (one at a time, because the
 * app runs a single yt-dlp/ffmpeg task at once), feeds the results back, and repeats until the
 * model answers in plain text or `maxSteps` model calls have been made.
 *
 * @param {object} opts
 * @param {object} opts.provider   An LLM provider (see ./providers).
 * @param {string} opts.system     System prompt.
 * @param {Array}  opts.history    Conversation so far (neutral format). It is mutated in place.
 * @param {string} opts.userText   The new user message.
 * @param {import('./tool-registry.js').ToolContext} opts.ctx
 * @param {(event: object) => void} [opts.onEvent]
 * @param {(request: object) => Promise<boolean>|boolean} [opts.confirm]
 * @param {'always'|'risky'|'never'} [opts.confirmMode]
 * @param {number} [opts.maxSteps]
 * @param {number} [opts.maxResultChars]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text: string, steps: number, stoppedBecause: 'done'|'max_steps'|'aborted'}>}
 */
export async function runAgent({
    provider,
    system,
    history,
    userText,
    ctx,
    onEvent = noop,
    confirm,
    confirmMode = 'risky',
    maxSteps = MAX_AGENT_STEPS,
    maxResultChars = MAX_TOOL_RESULT_CHARS,
    signal
}) {
    const tools = getToolDeclarations();
    history.push({ role: 'user', text: userText });

    let steps = 0;
    const finishAborted = () => {
        cancelCurrentTask();
        const text = MESSAGES.stopped;
        history.push({ role: 'assistant', text });
        onEvent({ type: 'assistant_text', text });
        return { text, steps, stoppedBecause: 'aborted' };
    };

    while (steps < maxSteps) {
        if (signal?.aborted) return finishAborted();

        steps += 1;
        let reply;
        let streamedText = '';
        try {
            reply = await provider.chat({
                system,
                messages: history,
                tools,
                signal,
                onTextDelta: (text) => {
                    streamedText += text;
                    onEvent({ type: 'assistant_delta', text });
                },
                onRetry: (info) => onEvent({ type: 'retrying', provider: provider.displayName || provider.id, ...info })
            });
        } catch (err) {
            if (err instanceof ProviderError && err.kind === 'aborted') return finishAborted();
            throw err;
        }

        if (reply.stats) onEvent({ type: 'model_call', step: steps, ...reply.stats });

        const toolCalls = reply.toolCalls.filter((c) => c.name);
        const replyText = reply.text || streamedText;
        history.push({
            role: 'assistant',
            text: replyText,
            toolCalls,
            ...(reply.raw ? { raw: reply.raw } : {})
        });

        if (toolCalls.length === 0) {
            const text = replyText || MESSAGES.emptyAnswer;
            onEvent({ type: 'assistant_text', text });
            return { text, steps, stoppedBecause: 'done' };
        }

        if (replyText) onEvent({ type: 'assistant_text', text: replyText });

        for (const call of toolCalls) {
            let result;

            if (signal?.aborted) {
                result = { ok: false, error: MESSAGES.cancelledByUser };
            } else {
                result = await executeToolCall(call, { ctx, history, onEvent, confirm, confirmMode, signal });
            }

            history.push({
                role: 'tool',
                toolCallId: call.id,
                providerCallId: call.providerCallId,
                name: call.name,
                result: shapeResult(result, maxResultChars)
            });
        }
    }

    const text = MESSAGES.maxSteps(maxSteps);
    history.push({ role: 'assistant', text });
    onEvent({ type: 'assistant_text', text });
    return { text, steps, stoppedBecause: 'max_steps' };
}

/**
 * The risk of this call. A URL the user never typed (it came from a web page the model read) is
 * treated as high risk, so it needs confirmation in the default "risky" mode.
 * @returns {{risk: 'low'|'high', reason: string|undefined}}
 */
function assessRisk(tool, args, history) {
    const risk = getRisk(tool, args);
    if (typeof args.url === 'string' && isForeignUrl(history, args.url)) {
        return { risk: 'high', reason: MESSAGES.urlNotFromUser };
    }
    return { risk, reason: undefined };
}

async function executeToolCall(call, { ctx, history, onEvent, confirm, confirmMode, signal }) {
    const tool = getTool(call.name);
    if (!tool) {
        return { ok: false, error: `Unknown tool "${call.name}".` };
    }

    const args = call.args && typeof call.args === 'object' ? { ...call.args } : {};

    // Normalize common model parameter hallucinations if the tool expects a 'url'
    if (tool.parameters?.properties?.url) {
        if (!args.url || typeof args.url !== 'string' || !args.url.trim()) {
            const alias = args.link || args.video_url || args.video || args.uri || args.target_url || args.webpage_url;
            if (typeof alias === 'string' && alias.trim()) {
                args.url = alias.trim();
            } else {
                // Find the most recently referenced user-typed URL in history (across turns or earlier tool calls)
                for (let i = history.length - 1; i >= 0; i--) {
                    const msg = history[i];
                    if (msg.role === 'user') {
                        const urls = [...extractUrls(msg.text)];
                        if (urls.length === 1) {
                            args.url = urls[0];
                            break;
                        }
                    } else if (msg.role === 'assistant' && Array.isArray(msg.toolCalls)) {
                        const prevCallWithUrl = msg.toolCalls.find(
                            (tc) => typeof tc.args?.url === 'string' && tc.args.url.trim()
                        );
                        if (prevCallWithUrl && !isForeignUrl(history, prevCallWithUrl.args.url)) {
                            args.url = prevCallWithUrl.args.url.trim();
                            break;
                        }
                    }
                }
            }
            if (call.args && typeof call.args === 'object' && args.url) {
                call.args.url = args.url;
            }
        }
    }

    // Reconcile container and format_code for download_video
    if (call.name === TOOL_NAMES.downloadVideo) {
        if (!args.container) {
            const lastUser = history.findLast((m) => m.role === 'user');
            const userText = lastUser?.text || '';
            if (/\bmkv\b/i.test(userText)) {
                args.container = 'mkv';
            } else if (/\bwebm\b/i.test(userText)) {
                args.container = 'webm';
            } else {
                args.container = 'mp4';
            }
            if (call.args && typeof call.args === 'object' && args.container) {
                call.args.container = args.container;
            }
        }

        if (!args.format_code) {
            const lastUser = history.findLast((m) => m.role === 'user');
            const userText = lastUser?.text || '';
            const userFormatMatch = userText.match(/\b(?:format\s+)?([0-9]{2,4}\+[0-9]{2,4})\b/i);
            if (userFormatMatch) {
                args.format_code = userFormatMatch[1];
            } else if (/^(?:yes|yep|sure|ok|proceed|go ahead|do it|please do|yeah)\b/i.test(userText)) {
                // Check if the previous assistant turn (before the user confirmation) suggested a specific format code
                let lastAssistantText = '';
                for (let i = history.length - 1; i >= 0; i--) {
                    if (history[i].role === 'user') {
                        for (let j = i - 1; j >= 0; j--) {
                            if (history[j].role === 'assistant' && history[j].text) {
                                lastAssistantText = history[j].text;
                                break;
                            }
                        }
                        break;
                    }
                }
                const assistFormatMatch = lastAssistantText.match(/\bformats?\s+([0-9a-zA-Z_-]+(?:\+[0-9a-zA-Z_-]+)?)/i);
                if (assistFormatMatch) {
                    args.format_code = assistFormatMatch[1];
                }
            }
            if (call.args && typeof call.args === 'object' && args.format_code) {
                call.args.format_code = args.format_code;
            }
        }
    }

    const { risk, reason } = assessRisk(tool, args, history);
    const description = safeDescribe(tool, args);

    if (needsConfirmation(confirmMode, tool.name, risk)) {
        const approved = await askConfirmation(confirm, {
            id: call.id, name: tool.name, args, description, risk, reason
        });
        if (!approved) {
            onEvent({ type: 'tool_denied', id: call.id, name: tool.name, description });
            return { ok: false, error: MESSAGES.declinedByUser };
        }
    }

    if (signal?.aborted) return { ok: false, error: MESSAGES.cancelledByUser };

    onEvent({ type: 'tool_start', id: call.id, name: tool.name, args, description, risk });
    let result;
    try {
        result = await tool.run(args, ctx);
    } catch (err) {
        result = {
            ok: false,
            error: err instanceof ValidationError ? err.message : `Tool failed: ${err.message}`
        };
    }
    onEvent({
        type: 'tool_result',
        id: call.id,
        name: tool.name,
        ok: result.ok !== false,
        cancelled: result.cancelled === true,
        result
    });
    return result;
}

/** Ask the user; a missing callback or a throwing callback counts as "no". */
async function askConfirmation(confirm, request) {
    if (!confirm) return false;
    try {
        return (await confirm(request)) === true;
    } catch {
        return false;
    }
}

function safeDescribe(tool, args) {
    try {
        return tool.describe(args);
    } catch {
        return tool.name;
    }
}
