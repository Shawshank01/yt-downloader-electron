import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatService, AiSettingsError, trimHistory } from '../src/llm/chat-service.js';
import { KeyStore } from '../src/llm/key-store.js';

const SECRET = 'AIzaSy-super-secret-key-0000';

const fakeCrypto = {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`ENC:${plain}`, 'utf-8'),
    decrypt: (buf) => buf.toString('utf-8').replace(/^ENC:/, '')
};

async function tempDir() {
    return fs.mkdtemp(join(tmpdir(), 'ytdl-chat-'));
}

/** Queue-based fake fetch (same idea as in providers.test.js). */
function fakeFetch(responses) {
    const calls = [];
    const queue = [...responses];
    const impl = async (url, init) => {
        calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
        const next = typeof queue[0] === 'function' ? await queue.shift()(calls.at(-1)) : queue.shift();
        if (!next) throw new Error('fake fetch: no more responses');
        if (next instanceof Error) throw next;
        const { status = 200, json } = next;
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
    };
    impl.calls = calls;
    return impl;
}

const geminiText = (text) => ({ json: { candidates: [{ content: { role: 'model', parts: [{ text }] } }] } });
const geminiCall = (name, args = {}) => ({
    json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'SIG' }] } }] }
});

async function makeService({ fetchImpl, savedSettings = {}, withKey = true } = {}) {
    const dir = await tempDir();
    let stored = { ...savedSettings };
    const events = [];
    const keyStore = new KeyStore({ filePath: join(dir, 'ai-keys.json'), crypto: fakeCrypto });
    if (withKey) await keyStore.set('gemini', SECRET);
    const service = new ChatService({
        settings: {
            read: async () => ({ ...stored }),
            merge: async (updates) => {
                stored = { ...stored, ...updates };
                return stored;
            }
        },
        keyStore,
        emit: (e) => events.push(e),
        fetchImpl
    });
    return { service, events, keyStore, dir, getStored: () => stored };
}

// ---------- settings ----------

test('getSettings returns safe defaults and never includes API keys', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]) });
    const s = await service.getSettings();
    assert.equal(s.mode, 'classic');
    assert.equal(s.provider, 'gemini');
    assert.equal(s.confirmMode, 'risky');
    assert.equal(s.keyStorageSecure, true);
    assert.equal(s.providers.gemini.model, 'gemini-3.8-flash');
    assert.equal(s.providers.gemini.hasApiKey, true);
    assert.equal(s.providers.ollama.hasApiKey, false);
    assert.equal(s.providers.ollama.baseUrl, 'http://127.0.0.1:11434');
    assert.ok(!JSON.stringify(s).includes(SECRET));
});

test('setSettings validates and persists mode, provider, confirm mode', async () => {
    const { service, getStored } = await makeService({ fetchImpl: fakeFetch([]) });
    const s = await service.setSettings({ mode: 'ai', provider: 'ollama', confirmMode: 'always' });
    assert.equal(s.mode, 'ai');
    assert.equal(s.provider, 'ollama');
    assert.equal(s.confirmMode, 'always');
    assert.equal(getStored().aiMode, 'ai');

    await assert.rejects(service.setSettings({ mode: 'turbo' }), AiSettingsError);
    await assert.rejects(service.setSettings({ provider: 'skynet' }), AiSettingsError);
    await assert.rejects(service.setSettings({ confirmMode: 'yolo' }), AiSettingsError);
});

test('provider configs are kept per provider and validated', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]) });
    await service.setSettings({ providerConfig: { type: 'gemini', model: 'gemini-custom-1' } });
    await service.setSettings({ providerConfig: { type: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434/' } });
    const s = await service.getSettings();
    assert.equal(s.providers.gemini.model, 'gemini-custom-1');
    assert.equal(s.providers.ollama.model, 'llama3.1:8b');
    assert.equal(s.providers.ollama.baseUrl, 'http://localhost:11434');

    await assert.rejects(service.setSettings({ providerConfig: { type: 'ollama', model: 'bad model; rm -rf' } }), AiSettingsError);
    await assert.rejects(service.setSettings({ providerConfig: { type: 'ollama', baseUrl: 'file:///etc/passwd' } }), AiSettingsError);
    await assert.rejects(service.setSettings({ providerConfig: { type: 'ollama', baseUrl: 'nonsense' } }), AiSettingsError);
    await assert.rejects(service.setSettings({ providerConfig: { type: 'nope', model: 'x' } }), AiSettingsError);
});

test('Gemini base URL cannot be changed, so the API key cannot be redirected', async () => {
    const { service, getStored } = await makeService({ fetchImpl: fakeFetch([]) });
    await service.setSettings({ providerConfig: { type: 'gemini', baseUrl: 'https://evil.example.com' } });
    assert.equal(getStored().aiProviderConfigs?.gemini?.baseUrl, undefined);
});

test('API key set/remove updates hasApiKey without revealing the key', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]), withKey: false });
    assert.equal((await service.getSettings()).providers.gemini.hasApiKey, false);

    const res = await service.setApiKey('gemini', SECRET);
    assert.equal(res.persisted, true);
    assert.equal(res.settings.providers.gemini.hasApiKey, true);
    assert.ok(!JSON.stringify(res).includes(SECRET));

    const after = await service.removeApiKey('gemini');
    assert.equal(after.providers.gemini.hasApiKey, false);

    await assert.rejects(service.setApiKey('nope', 'x'), AiSettingsError);
    await assert.rejects(service.setApiKey('gemini', 'x'.repeat(501)), AiSettingsError);
});

// ---------- connection test ----------

test('testConnection uses unsaved form values and redacts the key from errors', async () => {
    const fetchImpl = fakeFetch([{ json: { displayName: 'Gemini 3.8 Flash' } }]);
    const { service } = await makeService({ fetchImpl, withKey: false });
    const ok = await service.testConnection({ type: 'gemini', apiKey: 'typed-but-unsaved-key', model: 'gemini-3.8-flash' });
    assert.equal(ok.ok, true);
    assert.equal(fetchImpl.calls[0].init.headers['x-goog-api-key'], 'typed-but-unsaved-key');

    const leaky = fakeFetch([{ status: 400, json: { error: { message: `API key not valid: ${SECRET}` } } }]);
    const { service: s2 } = await makeService({ fetchImpl: leaky, withKey: false });
    const bad = await s2.testConnection({ type: 'gemini', apiKey: SECRET });
    assert.equal(bad.ok, false);
    assert.ok(!bad.message.includes(SECRET));
});

test('testConnection reports a missing key and never throws', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]), withKey: false });
    const res = await service.testConnection({ type: 'gemini' });
    assert.equal(res.ok, false);
    assert.match(res.message, /API key/);

    const res2 = await service.testConnection({ type: 'gemini', model: 'bad model!' });
    assert.equal(res2.ok, false);
});

// ---------- chat ----------

test('send: full round trip through Gemini with a real tool call', async () => {
    const { service, events, dir } = await makeService({
        fetchImpl: fakeFetch([geminiCall('list_downloads'), geminiText('You have one video.')])
    });
    const folder = await tempDir();
    await fs.writeFile(join(folder, 'clip.mp4'), 'x');

    const res = await service.send('what files do I have?', { downloadFolder: folder, browser: '', proxy: '' });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'You have one video.');
    assert.equal(res.stoppedBecause, 'done');
    assert.deepEqual(events.map((e) => e.type), ['tool_start', 'tool_result', 'assistant_text']);
    assert.equal(events[1].result.files[0].name, 'clip.mp4');
    assert.equal(service.isBusy(), false);
    assert.ok(dir);
});

test('send: the second model call replays the Gemini thought signature', async () => {
    const fetchImpl = fakeFetch([geminiCall('list_downloads'), geminiText('ok')]);
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();
    await service.send('list', { downloadFolder: folder });
    const secondBody = fetchImpl.calls[1].body;
    assert.equal(secondBody.contents[1].parts[0].thoughtSignature, 'SIG');
    assert.ok(secondBody.contents[2].parts[0].functionResponse);
});

test('send: system prompt carries the user context, key is only in the header', async () => {
    const fetchImpl = fakeFetch([geminiText('hi')]);
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();
    await service.send('hello', { downloadFolder: folder, browser: 'chrome', proxy: 'socks5://127.0.0.1:1080/' });
    const call = fetchImpl.calls[0];
    assert.match(call.body.systemInstruction.parts[0].text, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(call.body.systemInstruction.parts[0].text, /chrome/);
    assert.ok(!call.url.includes(SECRET));
    assert.ok(!JSON.stringify(call.body).includes(SECRET));
    assert.equal(call.init.headers['x-goog-api-key'], SECRET);
});

test('send: rejects bad context before calling the model', async () => {
    const fetchImpl = fakeFetch([]);
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();

    for (const [context, pattern] of [
        [{ downloadFolder: '/definitely/not/here' }, /download folder/],
        [{ downloadFolder: 'relative/path' }, /download folder/],
        [{ downloadFolder: folder, browser: 'netscape' }, /browser/],
        [{ downloadFolder: folder, proxy: 'socks5://x; rm -rf /' }, /proxy/]
    ]) {
        const res = await service.send('hi', context);
        assert.equal(res.ok, false);
        assert.equal(res.error.kind, 'settings');
        assert.match(res.error.message, pattern);
    }
    assert.equal(fetchImpl.calls.length, 0);
});

test('send: diagnostic log records the flow but never keys or message text', async () => {
    const lines = [];
    const { service } = await makeService({ fetchImpl: fakeFetch([geminiText('a private answer')]) });
    service.log = (line) => lines.push(line);
    const folder = await tempDir();
    await service.send('my private question', { downloadFolder: folder });
    const log = lines.join('\n');
    assert.match(log, /request started: provider=gemini model=gemini-3\.8-flash/);
    assert.match(log, /event: assistant_text/);
    assert.match(log, /request finished: done/);
    assert.ok(!log.includes(SECRET));
    assert.ok(!log.includes('my private question'));
    assert.ok(!log.includes('a private answer'));
});

test('thinking level: Gemini-only, validated, saved, and used in requests', async () => {
    const fetchImpl = fakeFetch([geminiText('one'), geminiText('two')]);
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();

    let s = await service.getSettings();
    assert.equal(s.providers.gemini.supportsThinkingLevel, true);
    assert.equal(s.providers.gemini.thinkingLevel, 'low');
    assert.equal(s.providers.ollama.supportsThinkingLevel, false);

    await service.send('a', { downloadFolder: folder });
    assert.equal(fetchImpl.calls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'low');

    s = await service.setSettings({ providerConfig: { type: 'gemini', thinkingLevel: 'high' } });
    assert.equal(s.providers.gemini.thinkingLevel, 'high');
    await service.send('b', { downloadFolder: folder });
    assert.equal(fetchImpl.calls[1].body.generationConfig.thinkingConfig.thinkingLevel, 'high');

    await assert.rejects(service.setSettings({ providerConfig: { type: 'gemini', thinkingLevel: 'minimal' } }), AiSettingsError);
    await assert.rejects(service.setSettings({ providerConfig: { type: 'gemini', thinkingLevel: 'x; drop' } }), AiSettingsError);
    await assert.rejects(service.setSettings({ providerConfig: { type: 'ollama', thinkingLevel: 'low' } }), AiSettingsError);
});

test('send: logs timing and token counts for each model call (no content)', async () => {
    const reply = { json: { candidates: [{ content: { parts: [{ text: 'secret answer' }] } }], usageMetadata: { promptTokenCount: 321, thoughtsTokenCount: 45, candidatesTokenCount: 6 } } };
    const { service } = await makeService({ fetchImpl: fakeFetch([reply]) });
    const lines = [];
    service.log = (line) => lines.push(line);
    const events = [];
    const origEmit = service.emit;
    service.emit = (e) => { events.push(e.type); origEmit(e); };
    await service.send('hello', { downloadFolder: await tempDir() });
    const log = lines.join('\n');
    assert.match(log, /model call 1: \d+ ms, thinking=low, tokens prompt=321 thought=45 output=6/);
    assert.ok(!log.includes('secret answer'));
    assert.ok(!events.includes('model_call'), 'diagnostics are not sent to the UI');
});

test('send: a busy server is retried, the UI is told, and the user gets the answer', async () => {
    const fetchImpl = fakeFetch([
        { status: 503, json: { error: { message: 'high demand' } } },
        geminiText('worked on the second try')
    ]);
    const { service, events } = await makeService({ fetchImpl });
    const lines = [];
    service.log = (line) => lines.push(line);

    // Uses the real first retry delay (about 1.5 s).
    const res = await service.send('hi', { downloadFolder: await tempDir() });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'worked on the second try');
    const retrying = events.find((e) => e.type === 'retrying');
    assert.ok(retrying, 'a retrying event reaches the UI');
    assert.equal(retrying.provider, 'Gemini');
    assert.equal(retrying.attempt, 1);
    assert.equal(retrying.reason, 'HTTP 503');
    assert.match(lines.join('\n'), /retrying after HTTP 503: attempt 1 of 3/);
}, { timeout: 15000 });

test('xAI: appears as a provider with its own key slot, defaults, and works end to end', async () => {
    const fetchImpl = fakeFetch([{ json: { choices: [{ message: { content: 'grok here' } }] } }]);
    const { service, events } = await makeService({ fetchImpl });

    let s = await service.getSettings();
    assert.deepEqual(Object.keys(s.providers), ['gemini', 'xai', 'ollama', 'openai-compatible']);
    assert.equal(s.providers.xai.label, 'xAI (Grok)');
    assert.equal(s.providers.xai.needsApiKey, true);
    assert.equal(s.providers.xai.model, 'grok-4.7');
    assert.equal(s.providers.xai.baseUrl, 'https://api.x.ai/v1');
    assert.equal(s.providers.xai.hasApiKey, false);
    assert.equal(s.providers.xai.supportsThinkingLevel, false);
    assert.equal(s.providers.gemini.hasApiKey, true, 'the Gemini key is separate');

    // No key yet: a clear error, and nothing is sent.
    await service.setSettings({ provider: 'xai' });
    const noKey = await service.send('hi', { downloadFolder: await tempDir() });
    assert.equal(noKey.ok, false);
    assert.equal(fetchImpl.calls.length, 0);

    await service.setApiKey('xai', 'xai-test-key-123456');
    s = await service.getSettings();
    assert.equal(s.providers.xai.hasApiKey, true);
    assert.ok(!JSON.stringify(s).includes('xai-test-key-123456'));

    const res = await service.send('hi', { downloadFolder: await tempDir() });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'grok here');
    assert.equal(fetchImpl.calls[0].url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer xai-test-key-123456');
    assert.ok(events.some((e) => e.type === 'assistant_text'));

    // Gemini-only setting is rejected for xAI.
    await assert.rejects(service.setSettings({ providerConfig: { type: 'xai', thinkingLevel: 'low' } }), AiSettingsError);
    // The URL can be changed (unlike Gemini's), but only to http(s).
    await service.setSettings({ providerConfig: { type: 'xai', baseUrl: 'https://eu.api.x.ai/v1/' } });
    assert.equal((await service.getSettings()).providers.xai.baseUrl, 'https://eu.api.x.ai/v1');
    await assert.rejects(service.setSettings({ providerConfig: { type: 'xai', baseUrl: 'ftp://x' } }), AiSettingsError);
});

test('send: rejects empty and oversized messages', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]) });
    assert.equal((await service.send('   ', {})).ok, false);
    assert.equal((await service.send('x'.repeat(5000), {})).ok, false);
    assert.equal((await service.send(42, {})).ok, false);
});

test('send: provider errors come back as { ok: false } and the conversation stays well-formed', async () => {
    const fetchImpl = fakeFetch([
        { status: 429, json: { error: { message: `quota exceeded for ${SECRET}` } } },
        geminiText('back again')
    ]);
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();

    const failed = await service.send('first', { downloadFolder: folder });
    assert.equal(failed.ok, false);
    assert.equal(failed.error.kind, 'rate_limit');
    assert.ok(!failed.error.message.includes(SECRET));
    assert.equal(service.isBusy(), false);

    const second = await service.send('second', { downloadFolder: folder });
    assert.equal(second.ok, true);
    const roles = fetchImpl.calls[1].body.contents.map((c) => c.role);
    assert.deepEqual(roles, ['user', 'model', 'user'], 'failed turn is recorded so roles alternate');
});

test('send: missing API key gives an actionable error', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]), withKey: false });
    const res = await service.send('hi', {});
    assert.equal(res.ok, false);
    assert.equal(res.error.kind, 'auth');
});

test('send: only one request at a time', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchImpl = fakeFetch([async () => { await gate; return geminiText('done'); }]);
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();

    const first = service.send('one', { downloadFolder: folder });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.isBusy(), true);
    const second = await service.send('two', { downloadFolder: folder });
    assert.equal(second.ok, false);
    assert.equal(second.error.kind, 'busy');
    assert.equal(service.reset(), false, 'cannot reset history mid-request');

    release();
    assert.equal((await first).ok, true);
    assert.equal(service.reset(), true);
});

// ---------- confirmations & cancel ----------

test('confirmation: Allow runs the risky tool, Deny blocks it', async () => {
    for (const approve of [true, false]) {
        const folder = await tempDir();
        await fs.writeFile(join(folder, 'tmp.vtt'), 'x');
        const { service, events } = await makeService({
            fetchImpl: fakeFetch([geminiCall('delete_files', { files: ['tmp.vtt'] }), geminiText('finished')])
        });
        const origEmit = service.emit;
        service.emit = (e) => {
            origEmit(e);
            if (e.type === 'confirm_request') {
                assert.equal(e.name, 'delete_files');
                assert.equal(e.risk, 'high');
                assert.match(e.description, /tmp\.vtt/);
                setImmediate(() => assert.equal(service.resolveConfirmation(e.requestId, approve), true));
            }
        };

        const res = await service.send('delete the subtitle', { downloadFolder: folder });
        assert.equal(res.ok, true);
        const exists = await fs.access(join(folder, 'tmp.vtt')).then(() => true, () => false);
        assert.equal(exists, !approve);
        assert.equal(events.some((e) => e.type === 'tool_denied'), !approve);
    }
});

test('resolveConfirmation ignores unknown ids', async () => {
    const { service } = await makeService({ fetchImpl: fakeFetch([]) });
    assert.equal(service.resolveConfirmation('nope', true), false);
});

test('cancel while waiting for confirmation denies it and stops cleanly', async () => {
    const folder = await tempDir();
    await fs.writeFile(join(folder, 'tmp.vtt'), 'x');
    const { service } = await makeService({
        fetchImpl: fakeFetch([geminiCall('delete_files', { files: ['tmp.vtt'] })])
    });
    const origEmit = service.emit;
    service.emit = (e) => {
        origEmit(e);
        if (e.type === 'confirm_request') setImmediate(() => assert.equal(service.cancel(), true));
    };

    const res = await service.send('delete it', { downloadFolder: folder });
    assert.equal(res.ok, true);
    assert.equal(res.stoppedBecause, 'aborted');
    await fs.access(join(folder, 'tmp.vtt'));
    assert.equal(service.isBusy(), false);
    assert.equal(service.cancel(), false, 'nothing left to cancel');
});

test('cancel while the model is thinking aborts the request', async () => {
    const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const { service } = await makeService({ fetchImpl });
    const folder = await tempDir();

    const pending = service.send('slow', { downloadFolder: folder });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(service.cancel(), true);
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.stoppedBecause, 'aborted');
});

// ---------- history ----------

test('trimHistory drops whole oldest turns and never starts mid-turn', () => {
    const history = [];
    for (let i = 0; i < 30; i += 1) {
        history.push({ role: 'user', text: `u${i}` });
        history.push({ role: 'assistant', text: '', toolCalls: [{ id: `${i}`, name: 'x' }] });
        history.push({ role: 'tool', toolCallId: `${i}`, name: 'x', result: {} });
        history.push({ role: 'assistant', text: `a${i}` });
    }
    trimHistory(history, 40);
    assert.ok(history.length <= 40);
    assert.equal(history[0].role, 'user');
    assert.equal(history.at(-1).text, 'a29');

    const short = [{ role: 'user', text: 'a' }];
    trimHistory(short, 40);
    assert.equal(short.length, 1);
});
