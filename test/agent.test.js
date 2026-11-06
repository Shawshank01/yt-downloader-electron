import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgent, shapeResult } from '../src/llm/agent.js';
import { TOOLS, getToolDeclarations, getRisk, getTool } from '../src/llm/tool-registry.js';
import { ProviderError } from '../src/llm/errors.js';
import { buildSystemPrompt } from '../src/llm/prompt.js';
import { resolveFormatCode } from '../src/llm/tools/download.js';
import { MESSAGES } from '../src/llm/messages.js';

/** A scripted provider: returns the queued replies in order and records what it was sent. */
function scriptedProvider(replies) {
    const queue = [...replies];
    const seen = [];
    return {
        id: 'scripted',
        seen,
        async chat({ messages, onTextDelta }) {
            seen.push(JSON.parse(JSON.stringify(messages)));
            const next = queue.shift();
            if (!next) throw new Error('script exhausted');
            if (next instanceof Error) throw next;
            for (const delta of next.deltas || []) onTextDelta?.(delta);
            return { text: '', toolCalls: [], raw: null, ...next };
        }
    };
}

async function makeFolder(files = {}) {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ytdl-agent-test-'));
    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(join(dir, name), content);
    }
    return dir;
}

const call = (name, args, id = `c-${name}`) => ({ id, name, args });

test('every tool has a valid declaration and risk', () => {
    const decls = getToolDeclarations();
    assert.equal(decls.length, TOOLS.length);
    const names = new Set();
    for (const d of decls) {
        assert.ok(d.name && d.description, d.name);
        assert.equal(d.parameters.type, 'object', d.name);
        assert.ok(!names.has(d.name), `duplicate tool ${d.name}`);
        names.add(d.name);
    }
    for (const t of TOOLS) {
        assert.ok(['low', 'high'].includes(getRisk(t, {})), t.name);
    }
    assert.equal(getRisk(getTool('download_video'), { playlist: true }), 'high');
    assert.equal(getRisk(getTool('download_video'), {}), 'low');
    assert.equal(getRisk(getTool('delete_files'), {}), 'high');
});

test('plain answer with no tool calls ends the loop', async () => {
    const provider = scriptedProvider([{ text: 'Hello!' }]);
    const history = [];
    const res = await runAgent({ provider, system: 's', history, userText: 'hi', ctx: {} });
    assert.equal(res.text, 'Hello!');
    assert.equal(res.stoppedBecause, 'done');
    assert.equal(res.steps, 1);
    assert.deepEqual(history.map((m) => m.role), ['user', 'assistant']);
});

test('streamed text is retained when the provider final answer is empty', async () => {
    const provider = scriptedProvider([{ deltas: ['hello ', 'world'] }]);
    const events = [];
    const res = await runAgent({
        provider,
        system: 's',
        history: [],
        userText: 'hi',
        ctx: {},
        onEvent: (event) => events.push(event)
    });
    assert.equal(res.text, 'hello world');
    assert.equal(events.filter((event) => event.type === 'assistant_delta').length, 2);
    assert.equal(events.at(-1).text, 'hello world');
});

test('empty model completion retries once and finishes when answer is provided', async () => {
    const provider = scriptedProvider([{ text: '' }, { text: 'Recovered answer!' }]);
    const history = [];
    const res = await runAgent({ provider, system: 's', history, userText: 'hi', ctx: {} });
    assert.equal(res.text, 'Recovered answer!');
    assert.equal(res.stoppedBecause, 'done');
    assert.equal(res.steps, 2);
    assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.match(history[2].text, /Please answer/);
});

test('consecutive empty completions fall back to emptyAnswer after 1 retry', async () => {
    const provider = scriptedProvider([{ text: '' }, { text: '' }]);
    const history = [];
    const res = await runAgent({ provider, system: 's', history, userText: 'hi', ctx: {} });
    assert.equal(res.text, MESSAGES.emptyAnswer);
    assert.equal(res.stoppedBecause, 'done');
    assert.equal(res.steps, 2);
});

test('tool call → result fed back → final answer (list_downloads against a real folder)', async () => {
    const folder = await makeFolder({ 'a.mp4': 'xx', 'notes.txt': 'y', '.hidden': 'z' });
    const provider = scriptedProvider([
        { toolCalls: [call('list_downloads', {})] },
        { text: 'You have 2 files.' }
    ]);
    const events = [];
    const history = [];
    const res = await runAgent({
        provider, system: 's', history, userText: 'what do I have?',
        ctx: { downloadFolder: folder }, onEvent: (e) => events.push(e)
    });

    assert.equal(res.text, 'You have 2 files.');
    assert.equal(res.steps, 2);
    const toolMsg = history.find((m) => m.role === 'tool');
    assert.equal(toolMsg.result.ok, true);
    assert.deepEqual(toolMsg.result.files.map((f) => f.name).sort(), ['a.mp4', 'notes.txt']);
    assert.equal(toolMsg.result.files.find((f) => f.name === 'a.mp4').is_video, true);
    assert.deepEqual(events.map((e) => e.type), ['tool_start', 'tool_result', 'assistant_text']);
});

test('invalid parameters are returned to the model as errors and never executed', async () => {
    const provider = scriptedProvider([
        { toolCalls: [call('list_formats', { url: '--exec rm -rf /' }), call('download_video', { url: 'file:///etc/passwd' }, 'c2')] },
        { text: 'sorry' }
    ]);
    const history = [];
    await runAgent({ provider, system: 's', history, userText: 'x', ctx: { downloadFolder: '/tmp' } });
    const toolMsgs = history.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    for (const m of toolMsgs) {
        assert.equal(m.result.ok, false);
        assert.match(m.result.error, /url/);
    }
});

test('tool call missing url recovers from unambiguous user URL or alias (small model robustness)', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('list_formats', { link: 'https://youtube.com/watch?v=user-url' })] },
        { toolCalls: [call('list_formats', {})] },
        { text: 'done' }
    ]);
    const history = [];
    const userText = 'what formats does it have\nhttps://youtube.com/watch?v=user-url';
    await runAgent({
        provider,
        system: 's',
        history,
        userText,
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 2);
    // 1. Alias 'link' resolved to 'url'
    assert.equal(starts[0].args.url, 'https://youtube.com/watch?v=user-url');
    assert.equal(starts[0].description, 'List formats for https://youtube.com/watch?v=user-url');
    // 2. Empty args resolved to the single URL from the user message
    assert.equal(starts[1].args.url, 'https://youtube.com/watch?v=user-url');
    assert.equal(starts[1].description, 'List formats for https://youtube.com/watch?v=user-url');
});

test('tool call in follow-up turn missing url recovers URL from earlier conversation turn', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('list_formats', {})] },
        { text: 'done' }
    ]);
    const history = [
        { role: 'user', text: 'formats of this https://youtube.com/watch?v=multi-turn' },
        {
            role: 'assistant',
            text: 'Here are the formats...',
            toolCalls: [{ id: 'c1', name: 'list_formats', args: { url: 'https://youtube.com/watch?v=multi-turn' } }]
        },
        { role: 'tool', toolCallId: 'c1', name: 'list_formats', result: { ok: true, output: '1080p, 720p' } }
    ];
    // In turn 2, the user does not re-paste the URL:
    const userText = 'download 1080p as mp4';
    await runAgent({
        provider,
        system: 's',
        history,
        userText,
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.url, 'https://youtube.com/watch?v=multi-turn');
});

test('download_video reconciles container from user text (e.g. as mp4)', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('download_video', { url: 'https://youtube.com/watch?v=container-test' })] },
        { text: 'done' }
    ]);
    const history = [
        { role: 'user', text: 'formats of https://youtube.com/watch?v=container-test' },
        { role: 'assistant', text: 'Formats...', toolCalls: [] }
    ];
    await runAgent({
        provider,
        system: 's',
        history,
        userText: 'download it as mp4',
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.container, 'mp4');
    assert.match(starts[0].description, /\[mp4\]/);
});

test('download_video reconciles format_code from user text or affirmative response', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('download_video', { url: 'https://youtube.com/watch?v=fmt-test' })] },
        { text: 'done' }
    ]);
    const history = [
        { role: 'user', text: 'formats of https://youtube.com/watch?v=fmt-test' },
        { role: 'assistant', text: 'Would you like me to download formats 299+140 directly as an .mp4?', toolCalls: [] }
    ];
    await runAgent({
        provider,
        system: 's',
        history,
        userText: 'yes',
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.format_code, '299+140');
    assert.equal(starts[0].args.container, 'mp4');
    assert.match(starts[0].description, /format 299\+140/);
});

test('download_audio reconciles format to best by default and mp3 for compatibility/device issues', async () => {
    // 1. Unspecified format defaults to 'best'
    const events1 = [];
    const provider1 = scriptedProvider([
        { toolCalls: [call('download_audio', { url: 'https://youtube.com/watch?v=audio-best' })] },
        { text: 'done' }
    ]);
    await runAgent({
        provider: provider1,
        system: 's',
        history: [],
        userText: 'extract the audio from https://youtube.com/watch?v=audio-best',
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events1.push(e)
    });
    const starts1 = events1.filter((e) => e.type === 'tool_start');
    assert.equal(starts1.length, 1);
    assert.equal(starts1[0].args.format, 'best');
    assert.equal(starts1[0].description, 'Download audio (best) from https://youtube.com/watch?v=audio-best');

    // 2. Mentions device / compatibility issue reconciles to 'mp3'
    const events2 = [];
    const provider2 = scriptedProvider([
        { toolCalls: [call('download_audio', { url: 'https://youtube.com/watch?v=audio-compat' })] },
        { text: 'done' }
    ]);
    const history2 = [
        { role: 'user', text: 'download https://youtube.com/watch?v=audio-compat' },
        { role: 'assistant', text: 'Done', toolCalls: [] }
    ];
    await runAgent({
        provider: provider2,
        system: 's',
        history: history2,
        userText: "Why can't I play it on my device? Please make it compatible with my player",
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events2.push(e)
    });
    const starts2 = events2.filter((e) => e.type === 'tool_start');
    assert.equal(starts2.length, 1);
    assert.equal(starts2[0].args.format, 'mp3');
    assert.equal(starts2[0].description, 'Download audio (mp3) from https://youtube.com/watch?v=audio-compat');
});

test('get_local_media_info resolves filename alias', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('get_local_media_info', { filename: 'clip.mp4' })] },
        { text: 'done' }
    ]);
    const history = [];
    await runAgent({
        provider,
        system: 's',
        history,
        userText: 'inspect clip',
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.file, 'clip.mp4');
    assert.equal(starts[0].description, 'Inspect media info for "clip.mp4"');
});

test('get_local_media_info recovers file from list_downloads in history', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('get_local_media_info', {})] },
        { text: 'done' }
    ]);
    const history = [
        { role: 'user', text: 'what file do i have now' },
        { role: 'assistant', text: 'You have one file:', toolCalls: [{ id: 'c1', name: 'list_downloads', args: {} }] },
        {
            role: 'tool',
            toolCallId: 'c1',
            name: 'list_downloads',
            result: {
                ok: true,
                files: [{ name: 'We Haven Seen THIS Version.mp4', is_video: true }]
            }
        }
    ];

    await runAgent({
        provider,
        system: 's',
        history,
        userText: 'give me the info of this video',
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.file, 'We Haven Seen THIS Version.mp4');
    assert.equal(starts[0].description, 'Inspect media info for "We Haven Seen THIS Version.mp4"');
});

test('get_local_media_info recovers file from download_video in history', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('get_local_media_info', {})] },
        { text: 'done' }
    ]);
    const history = [
        { role: 'user', text: 'download it' },
        { role: 'assistant', text: 'Downloading...', toolCalls: [{ id: 'd1', name: 'download_video', args: { url: 'https://youtube.com/watch?v=xyz' } }] },
        {
            role: 'tool',
            toolCallId: 'd1',
            name: 'download_video',
            result: {
                ok: true,
                files: ['DownloadedVideo.mp4']
            }
        }
    ];

    await runAgent({
        provider,
        system: 's',
        history,
        userText: 'give me the info of this video',
        ctx: { downloadFolder: '/tmp' },
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.file, 'DownloadedVideo.mp4');
    assert.equal(starts[0].description, 'Inspect media info for "DownloadedVideo.mp4"');
});

test('delete_files normalizes string files or file alias to array', async () => {
    const events = [];
    const provider = scriptedProvider([
        { toolCalls: [call('delete_files', { files: 'single.mp4' })] },
        { toolCalls: [call('delete_files', { file: 'another.mp4' })] },
        { text: 'done' }
    ]);
    const history = [];
    await runAgent({
        provider,
        system: 's',
        history,
        userText: 'clean up',
        ctx: { downloadFolder: '/tmp' },
        confirmMode: 'never', // bypass confirm for test
        onEvent: (e) => events.push(e)
    });

    const starts = events.filter((e) => e.type === 'tool_start');
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[0].args.files, ['single.mp4']);
    assert.deepEqual(starts[1].args.files, ['another.mp4']);
});

test('unknown tools and missing download folder are reported, not thrown', async () => {
    const provider = scriptedProvider([
        { toolCalls: [call('rm_rf', {}), call('list_downloads', {}, 'c2')] },
        { text: 'ok' }
    ]);
    const history = [];
    await runAgent({ provider, system: 's', history, userText: 'x', ctx: {} });
    const [unknown, noFolder] = history.filter((m) => m.role === 'tool');
    assert.match(unknown.result.error, /Unknown tool/);
    assert.match(noFolder.result.error, /download folder/);
});

test('high-risk tools need confirmation; declining blocks execution (risky mode)', async () => {
    const folder = await makeFolder({ 'tmp.vtt': 'x' });
    const provider = scriptedProvider([
        { toolCalls: [call('delete_files', { files: ['tmp.vtt'] })] },
        { text: 'not deleted' }
    ]);
    const history = [];
    const events = [];
    const requests = [];
    await runAgent({
        provider, system: 's', history, userText: 'clean up', ctx: { downloadFolder: folder },
        onEvent: (e) => events.push(e.type),
        confirm: async (r) => { requests.push(r); return false; }
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].risk, 'high');
    assert.match(requests[0].description, /tmp\.vtt/);
    assert.deepEqual(events.filter((t) => t.startsWith('tool_')), ['tool_denied']);
    assert.match(history.find((m) => m.role === 'tool').result.error, /declined/);
    await fs.access(join(folder, 'tmp.vtt')); // still there
});

test('approved delete only removes regular files inside the download folder', async () => {
    const folder = await makeFolder({ 'tmp.vtt': 'x', 'keep.mp4': 'y' });
    await fs.mkdir(join(folder, 'subdir'));
    const outside = await makeFolder({ 'victim.txt': 'precious' });

    const provider = scriptedProvider([
        {
            toolCalls: [
                call('delete_files', { files: ['tmp.vtt', 'subdir', 'missing.txt', '../victim.txt', join(outside, 'victim.txt')] })
            ]
        },
        { toolCalls: [call('delete_files', { files: ['tmp.vtt'] }, 'c2')] },
        { text: 'done' }
    ]);
    const history = [];
    await runAgent({
        provider, system: 's', history, userText: 'x', ctx: { downloadFolder: folder },
        confirm: async () => true
    });

    const [first, second] = history.filter((m) => m.role === 'tool');
    // Path-like names are rejected up front by validation, so nothing at all is deleted.
    assert.equal(first.result.ok, false);
    assert.match(first.result.error, /not a path/);
    await fs.access(join(outside, 'victim.txt'));
    // The valid follow-up call (made after the rejected one) deletes only the named file.
    assert.deepEqual(second.result.deleted, ['tmp.vtt']);
    await assert.rejects(fs.access(join(folder, 'tmp.vtt')));
    await fs.access(join(folder, 'keep.mp4'));
});

test('delete_files skips directories and missing files', async () => {
    const folder = await makeFolder({ 'a.txt': '1' });
    await fs.mkdir(join(folder, 'subdir'));
    const res = await getTool('delete_files').run({ files: ['subdir', 'missing.txt', 'a.txt'] }, { downloadFolder: folder });
    assert.deepEqual(res.deleted, ['a.txt']);
    assert.equal(res.skipped.length, 2);
    await fs.access(join(folder, 'subdir'));
});

test('no confirm callback means high-risk actions are denied by default; "never" mode skips prompts', async () => {
    const folder = await makeFolder({ 'tmp.vtt': 'x' });

    const denied = scriptedProvider([{ toolCalls: [call('delete_files', { files: ['tmp.vtt'] })] }, { text: 'k' }]);
    const h1 = [];
    await runAgent({ provider: denied, system: 's', history: h1, userText: 'x', ctx: { downloadFolder: folder } });
    assert.match(h1.find((m) => m.role === 'tool').result.error, /declined/);
    await fs.access(join(folder, 'tmp.vtt'));

    const allowed = scriptedProvider([{ toolCalls: [call('delete_files', { files: ['tmp.vtt'] })] }, { text: 'k' }]);
    const h2 = [];
    await runAgent({ provider: allowed, system: 's', history: h2, userText: 'x', ctx: { downloadFolder: folder }, confirmMode: 'never' });
    assert.deepEqual(h2.find((m) => m.role === 'tool').result.deleted, ['tmp.vtt']);
});

test('"always" mode asks even for low-risk tools', async () => {
    const folder = await makeFolder();
    const provider = scriptedProvider([
        { toolCalls: [call('list_downloads', {})] },
        { text: 'k' }
    ]);
    const asked = [];
    await runAgent({
        provider, system: 's', history: [], userText: 'x', ctx: { downloadFolder: folder }, confirmMode: 'always',
        confirm: async (r) => { asked.push(r.name); return true; }
    });
    assert.deepEqual(asked, ['list_downloads']);
});

test('step limit stops runaway loops', async () => {
    const forever = { toolCalls: [call('list_downloads', {})] };
    const provider = scriptedProvider(Array(10).fill(forever));
    const folder = await makeFolder();
    const res = await runAgent({
        provider, system: 's', history: [], userText: 'x', ctx: { downloadFolder: folder }, maxSteps: 3
    });
    assert.equal(res.stoppedBecause, 'max_steps');
    assert.equal(res.steps, 3);
});

test('abort: pending tool calls get a cancelled result so history stays valid', async () => {
    const controller = new AbortController();
    const folder = await makeFolder();
    const provider = {
        async chat() {
            controller.abort();
            return { text: '', raw: null, toolCalls: [call('list_downloads', {})] };
        }
    };
    const history = [];
    const res = await runAgent({
        provider, system: 's', history, userText: 'x', ctx: { downloadFolder: folder }, signal: controller.signal
    });
    assert.equal(res.stoppedBecause, 'aborted');
    const assistantWithCalls = history.findIndex((m) => m.role === 'assistant' && m.toolCalls?.length);
    assert.equal(history[assistantWithCalls + 1].role, 'tool');
    assert.match(history[assistantWithCalls + 1].result.error, /Cancelled/);
});

test('provider errors propagate; aborted provider errors become a clean stop', async () => {
    const failing = scriptedProvider([new ProviderError('quota', { kind: 'rate_limit' })]);
    await assert.rejects(
        runAgent({ provider: failing, system: 's', history: [], userText: 'x', ctx: {} }),
        (e) => e.kind === 'rate_limit'
    );

    const aborted = scriptedProvider([new ProviderError('cancelled', { kind: 'aborted' })]);
    const res = await runAgent({ provider: aborted, system: 's', history: [], userText: 'x', ctx: {} });
    assert.equal(res.stoppedBecause, 'aborted');
});

test('multi-turn: history from earlier turns is sent to the provider', async () => {
    const provider = scriptedProvider([{ text: 'first' }, { text: 'second' }]);
    const history = [];
    await runAgent({ provider, system: 's', history, userText: 'one', ctx: {} });
    await runAgent({ provider, system: 's', history, userText: 'two', ctx: {} });
    assert.deepEqual(provider.seen[1].map((m) => m.text), ['one', 'first', 'two']);
});

test('shapeResult truncates oversized output but keeps head and tail', () => {
    const output = 'HEAD' + 'x'.repeat(20000) + 'TAIL';
    const shaped = shapeResult({ ok: true, output }, 2000);
    assert.ok(JSON.stringify(shaped).length <= 2000);
    assert.equal(shaped.truncated, true);
    assert.ok(shaped.output.startsWith('HEAD'));
    assert.ok(shaped.output.endsWith('TAIL'));

    const small = { ok: true, output: 'short' };
    assert.equal(shapeResult(small, 2000), small);

    const huge = shapeResult({ ok: true, files: Array(5000).fill('file.mp4') }, 1000);
    assert.ok(JSON.stringify(huge).length <= 1100);
    assert.equal(huge.truncated, true);
});

test('system prompt reflects context and warns about untrusted tool output', () => {
    const p = buildSystemPrompt({ downloadFolder: '/Users/me/Videos', browser: 'chrome', proxyEnabled: true, platform: 'darwin' });
    assert.match(p, /\/Users\/me\/Videos/);
    assert.match(p, /chrome/);
    assert.match(p, /untrusted/);
    assert.match(buildSystemPrompt({}), /No download folder is selected/);
});

test('download_video describes format and container accurately', () => {
    const tool = getTool('download_video');
    assert.equal(
        tool.describe({ url: 'https://example.com/v', max_height: 1080, container: 'mp4' }),
        'Download video https://example.com/v (max 1080p) [mp4]'
    );
    assert.equal(
        tool.describe({ url: 'https://example.com/v', format_code: '299+140', container: 'mp4' }),
        'Download video https://example.com/v (format 299+140) [mp4]'
    );
});

test('reencode_mp4 describe falls back to placeholder when file is omitted', () => {
    const tool = getTool('reencode_mp4');
    assert.equal(
        tool.describe({}),
        'Re-encode "video" to MP4 (H.264/AAC); an existing .mp4 of the same name is replaced'
    );
});

test('resolveFormatCode adds resilient fallbacks for paired streams and multi-language track codes', () => {
    assert.equal(
        resolveFormatCode('137+140'),
        '137+140/137+ba[acodec^=mp4a]/137+ba'
    );
    assert.equal(
        resolveFormatCode('299+140'),
        '299+140/299+ba[acodec^=mp4a]/299+ba'
    );
    assert.equal(
        resolveFormatCode('248+251'),
        '248+251/248+ba[acodec^=opus]/248+ba'
    );
    assert.equal(
        resolveFormatCode('137+140-2'),
        '137+140-2/137+ba'
    );
    assert.equal(
        resolveFormatCode('140'),
        '140/ba[acodec^=mp4a]/ba'
    );
    assert.equal(
        resolveFormatCode('251'),
        '251/ba[acodec^=opus]/ba'
    );
    assert.equal(resolveFormatCode('18'), '18');
    assert.equal(resolveFormatCode('137+140/best'), '137+140/best');
    assert.equal(resolveFormatCode(undefined), undefined);
});

