import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (file) => readFileSync(join(src, file), 'utf8');

/** Member names declared at `indent` spaces inside `interface <name> { ... }`. */
function interfaceMembers(dts, name, indent = 4) {
    const body = dts.match(new RegExp(`interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    return [...body.matchAll(new RegExp(`^ {${indent}}(\\w+)\\??:`, 'gm'))].map((m) => m[1]);
}

/** Keys of the object literal exposed by preload.cjs; `ai` has its own nested block. */
function preloadKeys(preload) {
    const [top, aiBlock = ''] = preload.split(/^ {4}ai: \{/m);
    const topKeys = [...top.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
    const aiKeys = [...aiBlock.matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]);
    return { topKeys: [...topKeys, 'ai'], aiKeys };
}

test('electron.d.ts declares exactly what preload.cjs exposes', () => {
    const dts = read('types/electron.d.ts');
    const { topKeys, aiKeys } = preloadKeys(read('preload.cjs'));
    assert.deepEqual(interfaceMembers(dts, 'ElectronAPI').sort(), topKeys.sort());
    assert.deepEqual(interfaceMembers(dts, 'AiApi').sort(), aiKeys.sort());
});

test('every IPC channel the preload invokes has a handler in main.js', () => {
    const channels = [...read('preload.cjs').matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
    const handled = new Set([...read('main.js').matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
    assert.ok(channels.length > 10);
    for (const channel of channels) assert.ok(handled.has(channel), `no ipcMain handler for "${channel}"`);
});
