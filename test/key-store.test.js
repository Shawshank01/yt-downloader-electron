import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KeyStore } from '../src/llm/key-store.js';

// Reversible stand-in for Electron's safeStorage. It only needs to differ from the plaintext.
const fakeCrypto = (available = true) => ({
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(`ENC:${[...plain].reverse().join('')}`, 'utf-8'),
    decrypt: (buf) => {
        const text = buf.toString('utf-8');
        if (!text.startsWith('ENC:')) throw new Error('cannot decrypt');
        return [...text.slice(4)].reverse().join('');
    }
});

async function tempFile() {
    const dir = await fs.mkdtemp(join(tmpdir(), 'ytdl-keystore-'));
    return join(dir, 'ai-keys.json');
}

test('stores keys encrypted on disk and reads them back', async () => {
    const filePath = await tempFile();
    const store = new KeyStore({ filePath, crypto: fakeCrypto() });

    assert.equal(await store.has('gemini'), false);
    const res = await store.set('gemini', '  AIza-SECRET-KEY-123  ');
    assert.deepEqual(res, { persisted: true });

    assert.equal(await store.get('gemini'), 'AIza-SECRET-KEY-123');
    assert.equal(await store.has('gemini'), true);

    const onDisk = await fs.readFile(filePath, 'utf-8');
    assert.ok(!onDisk.includes('AIza-SECRET-KEY-123'), 'plaintext key must not be on disk');
    assert.ok(!onDisk.includes('321-YEK-TERCES-azIA'), 'reversed form is still plaintext-derived and must not appear raw');

    // A new instance (app restart) can still read it.
    const again = new KeyStore({ filePath, crypto: fakeCrypto() });
    assert.equal(await again.get('gemini'), 'AIza-SECRET-KEY-123');
});

test('keys are stored per provider and can be removed', async () => {
    const store = new KeyStore({ filePath: await tempFile(), crypto: fakeCrypto() });
    await store.set('gemini', 'key-one-aaaa');
    await store.set('openai-compatible', 'key-two-bbbb');
    assert.equal(await store.get('gemini'), 'key-one-aaaa');
    assert.equal(await store.get('openai-compatible'), 'key-two-bbbb');

    await store.remove('gemini');
    assert.equal(await store.has('gemini'), false);
    assert.equal(await store.get('openai-compatible'), 'key-two-bbbb');
});

test('setting an empty key removes the stored key', async () => {
    const store = new KeyStore({ filePath: await tempFile(), crypto: fakeCrypto() });
    await store.set('gemini', 'key-one-aaaa');
    await store.set('gemini', '   ');
    assert.equal(await store.has('gemini'), false);
});

test('without OS encryption keys stay in memory only and are never written to disk', async () => {
    const filePath = await tempFile();
    const store = new KeyStore({ filePath, crypto: fakeCrypto(false) });
    assert.equal(store.isPersistent(), false);

    assert.deepEqual(await store.set('gemini', 'memory-only-key'), { persisted: false });
    assert.equal(await store.get('gemini'), 'memory-only-key');
    await assert.rejects(fs.access(filePath), 'no file should have been created');

    const restarted = new KeyStore({ filePath, crypto: fakeCrypto(false) });
    assert.equal(await restarted.has('gemini'), false);
});

test('unreadable or corrupt data is treated as "no key", not a crash', async () => {
    const filePath = await tempFile();
    await fs.writeFile(filePath, JSON.stringify({ gemini: Buffer.from('garbage').toString('base64') }));
    const store = new KeyStore({ filePath, crypto: fakeCrypto() });
    assert.equal(await store.get('gemini'), '');

    await fs.writeFile(filePath, 'not json at all');
    assert.equal(await store.get('gemini'), '');
    // And it can recover by saving a new key.
    await store.set('gemini', 'fresh-key-1234');
    assert.equal(await store.get('gemini'), 'fresh-key-1234');
});

test('a crypto adapter that throws counts as unavailable', async () => {
    const store = new KeyStore({
        filePath: await tempFile(),
        crypto: { isAvailable: () => { throw new Error('boom'); }, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
    });
    assert.equal(store.isPersistent(), false);
});
