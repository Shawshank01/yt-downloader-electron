import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static checks that catch the most common UI wiring mistakes without needing a window:
// a script looking up an element id that does not exist, or the preload/IPC names drifting apart.
const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf-8');
const aiUi = readFileSync(new URL('../src/ai-ui.js', import.meta.url), 'utf-8');
const preload = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf-8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf-8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf-8');
const rendererScript = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf-8');

const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

test('html ids are unique', () => {
    const dupes = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
    assert.deepEqual(dupes, []);
});

test('every id looked up by ai-ui.js exists in index.html', () => {
    const used = new Set([...aiUi.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    assert.ok(used.size > 20, 'expected to find many lookups');
    const missing = [...used].filter((id) => !htmlIds.includes(id));
    assert.deepEqual(missing, []);
});

test('scripts are loaded in the right order', () => {
    const renderer = html.indexOf('src="renderer.js"');
    const markdown = html.indexOf('src="markdown.js"');
    const ai = html.indexOf('src="ai-ui.js"');
    assert.ok(renderer !== -1 && markdown !== -1 && ai !== -1);
    assert.ok(renderer < markdown && markdown < ai, 'markdown.js must load before ai-ui.js');
});

test('assistant messages are rendered as Markdown, user and error messages as plain text', () => {
    assert.match(aiUi, /kind === 'assistant' && window\.MarkdownLite/);
    assert.match(aiUi, /window\.MarkdownLite\.render\(text, document/);
    assert.match(aiUi, /el\.textContent = text;/, 'plain-text fallback exists');
});

test('streaming responses render as Markdown live on every text delta', () => {
    assert.match(aiUi, /streamingText\s*\+=\s*event\.text/);
    assert.match(aiUi, /updateStreamingMessage\(streamingText\)/);
});

test('every preload ai.* method maps to an ipcMain handler', () => {
    const channels = [...preload.matchAll(/ipcRenderer\.invoke\('(ai-[a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(channels.length >= 8);
    for (const channel of channels) {
        assert.ok(main.includes(`ipcMain.handle('${channel}'`), `missing handler for ${channel}`);
    }
});

test('ai-ui.js only calls API methods that preload exposes', () => {
    const exposed = new Set(
        [...preload.slice(preload.indexOf('ai: {')).matchAll(/^\s{8}(\w+): /gm)].map((m) => m[1])
    );
    const called = [...aiUi.matchAll(/\bapi\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(called.length > 5);
    const unknown = [...new Set(called)].filter((name) => !exposed.has(name));
    assert.deepEqual(unknown, []);
});

test('AI mode hides every classic-only control via CSS and the switch is wired', () => {
    assert.match(css, /body\[data-mode='ai'\] \.classic-only\s*\{\s*display:\s*none !important/);
    for (const id of ['url', 'action', 'formatCodeGroup', 'codecGroup', 'subtitlePositionGroup', 'cancelActionControls', 'output']) {
        const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
        const inClassicGroup = html.match(new RegExp(`<div[^>]*classic-only[^>]*>(?:(?!</div>)[\\s\\S])*id="${id}"`));
        assert.ok(/classic-only/.test(tag) || inClassicGroup, `${id} should be hidden in AI mode`);
    }
    // These must stay usable in AI mode because they feed the assistant's context.
    for (const id of ['downloadFolder', 'browser', 'proxyEnabled', 'proxyAddress']) {
        const group = html.match(new RegExp(`<div[^>]*class="input-group[^"]*"[^>]*>(?:(?!<div class="input-group)[\\s\\S])*?id="${id}"`));
        assert.ok(!group || !/classic-only/.test(group[0]), `${id} must remain visible in AI mode`);
    }
});

test('model text is never rendered as HTML', () => {
    const code = aiUi.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(code));
});

test('the AI UI sends only the three context fields the main process validates', () => {
    assert.match(aiUi, /downloadFolder:[\s\S]*browser:[\s\S]*proxy:/);
});

test('retry countdown and in-progress status update in real time with styled indicator', () => {
    assert.match(aiUi, /function startRetryProgress/);
    assert.match(aiUi, /function clearRetryProgress/);
    assert.match(aiUi, /Retrying in \$\{secondsLeft\} s/);
    assert.match(aiUi, /Retrying now/);
    assert.match(css, /\.ai-progress\.retrying\s*\{/);
});

test('classic download progress bar and #019D9C theme styling are present', () => {
    assert.match(css, /--run-button-bg:\s*#019D9C;/);
    assert.match(css, /\.classic-progress-container\s*\{/);
    assert.match(css, /\.classic-progress-fill\s*\{/);
    assert.match(html, /id="classicProgressBarContainer"[^>]*class="[^"]*classic-only/);
});

test('re-encode and hardsub support progress bar updates', () => {
    assert.match(rendererScript, /updateDownloadProgress\(progress,\s*['"]Hardsub Progress:['"]\)/);
    assert.match(rendererScript, /updateDownloadProgress\(text,\s*defaultTitle/);
    assert.match(rendererScript, /download\|ffmpeg/);
});

test('app info modal is wired to the brand icon and exposes info', () => {
    assert.match(html, /id="appInfoBtn"/);
    assert.match(html, /id="appInfoModal"/);
    assert.match(html, /id="appInfoGithubLink"/);
    assert.match(html, /https:\/\/github\.com\/Shawshank01\/yt-downloader-electron/);
    assert.match(html, /id="checkDependenciesBtn"/);
    assert.match(html, /id="checkUpdateBtn"/);
    assert.match(html, /Michifumi/);
    assert.match(rendererScript, /appInfoBtn\.addEventListener\('click'/);
    assert.match(rendererScript, /window\.electronAPI\?\.getAppInfo/);
    assert.match(rendererScript, /window\.electronAPI\.checkDependencies/);
    assert.match(rendererScript, /appInfoGithubLink/);
});

test('download-folder-updated event is exposed by preload, handled by main and received in renderer', () => {
    assert.match(preload, /onDownloadFolderUpdated:\s*\(callback\)\s*=>/);
    assert.match(preload, /ipcRenderer\.on\('download-folder-updated'/);
    assert.match(main, /win\.webContents\.send\('download-folder-updated'/);
    assert.match(main, /async function promptInitialDownloadFolder/);
    assert.match(rendererScript, /window\.electronAPI\?\.onDownloadFolderUpdated\?\.\(/);
});



