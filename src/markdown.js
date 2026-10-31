// A small, dependency-free Markdown renderer for the assistant's chat bubbles.
//
// Security model: the output is built with createElement / createTextNode only (never innerHTML),
// from a fixed allowlist of tags. Raw HTML in the input is shown as literal text. Links are limited
// to http(s) and are opened through a callback, never by navigating the app window.
//
// Supported: paragraphs, line breaks, headings, **bold**, *italic*, ~~strike~~, `code`, fenced
// code blocks, bullet / numbered / nested lists, blockquotes, horizontal rules, tables, links
// and bare URLs.
//
// It is a classic script (not an ES module) so it works with the app's other renderer scripts.
// It exposes `MarkdownLite` on the global object; tests load it through node:vm.
(function (global) {
    'use strict';

    const MAX_LENGTH = 20000;
    const MAX_DEPTH = 6;

    const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
    const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
    const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
    const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
    const BLANK_RE = /^\s*$/;

    function isSafeUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------ inline

    function findClosing(text, mark, from) {
        for (let j = from; j <= text.length - mark.length; j += 1) {
            if (text[j] === '\\') { j += 1; continue; }
            if (text.startsWith(mark, j) && j > from && !/\s/.test(text[j - 1])) return j;
        }
        return -1;
    }

    function findClosingSingle(text, ch, from) {
        for (let j = from; j < text.length; j += 1) {
            if (text[j] === '\\') { j += 1; continue; }
            if (text[j] !== ch) continue;
            if (j === from) return -1;
            if (/\s/.test(text[j - 1]) || text[j - 1] === ch || text[j + 1] === ch) continue;
            if (ch === '_' && /[A-Za-z0-9]/.test(text[j + 1] || '')) continue;
            return j;
        }
        return -1;
    }

    /** Returns { label, url, end } for a [label](url) starting at `start`, or null. */
    function matchLink(text, start) {
        let depth = 0;
        let j = start;
        for (; j < text.length; j += 1) {
            if (text[j] === '\\') { j += 1; continue; }
            if (text[j] === '[') depth += 1;
            else if (text[j] === ']') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        if (j >= text.length || text[j + 1] !== '(') return null;
        const label = text.slice(start + 1, j);
        let k = j + 2;
        let parens = 1;
        for (; k < text.length; k += 1) {
            if (text[k] === '(') parens += 1;
            else if (text[k] === ')') {
                parens -= 1;
                if (parens === 0) break;
            }
        }
        if (k >= text.length) return null;
        const url = text.slice(j + 2, k).trim().split(/\s+/)[0] || '';
        return { label, url: url.replace(/^<|>$/g, ''), end: k + 1 };
    }

    function trimUrl(raw) {
        let url = raw;
        while (/[.,;:!?'"*_]$/.test(url)) url = url.slice(0, -1);
        while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) {
            url = url.slice(0, -1);
        }
        return url;
    }

    function parseInline(text, depth = 0) {
        const nodes = [];
        let buf = '';
        const flush = () => {
            if (buf) {
                nodes.push({ type: 'text', value: buf });
                buf = '';
            }
        };

        let i = 0;
        while (i < text.length) {
            const ch = text[i];

            if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1])) {
                buf += text[i + 1];
                i += 2;
                continue;
            }

            if (ch === '\n') {
                flush();
                nodes.push({ type: 'br' });
                i += 1;
                continue;
            }

            if (ch === '`') {
                let run = 1;
                while (text[i + run] === '`') run += 1;
                const fence = '`'.repeat(run);
                const end = text.indexOf(fence, i + run);
                if (end === -1) {
                    buf += fence;
                    i += run;
                    continue;
                }
                let value = text.slice(i + run, end).replace(/\n/g, ' ');
                if (/^ .*\S.* $/.test(value)) value = value.slice(1, -1);
                flush();
                nodes.push({ type: 'code', value });
                i = end + run;
                continue;
            }

            if (depth < MAX_DEPTH) {
                if (text.startsWith('**', i) || text.startsWith('__', i)) {
                    const mark = text.slice(i, i + 2);
                    const end = findClosing(text, mark, i + 2);
                    if (end !== -1 && !/\s/.test(text[i + 2] || ' ')) {
                        flush();
                        nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, end), depth + 1) });
                        i = end + 2;
                        continue;
                    }
                }

                if (text.startsWith('~~', i)) {
                    const end = findClosing(text, '~~', i + 2);
                    if (end !== -1 && !/\s/.test(text[i + 2] || ' ')) {
                        flush();
                        nodes.push({ type: 'del', children: parseInline(text.slice(i + 2, end), depth + 1) });
                        i = end + 2;
                        continue;
                    }
                }

                if ((ch === '*' || ch === '_') && text[i + 1] && !/\s/.test(text[i + 1]) && text[i + 1] !== ch) {
                    const snakeCase = ch === '_' && i > 0 && /[A-Za-z0-9]/.test(text[i - 1]);
                    if (!snakeCase) {
                        const end = findClosingSingle(text, ch, i + 1);
                        if (end !== -1) {
                            flush();
                            nodes.push({ type: 'em', children: parseInline(text.slice(i + 1, end), depth + 1) });
                            i = end + 1;
                            continue;
                        }
                    }
                }

                if (ch === '[') {
                    const link = matchLink(text, i);
                    if (link) {
                        flush();
                        const children = parseInline(link.label, depth + 1);
                        if (isSafeUrl(link.url)) nodes.push({ type: 'link', url: link.url, children });
                        else nodes.push(...children);
                        i = link.end;
                        continue;
                    }
                }
            }

            if (ch === 'h' && (text.startsWith('http://', i) || text.startsWith('https://', i)) &&
                (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]))) {
                const match = /^https?:\/\/[^\s<>]+/.exec(text.slice(i));
                const url = match ? trimUrl(match[0]) : '';
                if (url.length > 8 && isSafeUrl(url)) {
                    flush();
                    nodes.push({ type: 'link', url, children: [{ type: 'text', value: url }] });
                    i += url.length;
                    continue;
                }
            }

            buf += ch;
            i += 1;
        }
        flush();
        return nodes;
    }

    // ------------------------------------------------------------------ blocks

    function indentWidth(whitespace) {
        return whitespace.replace(/\t/g, '    ').length;
    }

    function splitRow(line) {
        let row = line.trim();
        if (row.startsWith('|')) row = row.slice(1);
        if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
        const cells = [];
        let cell = '';
        for (let i = 0; i < row.length; i += 1) {
            if (row[i] === '\\' && row[i + 1] === '|') {
                cell += '|';
                i += 1;
            } else if (row[i] === '|') {
                cells.push(cell.trim());
                cell = '';
            } else {
                cell += row[i];
            }
        }
        cells.push(cell.trim());
        return cells;
    }

    function isTableStart(lines, i) {
        return i + 1 < lines.length && lines[i].includes('|') && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-');
    }

    function isBlockStart(lines, i) {
        const line = lines[i];
        return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) ||
            QUOTE_RE.test(line) || LIST_RE.test(line) || isTableStart(lines, i);
    }

    function buildList(items) {
        const root = { type: 'list', ordered: items[0].ordered, start: items[0].start, items: [] };
        const stack = [{ indent: items[0].indent, list: root }];
        for (const item of items) {
            let top = stack[stack.length - 1];
            while (stack.length > 1 && item.indent < top.indent) {
                stack.pop();
                top = stack[stack.length - 1];
            }
            if (item.indent >= top.indent + 2 && top.list.items.length > 0) {
                const parent = top.list.items[top.list.items.length - 1];
                const sub = { type: 'list', ordered: item.ordered, start: item.start, items: [] };
                parent.sublists.push(sub);
                stack.push({ indent: item.indent, list: sub });
                top = stack[stack.length - 1];
            }
            top.list.items.push({ children: parseInline(item.text), sublists: [] });
        }
        return root;
    }

    function parseBlocks(lines, depth) {
        const blocks = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (BLANK_RE.test(line)) { i += 1; continue; }

            const fence = FENCE_RE.exec(line);
            if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
                const marker = fence[1];
                const lang = fence[2].trim().split(/\s+/)[0] || '';
                const closeRe = new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
                const body = [];
                i += 1;
                while (i < lines.length && !closeRe.test(lines[i])) {
                    body.push(lines[i]);
                    i += 1;
                }
                i += 1;
                blocks.push({ type: 'code', lang, text: body.join('\n') });
                continue;
            }

            const heading = HEADING_RE.exec(line);
            if (heading) {
                blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) });
                i += 1;
                continue;
            }

            if (HR_RE.test(line)) {
                blocks.push({ type: 'hr' });
                i += 1;
                continue;
            }

            if (QUOTE_RE.test(line)) {
                const inner = [];
                while (i < lines.length && QUOTE_RE.test(lines[i])) {
                    inner.push(QUOTE_RE.exec(lines[i])[1]);
                    i += 1;
                }
                blocks.push({
                    type: 'quote',
                    children: depth < MAX_DEPTH ? parseBlocks(inner, depth + 1) : [{ type: 'paragraph', children: parseInline(inner.join('\n'), MAX_DEPTH) }]
                });
                continue;
            }

            if (isTableStart(lines, i)) {
                const header = splitRow(line);
                i += 2;
                const rows = [];
                while (i < lines.length && !BLANK_RE.test(lines[i]) && lines[i].includes('|')) {
                    rows.push(splitRow(lines[i]));
                    i += 1;
                }
                blocks.push({
                    type: 'table',
                    header: header.map((c) => parseInline(c)),
                    rows: rows.map((r) => header.map((_, k) => parseInline(r[k] || '')))
                });
                continue;
            }

            if (LIST_RE.test(line)) {
                const items = [];
                while (i < lines.length) {
                    const current = lines[i];
                    const m = LIST_RE.exec(current);
                    if (m && !HR_RE.test(current)) {
                        const ordered = /\d/.test(m[2]);
                        items.push({
                            indent: indentWidth(m[1]),
                            ordered,
                            start: ordered ? parseInt(m[2], 10) : undefined,
                            text: m[3]
                        });
                        i += 1;
                    } else if (BLANK_RE.test(current)) {
                        let j = i + 1;
                        while (j < lines.length && BLANK_RE.test(lines[j])) j += 1;
                        if (j < lines.length && LIST_RE.test(lines[j]) && !HR_RE.test(lines[j])) i = j;
                        else break;
                    } else if (/^\s+\S/.test(current) && items.length > 0 && !isBlockStart(lines, i)) {
                        items[items.length - 1].text += `\n${current.trim()}`;
                        i += 1;
                    } else {
                        break;
                    }
                }
                blocks.push(buildList(items));
                continue;
            }

            const para = [line];
            i += 1;
            while (i < lines.length && !BLANK_RE.test(lines[i]) && !isBlockStart(lines, i)) {
                para.push(lines[i]);
                i += 1;
            }
            blocks.push({ type: 'paragraph', children: parseInline(para.map((l) => l.trim()).join('\n')) });
        }
        return blocks;
    }

    function parse(text) {
        const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
        if (source.length > MAX_LENGTH) return [{ type: 'code', lang: '', text: source }];
        return parseBlocks(source.split('\n'), 0);
    }

    // ------------------------------------------------------------------ DOM output

    function renderInline(nodes, doc, options) {
        const out = [];
        for (const node of nodes) {
            switch (node.type) {
                case 'text':
                    out.push(doc.createTextNode(node.value));
                    break;
                case 'br':
                    out.push(doc.createElement('br'));
                    break;
                case 'code': {
                    const el = doc.createElement('code');
                    el.textContent = node.value;
                    out.push(el);
                    break;
                }
                case 'strong':
                case 'em':
                case 'del': {
                    const el = doc.createElement(node.type);
                    renderInline(node.children, doc, options).forEach((c) => el.appendChild(c));
                    out.push(el);
                    break;
                }
                case 'link': {
                    const el = doc.createElement('a');
                    // "#" plus a click handler: the window must never navigate to an assistant-supplied URL.
                    el.setAttribute('href', '#');
                    el.setAttribute('title', node.url);
                    el.setAttribute('rel', 'noopener noreferrer');
                    el.addEventListener('click', (event) => {
                        event.preventDefault();
                        if (options && typeof options.onLink === 'function') options.onLink(node.url);
                    });
                    renderInline(node.children, doc, options).forEach((c) => el.appendChild(c));
                    out.push(el);
                    break;
                }
                default:
                    break;
            }
        }
        return out;
    }

    function renderList(list, doc, options) {
        const el = doc.createElement(list.ordered ? 'ol' : 'ul');
        if (list.ordered && list.start && list.start !== 1) el.setAttribute('start', String(list.start));
        for (const item of list.items) {
            const li = doc.createElement('li');
            renderInline(item.children, doc, options).forEach((c) => li.appendChild(c));
            for (const sub of item.sublists) li.appendChild(renderList(sub, doc, options));
            el.appendChild(li);
        }
        return el;
    }

    function renderBlock(block, doc, options) {
        switch (block.type) {
            case 'paragraph': {
                const el = doc.createElement('p');
                renderInline(block.children, doc, options).forEach((c) => el.appendChild(c));
                return el;
            }
            case 'heading': {
                const el = doc.createElement(`h${Math.min(block.level + 2, 6)}`);
                renderInline(block.children, doc, options).forEach((c) => el.appendChild(c));
                return el;
            }
            case 'hr':
                return doc.createElement('hr');
            case 'code': {
                const pre = doc.createElement('pre');
                const code = doc.createElement('code');
                if (/^[\w+#.-]{1,20}$/.test(block.lang)) code.setAttribute('class', `language-${block.lang}`);
                code.textContent = block.text;
                pre.appendChild(code);
                return pre;
            }
            case 'quote': {
                const el = doc.createElement('blockquote');
                block.children.forEach((child) => el.appendChild(renderBlock(child, doc, options)));
                return el;
            }
            case 'list':
                return renderList(block, doc, options);
            case 'table': {
                const wrap = doc.createElement('div');
                wrap.setAttribute('class', 'md-table-wrap');
                const table = doc.createElement('table');
                const thead = doc.createElement('thead');
                const headRow = doc.createElement('tr');
                for (const cell of block.header) {
                    const th = doc.createElement('th');
                    renderInline(cell, doc, options).forEach((c) => th.appendChild(c));
                    headRow.appendChild(th);
                }
                thead.appendChild(headRow);
                table.appendChild(thead);
                const tbody = doc.createElement('tbody');
                for (const row of block.rows) {
                    const tr = doc.createElement('tr');
                    for (const cell of row) {
                        const td = doc.createElement('td');
                        renderInline(cell, doc, options).forEach((c) => td.appendChild(c));
                        tr.appendChild(td);
                    }
                    tbody.appendChild(tr);
                }
                table.appendChild(tbody);
                wrap.appendChild(table);
                return wrap;
            }
            default:
                return doc.createTextNode('');
        }
    }

    /**
     * Render Markdown into a DocumentFragment.
     * @param {string} text
     * @param {Document} doc
     * @param {{ onLink?: (url: string) => void }} [options]
     */
    function render(text, doc, options) {
        const fragment = doc.createDocumentFragment();
        for (const block of parse(text)) fragment.appendChild(renderBlock(block, doc, options));
        return fragment;
    }

    global.MarkdownLite = { parse, parseInline, render, isSafeUrl };
})(typeof window !== 'undefined' ? window : globalThis);
