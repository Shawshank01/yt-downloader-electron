import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/llm/conversation.js';
import { ConfirmationBroker } from '../src/llm/confirmations.js';
import { redactSecrets } from '../src/llm/redact.js';
import { sanitizeProviderConfig, AiSettingsError } from '../src/llm/provider-settings.js';
import { OllamaProvider } from '../src/llm/providers/ollama.js';
import { GeminiProvider } from '../src/llm/providers/gemini.js';
import { ProviderError } from '../src/llm/errors.js';

function streamResponse(chunks, { status = 200 } = {}) {
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            }
        }),
        { status }
    );
}

// ---------- Conversation ----------

test('failTurn answers unanswered tool calls and records the failure', () => {
    const c = new Conversation();
    c.messages.push(
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }] },
        { role: 'tool', toolCallId: 'a', name: 'x', result: { ok: true } }
    );
    c.failTurn('(failed)');
    assert.deepEqual(c.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
    assert.equal(c.messages[3].toolCallId, 'b');
    assert.equal(c.messages[4].text, '(failed)');
});

test('failTurn leaves a finished turn alone and handles a dangling user message', () => {
    const done = new Conversation();
    done.messages.push({ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' });
    done.failTurn('(failed)');
    assert.equal(done.length, 2);

    const dangling = new Conversation();
    dangling.messages.push({ role: 'user', text: 'hi' });
    dangling.failTurn('(failed)');
    assert.deepEqual(dangling.messages.map((m) => m.role), ['user', 'assistant']);

    const empty = new Conversation();
    empty.failTurn('(failed)');
    assert.equal(empty.length, 0);
});

// ---------- ConfirmationBroker ----------

test('an unanswered confirmation is denied after the timeout and cannot be answered later', async () => {
    const broker = new ConfirmationBroker({ timeoutMs: 20 });
    let requestId;
    const approved = await broker.request({ name: 't', description: 'd', risk: 'high', args: {} }, (e) => {
        requestId = e.requestId;
    });
    assert.equal(approved, false);
    assert.equal(broker.resolve(requestId, true), false);
});

test('confirmations resolve once, and denyAll denies the rest', async () => {
    const broker = new ConfirmationBroker({ timeoutMs: 60000 });
    const ids = [];
    const emit = (e) => ids.push(e.requestId);
    const first = broker.request({ name: 'a' }, emit);
    const second = broker.request({ name: 'b' }, emit);
    assert.equal(broker.resolve(ids[0], true), true);
    assert.equal(broker.resolve(ids[0], false), false);
    broker.denyAll();
    assert.equal(await first, true);
    assert.equal(await second, false);
});

// ---------- redaction ----------

test('redactSecrets masks every secret, longest first, and ignores very short ones', () => {
    const out = redactSecrets('keys: abcdef123456 and abcdef and ab', ['abcdef', 'abcdef123456', 'ab', undefined]);
    assert.equal(out, 'keys: *** and *** and ab');
});

// ---------- provider settings ----------

test('provider options come from the provider capabilities', () => {
    assert.deepEqual(sanitizeProviderConfig('gemini', { thinkingLevel: 'high' }), { thinkingLevel: 'high' });
    assert.deepEqual(sanitizeProviderConfig('xai', { reasoningEffort: 'xhigh' }), { reasoningEffort: 'xhigh' });
    assert.throws(() => sanitizeProviderConfig('ollama', { thinkingLevel: 'low' }), AiSettingsError);
    assert.throws(() => sanitizeProviderConfig('gemini', { reasoningEffort: 'low' }), AiSettingsError);
    assert.throws(() => sanitizeProviderConfig('gemini', { thinkingLevel: 'minimal' }), AiSettingsError);
});

// ---------- streaming through the shared HTTP layer ----------

test('Ollama streaming: reads NDJSON, and reports unsupported tools / unreachable server clearly', async () => {
    const lines = [
        JSON.stringify({ message: { content: 'Hel' } }) + '\n',
        JSON.stringify({ message: { content: 'lo', tool_calls: [{ function: { name: 'list_downloads', arguments: {} } }] } }) + '\n'
    ];
    const ok = new OllamaProvider({ fetchImpl: async () => streamResponse(lines) });
    const deltas = [];
    const reply = await ok.chat({ system: '', messages: [{ role: 'user', text: 'hi' }], onTextDelta: (d) => deltas.push(d) });
    assert.equal(reply.text, 'Hello');
    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(reply.toolCalls[0].name, 'list_downloads');

    const noTools = new OllamaProvider({
        fetchImpl: async () =>
            new Response(JSON.stringify({ error: 'registry.ollama.ai/x does not support tools' }), { status: 400 })
    });
    await assert.rejects(
        noTools.chat({ system: '', messages: [], onTextDelta: () => { } }),
        (err) => err instanceof ProviderError && /does not support tool calling/.test(err.message)
    );

    const down = new OllamaProvider({
        retries: 0,
        fetchImpl: async () => { throw new TypeError('fetch failed'); }
    });
    await assert.rejects(
        down.chat({ system: '', messages: [], onTextDelta: () => { } }),
        (err) => err.kind === 'network' && /Is Ollama running/.test(err.message)
    );
});

test('Gemini streaming retries a 503 before the stream starts and rejects invalid stream data', async () => {
    const event = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
    let calls = 0;
    const gemini = new GeminiProvider({
        apiKey: 'k',
        retries: 1,
        retryDelayMs: 1,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return new Response('{"error":{"message":"busy"}}', { status: 503 });
            return streamResponse([event({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })]);
        }
    });
    const reply = await gemini.chat({ system: '', messages: [{ role: 'user', text: 'x' }], onTextDelta: () => { } });
    assert.equal(reply.text, 'ok');
    assert.equal(calls, 2);

    const broken = new GeminiProvider({ apiKey: 'k', fetchImpl: async () => streamResponse(['data: {not json\n\n']) });
    await assert.rejects(
        broken.chat({ system: '', messages: [{ role: 'user', text: 'x' }], onTextDelta: () => { } }),
        (err) => err.kind === 'bad_response'
    );
});

test('Gemini streaming retries without thinkingLevel for models that reject it', async () => {
    const bodies = [];
    const gemini = new GeminiProvider({
        apiKey: 'k',
        thinkingLevel: 'low',
        retries: 0,
        fetchImpl: async (_url, init) => {
            bodies.push(JSON.parse(init.body));
            if (bodies.length === 1) {
                return new Response('{"error":{"message":"Thinking level is not supported"}}', { status: 400 });
            }
            return streamResponse([`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fine' }] } }] })}\n\n`]);
        }
    });
    const reply = await gemini.chat({ system: '', messages: [{ role: 'user', text: 'x' }], onTextDelta: () => { } });
    assert.equal(reply.text, 'fine');
    assert.ok(bodies[0].generationConfig);
    assert.equal(bodies[1].generationConfig, undefined);
});

// ---------- prompt / tool registry consistency ----------

test('TOOL_NAMES and the registered tools are the same set', async () => {
    const { TOOLS, TOOL_NAMES } = await import('../src/llm/tool-registry.js');
    assert.deepEqual([...TOOLS.map((t) => t.name)].sort(), Object.values(TOOL_NAMES).sort());
});

test('the system prompt only mentions tools and parameters that exist', async () => {
    const { getToolDeclarations } = await import('../src/llm/tool-registry.js');
    const { buildSystemPrompt } = await import('../src/llm/prompt.js');
    const known = new Set();
    for (const decl of getToolDeclarations()) {
        known.add(decl.name);
        for (const param of Object.keys(decl.parameters.properties)) known.add(param);
    }
    const prompt = buildSystemPrompt({ downloadFolder: '/x', browser: 'chrome', proxyEnabled: true, platform: 'darwin' });
    const snakeCase = prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [];
    assert.ok(snakeCase.length > 0);
    for (const word of snakeCase) assert.ok(known.has(word), `prompt mentions unknown tool or parameter "${word}"`);
});

// ---------- security ----------

test('settings-schema: only known classic settings with valid values pass', async () => {
    const { sanitizeClassicSettings } = await import('../src/settings-schema.js');
    assert.deepEqual(
        sanitizeClassicSettings({
            downloadFolder: '/Users/me/Videos',
            browser: 'chrome',
            proxyEnabled: true,
            aiProviderConfigs: { ollama: { baseUrl: 'http://evil' } },
            aiMode: 'ai',
            browserX: 'x',
            __proto__: { polluted: true }
        }),
        { downloadFolder: '/Users/me/Videos', browser: 'chrome', proxyEnabled: true }
    );
    assert.deepEqual(sanitizeClassicSettings({ browser: 'netscape', proxyEnabled: 'yes', subtitlePosition: 'left' }), {});
    assert.deepEqual(sanitizeClassicSettings(null), {});
    assert.deepEqual(sanitizeClassicSettings([1, 2]), {});
});

test('resolveInFolder only accepts direct children of the folder', async () => {
    const { resolveInFolder } = await import('../src/llm/tools/files.js');
    assert.equal(resolveInFolder('/data/dl', 'a.mp4'), '/data/dl/a.mp4');
    assert.equal(resolveInFolder('/data/dl', '../a.mp4'), null);
    assert.equal(resolveInFolder('/data/dl', '/etc/passwd'), null);
    assert.equal(resolveInFolder('/data/dl', 'sub/a.mp4'), null);
    assert.equal(resolveInFolder('/data/dl', '.'), null);
});

test('deleteTemporaryFiles only deletes files that a finished task offered', async () => {
    const { promises: fsp } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { deleteTemporaryFiles } = await import('../src/core/tools.js');
    const dir = await fsp.mkdtemp(join(tmpdir(), 'ytdl-tmpdel-'));
    const victim = join(dir, 'precious.txt');
    await fsp.writeFile(victim, 'x');
    await deleteTemporaryFiles([victim]);
    assert.equal(await fsp.readFile(victim, 'utf8'), 'x');
});

test('URLs the user did not type need confirmation, even for low-risk tools', async () => {
    const { runAgent } = await import('../src/llm/agent.js');
    const { isForeignUrl } = await import('../src/llm/provenance.js');
    const history = [{ role: 'user', text: 'please grab https://example.com/watch?v=1.' }];
    assert.equal(isForeignUrl(history, 'https://example.com/watch?v=1'), false);
    assert.equal(isForeignUrl(history, 'https://evil.example/x'), true);
    assert.equal(isForeignUrl(history, '--exec rm'), false, 'malformed values are left to validation');

    const script = [
        { toolCalls: [{ id: '1', name: 'get_video_info', args: { url: 'https://evil.example/x' } }] },
        { text: 'done' }
    ];
    const provider = { id: 's', async chat() { return { text: '', toolCalls: [], raw: null, ...script.shift() }; } };
    const requests = [];
    const res = await runAgent({
        provider, system: '', history: [], userText: 'summarise https://example.com/a', ctx: {},
        confirm: async (request) => { requests.push(request); return false; }
    });
    assert.equal(res.text, 'done');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].risk, 'high');
    assert.match(requests[0].reason, /not in your message/);
});
