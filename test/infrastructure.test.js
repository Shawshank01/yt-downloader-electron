import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsStore } from '../src/settings-store.js';
import { logger, redactArgs, redactText, setLogSink } from '../src/core/logger.js';
import { getBundledExecutablePath } from '../src/dependencies.js';

const tempDir = () => fs.mkdtemp(join(tmpdir(), 'ytdl-infra-test-'));

// ---------- SettingsStore ----------

test('SettingsStore: first run returns the defaults, later runs return what was saved', async () => {
    const filePath = join(await tempDir(), 'settings.json');
    const store = new SettingsStore({ filePath, firstRunDefaults: { aiMode: 'ai' } });
    assert.deepEqual(await store.read(), { aiMode: 'ai' });

    await store.merge({ browser: 'chrome' });
    assert.deepEqual(await store.read(), { aiMode: 'ai', browser: 'chrome' });

    await store.merge({ aiMode: 'classic' });
    assert.equal((await store.read()).aiMode, 'classic');
});

test('SettingsStore: an unreadable file is treated as empty (not first run) and reported', async () => {
    const filePath = join(await tempDir(), 'settings.json');
    await fs.writeFile(filePath, '{not json');
    const logs = [];
    const store = new SettingsStore({ filePath, firstRunDefaults: { aiMode: 'ai' }, log: (m) => logs.push(m) });
    assert.deepEqual(await store.read(), {});
    assert.equal(logs.length, 1);

    await fs.writeFile(filePath, '[1,2]');
    assert.deepEqual(await store.read(), {});
});

test('SettingsStore: concurrent merges do not lose updates', async () => {
    const filePath = join(await tempDir(), 'settings.json');
    const store = new SettingsStore({ filePath });
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.merge({ [`key${i}`]: i })));
    const saved = await store.read();
    assert.equal(Object.keys(saved).length, 25);
});

test('SettingsStore: write failures reject instead of being swallowed, and later writes still work', async () => {
    const dir = await tempDir();
    const store = new SettingsStore({ filePath: join(dir, 'missing-dir', 'settings.json') });
    await assert.rejects(store.merge({ a: 1 }));

    await fs.mkdir(join(dir, 'missing-dir'));
    await store.merge({ a: 1 });
    assert.deepEqual(await store.read(), { a: 1 });
    assert.deepEqual((await fs.readdir(join(dir, 'missing-dir'))).sort(), ['settings.json']);
});

// ---------- logger ----------

test('redaction hides proxy credentials in text and in command lines', () => {
    assert.equal(redactText('via socks5://user:hunter2@127.0.0.1:1080/'), 'via socks5://***@127.0.0.1:1080/');
    assert.equal(redactText('https://example.com/watch?v=1'), 'https://example.com/watch?v=1');
    assert.deepEqual(
        redactArgs(['--proxy', 'socks5://127.0.0.1:1080/', '-P', '/x', 'https://u:p@h/v']),
        ['--proxy', '***', '-P', '/x', 'https://***@h/v']
    );
});

test('logger redacts strings, argument arrays and objects before writing', () => {
    const lines = [];
    setLogSink({ log: (...a) => lines.push(a), warn: () => { }, error: (...a) => lines.push(a) });
    try {
        logger.info('Executing:', ['--proxy', 'socks5://me:secret@h:1/', 'url']);
        logger.error('failed', { proxy: 'socks5://me:secret@h:1/' });
    } finally {
        setLogSink();
    }
    assert.ok(!JSON.stringify(lines).includes('secret'));
    assert.deepEqual(lines[0][1], ['--proxy', '***', 'url']);
});

// ---------- packaged-build detection ----------

test('bundled tools are found in a packaged app (defaultApp is undefined there, not false)', async () => {
    const resourcesPath = await tempDir();
    await fs.mkdir(join(resourcesPath, 'tools'));
    const tool = join(resourcesPath, 'tools', 'yt-dlp');
    await fs.writeFile(tool, '#!/bin/sh\n', { mode: 0o755 });

    const packaged = { defaultApp: undefined, resourcesPath, platform: 'linux' };
    assert.equal(getBundledExecutablePath('yt-dlp', packaged), tool);
    assert.equal(getBundledExecutablePath('ffmpeg', packaged), null, 'missing tool');

    assert.equal(getBundledExecutablePath('yt-dlp', { ...packaged, defaultApp: true }), null, 'dev run via the electron CLI');
    assert.equal(getBundledExecutablePath('yt-dlp', { ...packaged, resourcesPath: undefined }), null, 'no resources path');

    await fs.chmod(tool, 0o644);
    assert.equal(getBundledExecutablePath('yt-dlp', packaged), null, 'not executable');
});

test('on Windows the bundled tool has an .exe suffix and no execute-bit check', async () => {
    const resourcesPath = await tempDir();
    await fs.mkdir(join(resourcesPath, 'tools'));
    const tool = join(resourcesPath, 'tools', 'ffmpeg.exe');
    await fs.writeFile(tool, 'x', { mode: 0o644 });
    assert.equal(getBundledExecutablePath('ffmpeg', { resourcesPath, platform: 'win32' }), tool);
});
