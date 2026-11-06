import { promises as fs } from 'fs';
import { ProviderError } from './errors.js';
import { ValidationError } from './validate.js';
import { getTool, getRisk, getToolDeclarations, TOOL_NAMES } from './tool-registry.js';
import { cancelCurrentTask } from '../core/tools.js';
import { MAX_AGENT_STEPS, MAX_TOOL_RESULT_CHARS, MAX_DELETE_FILES } from './limits.js';
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

function needsConfirmation(confirmMode, risk) {
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
    let retriedEmpty = false;
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

        if (toolCalls.length === 0 && !replyText && steps < maxSteps && !retriedEmpty) {
            retriedEmpty = true;
            history.push({
                role: 'assistant',
                text: '',
                toolCalls: [],
                ...(reply.raw ? { raw: reply.raw } : {})
            });
            history.push({
                role: 'user',
                text: MESSAGES.emptyAnswerRetryPrompt
            });
            continue;
        }

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

/**
 * Recover a local file name from recent conversation turns (e.g. list_downloads,
 * download results, previous tool calls, or user mentions) when the model omitted it.
 */
function recoverFileFromHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return undefined;

    const lastUser = history.findLast((m) => m.role === 'user');
    const userText = lastUser?.text || '';

    // 1. Look backwards for recent tool results or tool calls
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === 'tool' && msg.result) {
            // list_downloads tool returns { ok: true, files: [{ name, is_video, ... }] }
            if (Array.isArray(msg.result.files) && msg.result.files.length > 0) {
                const first = msg.result.files[0];
                if (typeof first === 'object' && first?.name) {
                    // If user mentioned part of a file name in their message, match it
                    const matched = msg.result.files.find(
                        (f) => typeof f.name === 'string' && userText.toLowerCase().includes(f.name.toLowerCase())
                    );
                    if (matched) return matched.name;
                    // Otherwise prefer the first video file or the first file
                    const videoFile = msg.result.files.find((f) => f.is_video);
                    return videoFile ? videoFile.name : first.name;
                }
                // download_video, download_audio, etc. return { ok: true, files: ['name.mp4'] }
                if (typeof first === 'string' && first.trim()) {
                    return first.trim();
                }
            }
            if (typeof msg.result.file === 'string' && msg.result.file.trim()) {
                return msg.result.file.trim();
            }
        } else if (msg.role === 'assistant' && Array.isArray(msg.toolCalls)) {
            const prevCallWithFile = msg.toolCalls.find(
                (tc) => typeof tc.args?.file === 'string' && tc.args.file.trim()
            );
            if (prevCallWithFile) {
                return prevCallWithFile.args.file.trim();
            }
        }
    }

    // 2. Check user messages for an explicit media file name (e.g. "my_video.mp4")
    if (userText) {
        const fileMatch = userText.match(
            /\b([^\s"'<>]+\.(?:mp4|mkv|webm|m4a|mp3|opus|flac|wav|mov|avi))\b/i
        );
        if (fileMatch) {
            return fileMatch[1];
        }
    }

    return undefined;
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

    // Normalise common model parameter hallucinations if the tool expects a 'file'
    if (tool.parameters?.properties?.file) {
        if (!args.file || typeof args.file !== 'string' || !args.file.trim()) {
            const alias =
                args.filename ||
                args.file_name ||
                args.filePath ||
                args.filepath ||
                args.file_path ||
                args.name ||
                args.video ||
                args.video_file ||
                args.media ||
                args.path ||
                args.target;
            if (typeof alias === 'string' && alias.trim()) {
                args.file = alias.trim();
            } else {
                args.file = recoverFileFromHistory(history);
            }
            if (call.args && typeof call.args === 'object' && args.file) {
                call.args.file = args.file;
            }
        }
    }

    // Normalise common model parameter hallucinations if the tool expects 'files' (e.g. delete_files)
    if (tool.parameters?.properties?.files) {
        if (!Array.isArray(args.files)) {
            const single =
                (typeof args.files === 'string' && args.files.trim()) ||
                (typeof args.file === 'string' && args.file.trim()) ||
                (typeof args.filename === 'string' && args.filename.trim()) ||
                (typeof args.name === 'string' && args.name.trim());
            if (single && single.toLowerCase() !== 'all' && single !== '*') {
                args.files = [single];
            }
        } else if (args.files.length === 1 && (args.files[0]?.toLowerCase() === 'all' || args.files[0] === '*')) {
            delete args.files;
        }

        // If files are missing, empty, or requested "all", attempt to recover the files to delete
        if (!Array.isArray(args.files) || args.files.length === 0) {
            const lastUser = history.findLast((m) => m.role === 'user');
            const userText = lastUser?.text || '';
            const isAll = /\b(all|everything|all files|clean up)\b/i.test(userText) || args.all === true;

            // 1. Check recent list_downloads result in history
            let filesFromHistory = [];
            for (let i = history.length - 1; i >= 0; i--) {
                const msg = history[i];
                if (msg.role === 'tool' && msg.name === TOOL_NAMES.listDownloads && msg.result?.ok && Array.isArray(msg.result.files)) {
                    filesFromHistory = msg.result.files.map((f) => (typeof f === 'string' ? f : f?.name)).filter(Boolean);
                    break;
                }
            }

            if (isAll) {
                if (filesFromHistory.length > 0) {
                    args.files = filesFromHistory.slice(0, MAX_DELETE_FILES);
                } else if (ctx?.downloadFolder) {
                    try {
                        const entries = await fs.readdir(ctx.downloadFolder, { withFileTypes: true });
                        const diskFiles = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
                        args.files = diskFiles.slice(0, MAX_DELETE_FILES);
                    } catch { /* ignore read error */ }
                }
            } else {
                // Not asking for all: see if user referred to a specific file or if history has a single file
                const recovered = recoverFileFromHistory(history);
                if (recovered) {
                    args.files = [recovered];
                } else if (filesFromHistory.length === 1) {
                    args.files = [filesFromHistory[0]];
                } else if (ctx?.downloadFolder) {
                    try {
                        const entries = await fs.readdir(ctx.downloadFolder, { withFileTypes: true });
                        const diskFiles = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
                        if (diskFiles.length === 1) {
                            args.files = [diskFiles[0]];
                        }
                    } catch { /* ignore read error */ }
                }
            }

            if (call.args && typeof call.args === 'object' && Array.isArray(args.files)) {
                call.args.files = args.files;
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

        if (!args.max_height) {
            const rawHeight = args.height ?? args.resolution ?? args.res ?? args.quality ?? args.maxHeight;
            if (rawHeight !== undefined && rawHeight !== null) {
                const parsed = parseInt(String(rawHeight).replace(/[^0-9]/g, ''), 10);
                if (Number.isInteger(parsed) && parsed >= 144 && parsed <= 4320) {
                    args.max_height = parsed;
                }
            }
        }

        if (!args.max_height) {
            const lastUser = history.findLast((m) => m.role === 'user');
            const userText = lastUser?.text || '';
            const heightMatch = userText.match(/\b(2160|1440|1080|720|480|360|240|144)p?\b/i);
            if (heightMatch) {
                args.max_height = parseInt(heightMatch[1], 10);
            } else if (/\b4k\b/i.test(userText)) {
                args.max_height = 2160;
            } else if (/\b2k\b/i.test(userText)) {
                args.max_height = 1440;
            }
        }
        if (call.args && typeof call.args === 'object' && args.max_height) {
            call.args.max_height = args.max_height;
        }
    }

    // Reconcile format for download_audio and extract_audio_from_file
    if (call.name === TOOL_NAMES.downloadAudio || call.name === TOOL_NAMES.extractAudioFromFile) {
        if (!args.format) {
            const lastUser = history.findLast((m) => m.role === 'user');
            const userText = lastUser?.text || '';
            if (
                /\bmp3\b/i.test(userText) ||
                /\b(compatib|can['’]?t play|won['’]?t play|doesn['’]?t play|not playing|device|car stereo|legacy|player)\b/i.test(userText)
            ) {
                args.format = 'mp3';
            } else if (/\bm4a\b/i.test(userText)) {
                args.format = 'm4a';
            } else if (/\bopus\b/i.test(userText)) {
                args.format = 'opus';
            } else if (/\bflac\b/i.test(userText)) {
                args.format = 'flac';
            } else if (/\bwav\b/i.test(userText)) {
                args.format = 'wav';
            } else {
                args.format = 'best';
            }
            if (call.args && typeof call.args === 'object' && args.format) {
                call.args.format = args.format;
            }
        }
    }

    if (call.name === TOOL_NAMES.deleteFiles && (!Array.isArray(args.files) || args.files.length === 0)) {
        if (ctx?.downloadFolder) {
            try {
                const entries = await fs.readdir(ctx.downloadFolder, { withFileTypes: true });
                const diskFiles = entries.filter((e) => e.isFile() && !e.name.startsWith('.'));
                if (diskFiles.length === 0) {
                    return {
                        ok: true,
                        message: 'There are no files in the download folder to delete.',
                        deleted: [],
                        skipped: []
                    };
                }
            } catch { /* ignore read error */ }
        }
        return {
            ok: false,
            error: 'Please specify which files you want to delete (e.g. from list_downloads).'
        };
    }

    const { risk, reason } = assessRisk(tool, args, history);
    const description = safeDescribe(tool, args);

    if (needsConfirmation(confirmMode, risk)) {
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
