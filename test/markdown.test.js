import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// markdown.js is a classic browser script. Load it into an isolated context, as a browser would.
const sandbox = { URL }; // browsers provide URL globally; a bare vm context does not
vm.runInNewContext(readFileSync(new URL('../src/markdown.js', import.meta.url), 'utf-8'), sandbox);
const { parse, render, isSafeUrl } = sandbox.MarkdownLite;

// A tiny fake DOM, just enough to verify what the renderer builds.
function makeDoc() {
    const element = (tag) => ({
        tag,
        children: [],
        attrs: {},
        listeners: {},
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(name, value) { this.attrs[name] = String(value); },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        set textContent(value) { this.children = [{ text: String(value) }]; }
    });
    return {
        createElement: element,
        createTextNode: (text) => ({ text }),
        createDocumentFragment: () => element('#fragment')
    };
}

function html(node) {
    if (node.text !== undefined && node.tag === undefined) return node.text;
    const attrs = [];
    if (node.tag === 'ol' && node.attrs.start) attrs.push(` start="${node.attrs.start}"`);
    if (node.tag === 'code' && node.attrs.class) attrs.push(` class="${node.attrs.class}"`);
    const inner = node.children.map(html).join('');
    if (node.tag === '#fragment') return inner;
    return `<${node.tag}${attrs.join('')}>${inner}</${node.tag}>`;
}

function allTags(node, set = new Set()) {
    if (node.tag) set.add(node.tag);
    (node.children || []).forEach((c) => allTags(c, set));
    return set;
}

function md(text, options) {
    return render(text, makeDoc(), options);
}

const toHtml = (text) => html(md(text));

test('renders the assistant reply that was shown as raw Markdown', () => {
    const reply = [
        'I can help you download media. Here is what I can do:',
        '',
        '* **Download Videos**: In best quality, or specific resolutions (e.g., 1080p).',
        '* **Extract Audio**: Convert videos to audio files (`mp3`, `m4a`, `flac`).',
        '',
        'All files are saved to `/Users/me/Downloads`. Just provide a link!'
    ].join('\n');
    assert.equal(
        toHtml(reply),
        '<p>I can help you download media. Here is what I can do:</p>' +
        '<ul><li><strong>Download Videos</strong>: In best quality, or specific resolutions (e.g., 1080p).</li>' +
        '<li><strong>Extract Audio</strong>: Convert videos to audio files (<code>mp3</code>, <code>m4a</code>, <code>flac</code>).</li></ul>' +
        '<p>All files are saved to <code>/Users/me/Downloads</code>. Just provide a link!</p>'
    );
});

test('inline formatting', () => {
    assert.equal(toHtml('**bold** and *it* and _it2_ and ~~gone~~'), '<p><strong>bold</strong> and <em>it</em> and <em>it2</em> and <del>gone</del></p>');
    assert.equal(toHtml('__bold__'), '<p><strong>bold</strong></p>');
    assert.equal(toHtml('***both***').includes('<strong>'), true);
});

test('things that look like markup but are not stay as text', () => {
    assert.equal(toHtml('use snake_case_name here'), '<p>use snake_case_name here</p>');
    assert.equal(toHtml('2 * 3 * 4 = 24'), '<p>2 * 3 * 4 = 24</p>');
    assert.equal(toHtml('a ** b'), '<p>a ** b</p>');
    assert.equal(toHtml('unclosed **bold'), '<p>unclosed **bold</p>');
    assert.equal(toHtml('price is 5*'), '<p>price is 5*</p>');
    assert.equal(toHtml('\\*not italic\\*'), '<p>*not italic*</p>');
});

test('inline code is literal', () => {
    assert.equal(toHtml('`a*b*c` and `` x`y ``'), '<p><code>a*b*c</code> and <code>x`y</code></p>');
    assert.equal(toHtml('`<b>x</b>`'), '<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>'.replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
});

test('line breaks inside a paragraph', () => {
    assert.equal(toHtml('line one\nline two'), '<p>line one<br></br>line two</p>');
});

test('headings map to smaller heading tags', () => {
    assert.equal(toHtml('# Title'), '<h3>Title</h3>');
    assert.equal(toHtml('## Sub'), '<h4>Sub</h4>');
    assert.equal(toHtml('###### Tiny'), '<h6>Tiny</h6>');
    assert.equal(toHtml('#nospace'), '<p>#nospace</p>');
});

test('fenced code blocks keep their content verbatim', () => {
    assert.equal(toHtml('```bash\nyt-dlp -F "$URL"\n# comment\n```'), '<pre><code class="language-bash">yt-dlp -F "$URL"\n# comment</code></pre>');
    assert.equal(toHtml('```\n**not bold**\n```'), '<pre><code>**not bold**</code></pre>');
    assert.equal(toHtml('```\nnever closed\nstill code'), '<pre><code>never closed\nstill code</code></pre>');
    // a hostile "language" is not allowed to become a class name
    assert.equal(toHtml('```" onload="x\ncode\n```').includes('onload'), false);
});

test('lists: bullets, numbers, start numbers, nesting, continuation lines', () => {
    assert.equal(toHtml('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(toHtml('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
    assert.equal(toHtml('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>');
    assert.equal(toHtml('- a\n  - b\n  - c\n- d'), '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
    assert.equal(toHtml('* a\n\n* b'), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(toHtml('- first\n  continued'), '<ul><li>first<br></br>continued</li></ul>');
    assert.equal(toHtml('text\n- item'), '<p>text</p><ul><li>item</li></ul>');
});

test('blockquote, horizontal rule, table', () => {
    assert.equal(toHtml('> quoted **text**'), '<blockquote><p>quoted <strong>text</strong></p></blockquote>');
    assert.equal(toHtml('above\n\n---\n\nbelow'), '<p>above</p><hr></hr><p>below</p>');
    assert.equal(
        toHtml('| Name | Size |\n|---|---|\n| a.mp4 | 3 MB |\n| b.mp3 | 1 MB |'),
        '<div><table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody>' +
        '<tr><td>a.mp4</td><td>3 MB</td></tr><tr><td>b.mp3</td><td>1 MB</td></tr></tbody></table></div>'
    );
    assert.equal(toHtml('a | b'), '<p>a | b</p>');
});

test('links: only http(s); clicking never navigates the window', () => {
    const opened = [];
    const fragment = md('See [the docs](https://example.com/a?b=1) or https://example.org/x.', { onLink: (u) => opened.push(u) });
    const links = [];
    (function walk(n) { if (n.tag === 'a') links.push(n); (n.children || []).forEach(walk); })(fragment);

    assert.equal(links.length, 2);
    assert.equal(links[0].attrs.href, '#', 'href must not be the real URL');
    assert.equal(links[0].attrs.title, 'https://example.com/a?b=1');
    assert.equal(links[1].attrs.title, 'https://example.org/x', 'trailing period is not part of the URL');

    let prevented = false;
    links[0].listeners.click({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(opened, ['https://example.com/a?b=1']);

    for (const bad of [
        '[x](javascript:alert(1))',
        '[x](file:///etc/passwd)',
        '[x](data:text/html,<script>alert(1)</script>)',
        '[x](vbscript:x)',
        '[x](//evil.com)',
        '[x]( )'
    ]) {
        const out = md(bad);
        assert.equal(allTags(out).has('a'), false, `no link for ${bad}`);
    }
    assert.equal(toHtml('[click](javascript:alert(1))'), '<p>click</p>');
    assert.equal(isSafeUrl('https://a.test'), true);
    assert.equal(isSafeUrl('javascript:alert(1)'), false);
    assert.equal(isSafeUrl('not a url'), false);
});

test('raw HTML in the input is shown as text, never turned into elements', () => {
    const hostile = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<iframe src="https://evil.test"></iframe>',
        '**<b onclick="x()">hi</b>**',
        '[<img src=x onerror=1>](https://ok.test)',
        '| <svg onload=1> | b |\n|---|---|\n| <a href="x">y</a> | z |',
        '> <style>*{display:none}</style>',
        '- <button>x</button>'
    ].join('\n\n');
    const tags = allTags(md(hostile));
    const allowed = new Set(['#fragment', 'p', 'strong', 'a', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'ul', 'li']);
    for (const tag of tags) assert.ok(allowed.has(tag), `unexpected element <${tag}>`);
    assert.ok(html(md('<script>alert(1)</script>')).includes('<script>alert(1)</script>'), 'shown literally');
});

test('only an allowlist of element and attribute names is ever produced', () => {
    const sample = '# h\n\ntext **b** *i* ~~d~~ `c` [l](https://a.test)\n\n- x\n  1. y\n\n> q\n\n---\n\n```js\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const fragment = md(sample);
    const allowedTags = new Set(['#fragment', 'p', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'a', 'br', 'ul', 'ol', 'li', 'blockquote', 'hr', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
    const allowedAttrs = new Set(['href', 'title', 'rel', 'start', 'class']);
    (function walk(n) {
        if (n.tag) assert.ok(allowedTags.has(n.tag), n.tag);
        Object.keys(n.attrs || {}).forEach((a) => assert.ok(allowedAttrs.has(a), a));
        (n.children || []).forEach(walk);
    })(fragment);
});

test('empty and non-string input', () => {
    assert.equal(toHtml(''), '');
    assert.equal(toHtml(undefined), '');
    assert.equal(toHtml(null), '');
    assert.equal(toHtml(42), '<p>42</p>');
    assert.equal(toHtml('\n\n   \n'), '');
});

test('Windows line endings and tabs', () => {
    assert.equal(toHtml('- a\r\n- b\r\n'), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(toHtml('- a\n\t- b'), '<ul><li>a<ul><li>b</li></ul></li></ul>');
});

test('very long input is shown as one code block instead of being parsed', () => {
    const huge = 'word '.repeat(5000);
    const blocks = parse(huge);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'code');
});

test('pathological input stays fast', () => {
    const cases = [
        '*'.repeat(10000),
        '['.repeat(10000),
        '**a '.repeat(2500),
        '`'.repeat(10000),
        '_a'.repeat(5000),
        '- '.repeat(5000),
        '> '.repeat(5000),
        '[a](' .repeat(2500),
        '| a '.repeat(2500) + '\n|---|\n' + '| b '.repeat(2500),
        '~~x '.repeat(2500),
        'https://'.repeat(1200)
    ];
    for (const input of cases) {
        const started = Date.now();
        md(input);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 1500, `took ${elapsed} ms for input starting ${JSON.stringify(input.slice(0, 12))}`);
    }
});

test('deeply nested emphasis and quotes do not overflow the stack', () => {
    assert.doesNotThrow(() => md('*'.repeat(200) + 'x' + '*'.repeat(200)));
    assert.doesNotThrow(() => md('> '.repeat(300) + 'deep'));
    assert.doesNotThrow(() => md('['.repeat(300) + 'x' + '](https://a.test)'.repeat(300)));
    assert.doesNotThrow(() => md('- a\n' + Array.from({ length: 200 }, (_, i) => ' '.repeat(2 * (i + 1)) + '- n').join('\n')));
});
