import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider, DEFAULT_GEMINI_MODEL, toGeminiDeclaration } from '../src/llm/providers/gemini.js';
import { getToolDeclarations } from '../src/llm/tool-registry.js';
import { OllamaProvider } from '../src/llm/providers/ollama.js';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.js';
import { createProvider } from '../src/llm/providers/index.js';
import { ProviderError } from '../src/llm/errors.js';
import { requestJson, DEFAULT_RETRIES } from '../src/llm/providers/http.js';

const TOOLS = [
    {
        name: 'list_formats',
        description: 'List formats',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
];

/** Build a fake fetch that records requests and returns queued JSON responses. */
function fakeFetch(responses) {
    const calls = [];
    const queue = [...responses];
    const impl = async (url, init) => {
        calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        const { status = 200, json } = next;
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => (typeof json === 'string' ? json : JSON.stringify(json))
        };
    };
    impl.calls = calls;
    return impl;
}

test('default Gemini model is gemini-3.8-flash', () => {
    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
    assert.equal(new GeminiProvider({ apiKey: 'k' }).model, 'gemini-3.8-flash');
});

test('Gemini: request shape, key in header (not URL), tool declarations, function call parsing', async () => {
    const fetchImpl = fakeFetch([
        {
            json: {
                id: 'int_call_1',
                status: 'requires_action',
                model: 'gemini-3.8-flash',
                steps: [
                    {
                        type: 'function_call',
                        id: 'call_1',
                        name: 'list_formats',
                        arguments: { url: 'https://x.test/v' }
                    }
                ]
            }
        }
    ]);
    const provider = new GeminiProvider({ apiKey: 'SECRET', fetchImpl });
    const reply = await provider.chat({
        system: 'be helpful',
        messages: [{ role: 'user', text: 'formats please' }],
        tools: TOOLS
    });

    const call = fetchImpl.calls[0];
    assert.equal(
        call.url,
        'https://generativelanguage.googleapis.com/v1beta/interactions'
    );
    assert.ok(!call.url.includes('SECRET'), 'API key must not be in the URL');
    assert.equal(call.init.headers['x-goog-api-key'], 'SECRET');
    assert.equal(call.body.model, 'gemini-3.8-flash');
    assert.equal(call.body.system_instruction, 'be helpful');
    assert.equal(call.body.input, 'formats please');
    assert.equal(call.body.tools[0].type, 'function');
    assert.equal(call.body.tools[0].name, 'list_formats');

    assert.equal(reply.toolCalls.length, 1);
    assert.equal(reply.toolCalls[0].name, 'list_formats');
    assert.deepEqual(reply.toolCalls[0].args, { url: 'https://x.test/v' });
    assert.equal(reply.text, '');
});

test('Gemini: thinking level defaults to low and is sent as generation_config', async () => {
    const reply = { json: { id: 'int_1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }], usage: { total_input_tokens: 120, total_thought_tokens: 7, total_output_tokens: 3 } } };
    const messages = [{ role: 'user', text: 'x' }];

    const fetchDefault = fakeFetch([reply]);
    const result = await new GeminiProvider({ apiKey: 'k', fetchImpl: fetchDefault }).chat({ system: '', messages });
    assert.deepEqual(fetchDefault.calls[0].body.generation_config, { thinking_level: 'low' });
    assert.equal(result.stats.thinkingLevel, 'low');
    assert.equal(result.stats.thoughtTokens, 7);
    assert.equal(result.stats.promptTokens, 120);
    assert.ok(result.stats.ms >= 0);

    const fetchHigh = fakeFetch([reply]);
    await new GeminiProvider({ apiKey: 'k', thinkingLevel: 'high', fetchImpl: fetchHigh }).chat({ system: '', messages });
    assert.equal(fetchHigh.calls[0].body.generation_config.thinking_level, 'high');

    // 'minimal' is rejected by Gemini 3.8 Flash, so unknown values fall back to the default.
    const fetchBad = fakeFetch([reply]);
    await new GeminiProvider({ apiKey: 'k', thinkingLevel: 'minimal', fetchImpl: fetchBad }).chat({ system: '', messages });
    assert.equal(fetchBad.calls[0].body.generation_config.thinking_level, 'low');

    // An empty string means "use the model's own default": nothing is sent.
    const fetchNone = fakeFetch([reply]);
    await new GeminiProvider({ apiKey: 'k', thinkingLevel: '', fetchImpl: fetchNone }).chat({ system: '', messages });
    assert.equal('generation_config' in fetchNone.calls[0].body, false);
});

test('Gemini: a model that rejects thinkingLevel is retried once without it', async () => {
    const fetchImpl = fakeFetch([
        { status: 400, json: { error: { message: 'Thinking level is not supported for this model.' } } },
        { json: { id: 'int_retry', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }] }] } }
    ]);
    const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl });
    const reply = await provider.chat({ system: '', messages: [{ role: 'user', text: 'x' }] });
    assert.equal(reply.text, 'ok');
    assert.equal(fetchImpl.calls.length, 2);
    assert.ok('generation_config' in fetchImpl.calls[0].body);
    assert.ok(!('generation_config' in fetchImpl.calls[1].body));

    // Unrelated 400 errors are not retried.
    const other = fakeFetch([{ status: 400, json: { error: { message: 'Invalid JSON payload' } } }]);
    const err = await new GeminiProvider({ apiKey: 'k', fetchImpl: other })
        .chat({ system: '', messages: [{ role: 'user', text: 'x' }] })
        .catch((e) => e);
    assert.equal(err.kind, 'bad_request');
    assert.equal(other.calls.length, 1);
});

test('Gemini: tools without parameters are declared without a parameters object', async () => {
    assert.deepEqual(
        toGeminiDeclaration({ name: 'x', description: 'd', parameters: { type: 'object', properties: {} } }),
        { type: 'function', name: 'x', description: 'd' }
    );
    const withParams = { name: 'y', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } };
    assert.deepEqual(toGeminiDeclaration(withParams), { type: 'function', ...withParams });

    const fetchImpl = fakeFetch([{ json: { id: 'int_tools', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hi' }] }] } }]);
    await new GeminiProvider({ apiKey: 'k', fetchImpl }).chat({
        system: '',
        messages: [{ role: 'user', text: 'x' }],
        tools: getToolDeclarations()
    });
    const declared = fetchImpl.calls[0].body.tools;
    assert.equal(declared.length, getToolDeclarations().length);
    for (const d of declared) {
        assert.equal(d.type, 'function');
        if ('parameters' in d) {
            assert.ok(Object.keys(d.parameters.properties).length > 0, `${d.name} has empty properties`);
        }
    }
    assert.ok(!('parameters' in declared.find((d) => d.name === 'list_downloads')));
});

test('Gemini: multi-turn chains with previous_interaction_id and tool results', async () => {
    const fetchImpl = fakeFetch([{ json: { id: 'int_turn2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'done' }] }] } }]);
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });

    await provider.chat({
        system: '',
        messages: [
            { role: 'user', text: 'go' },
            {
                role: 'assistant',
                text: '',
                toolCalls: [
                    { id: 'id-a', providerCallId: 'id-a', name: 'a', args: {} },
                    { id: 'id-b', providerCallId: 'id-b', name: 'b', args: {} }
                ],
                raw: { provider: 'gemini', interactionId: 'int_turn1' }
            },
            { role: 'tool', toolCallId: 'id-a', providerCallId: 'id-a', name: 'a', result: { ok: true } },
            { role: 'tool', toolCallId: 'id-b', providerCallId: 'id-b', name: 'b', result: { ok: false, error: 'x' } }
        ],
        tools: TOOLS
    });

    const call = fetchImpl.calls[0];
    assert.equal(call.body.previous_interaction_id, 'int_turn1');
    assert.equal(call.body.input.length, 2);
    assert.equal(call.body.input[0].type, 'function_result');
    assert.equal(call.body.input[0].name, 'a');
    assert.equal(call.body.input[0].call_id, 'id-a');
    assert.deepEqual(call.body.input[0].result, [{ type: 'text', text: '{"ok":true}' }]);
    assert.equal(call.body.input[1].type, 'function_result');
    assert.equal(call.body.input[1].name, 'b');
    assert.equal(call.body.input[1].call_id, 'id-b');
    assert.deepEqual(call.body.input[1].result, [{ type: 'text', text: '{"ok":false,"error":"x"}' }]);
});

test('Gemini: error mapping (404 model, 429 quota, bad key, no key)', async () => {
    const run = async (response) => {
        const provider = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([response]) });
        return provider.chat({ system: '', messages: [{ role: 'user', text: 'x' }] }).catch((e) => e);
    };

    const notFound = await run({ status: 404, json: { error: { message: 'models/x is not found' } } });
    assert.ok(notFound instanceof ProviderError);
    assert.equal(notFound.kind, 'not_found');
    assert.match(notFound.message, /gemini-3\.8-flash/);
    assert.match(notFound.message, /model ID/i);

    const quota = await run({ status: 429, json: { error: { message: 'quota' } } });
    assert.equal(quota.kind, 'rate_limit');
    assert.match(quota.message, /Classic mode/);

    const badKey = await run({ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } });
    assert.equal(badKey.kind, 'auth');

    const noKey = await new GeminiProvider({ fetchImpl: fakeFetch([]) })
        .chat({ system: '', messages: [] })
        .catch((e) => e);
    assert.equal(noKey.kind, 'auth');
});

test('Gemini: blocked / malformed responses become errors', async () => {
    const blocked = new GeminiProvider({
        apiKey: 'k',
        fetchImpl: fakeFetch([{ json: { promptFeedback: { blockReason: 'SAFETY' } } }])
    });
    const err = await blocked.chat({ system: '', messages: [{ role: 'user', text: 'x' }] }).catch((e) => e);
    assert.equal(err.kind, 'bad_response');
    assert.match(err.message, /SAFETY/);
});

test('Gemini: network failure and abort', async () => {
    const down = new GeminiProvider({ apiKey: 'k', retries: 0, fetchImpl: fakeFetch([new TypeError('fetch failed')]) });
    const err = await down.chat({ system: '', messages: [] }).catch((e) => e);
    assert.equal(err.kind, 'network');

    const controller = new AbortController();
    controller.abort();
    const aborting = new GeminiProvider({ apiKey: 'k', fetchImpl: fakeFetch([new Error('aborted')]) });
    const err2 = await aborting.chat({ system: '', messages: [], signal: controller.signal }).catch((e) => e);
    assert.equal(err2.kind, 'aborted');
});

test('Gemini streaming keeps accumulated text when the final chunk has no text', async () => {
    const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"hello "}]},"finishReason":"STOP"}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1}}\n\n'
    ];
    const fetchImpl = async () => ({
        ok: true,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            }
        })
    });
    const deltas = [];
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });
    const reply = await provider.chat({
        system: '',
        messages: [{ role: 'user', text: 'hi' }],
        onTextDelta: (delta) => deltas.push(delta)
    });
    assert.deepEqual(deltas, ['hello ']);
    assert.equal(reply.text, 'hello');
});

test('Gemini streaming keeps tool calls when the final chunk has no content', async () => {
    const chunks = [
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_formats","args":{"url":"https://x.test/v"}}}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n'
    ];
    const fetchImpl = async () => ({
        ok: true,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            }
        })
    });
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });
    const reply = await provider.chat({
        system: '',
        messages: [{ role: 'user', text: 'list formats' }],
        onTextDelta: () => { }
    });
    assert.equal(reply.text, '');
    assert.equal(reply.toolCalls.length, 1);
    assert.equal(reply.toolCalls[0].name, 'list_formats');
    assert.deepEqual(reply.toolCalls[0].args, { url: 'https://x.test/v' });
});

test('Gemini streaming captures tool arguments streamed via partial_arguments', async () => {
    const chunks = [
        'data: {"event_type":"step.start","index":0,"step":{"type":"function_call","name":"list_formats","id":"call_1"}}\n\n',
        'data: {"event_type":"step.delta","index":0,"delta":{"type":"arguments","partial_arguments":"{\\"url\\":\\"https://x.test/v\\"}"}}\n\n',
        'data: {"event_type":"step.stop","index":0}\n\n'
    ];
    const fetchImpl = async () => ({
        ok: true,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            }
        })
    });
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });
    const reply = await provider.chat({
        system: '',
        messages: [{ role: 'user', text: 'formats please' }],
        onTextDelta: () => { }
    });
    assert.equal(reply.toolCalls.length, 1);
    assert.equal(reply.toolCalls[0].name, 'list_formats');
    assert.deepEqual(reply.toolCalls[0].args, { url: 'https://x.test/v' });
});

test('Gemini: testConnection uses a free GET on the model', async () => {
    const fetchImpl = fakeFetch([{ json: { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' } }]);
    const provider = new GeminiProvider({ apiKey: 'k', fetchImpl });
    const res = await provider.testConnection();
    assert.equal(res.ok, true);
    assert.equal(fetchImpl.calls[0].init.method, 'GET');
    assert.match(res.message, /Gemini 3\.8 Flash/);
});

test('Ollama: request shape and tool call parsing (object and string arguments)', async () => {
    const fetchImpl = fakeFetch([
        {
            json: {
                message: {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        { function: { name: 'list_formats', arguments: { url: 'https://x.test/1' } } },
                        { function: { name: 'list_formats', arguments: '{"url":"https://x.test/2"}' } }
                    ]
                }
            }
        }
    ]);
    const provider = new OllamaProvider({ model: 'qwen3:4b', fetchImpl });
    const reply = await provider.chat({
        system: 'sys',
        messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'list_formats', args: { url: 'u' } }] },
            { role: 'tool', toolCallId: '1', name: 'list_formats', result: { ok: true } }
        ],
        tools: TOOLS
    });

    const body = fetchImpl.calls[0].body;
    assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(body.stream, false);
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.messages[2].tool_calls, [{ function: { name: 'list_formats', arguments: { url: 'u' } } }]);
    assert.deepEqual(body.messages[3], { role: 'tool', tool_name: 'list_formats', content: '{"ok":true}' });
    assert.equal(body.tools[0].type, 'function');

    assert.equal(reply.toolCalls.length, 2);
    assert.deepEqual(reply.toolCalls[1].args, { url: 'https://x.test/2' });
    assert.notEqual(reply.toolCalls[0].id, reply.toolCalls[1].id);
});

test('Ollama: friendly errors', async () => {
    const down = new OllamaProvider({ retries: 0, fetchImpl: fakeFetch([new TypeError('fetch failed')]) });
    const e1 = await down.chat({ system: '', messages: [] }).catch((e) => e);
    assert.equal(e1.kind, 'network');
    assert.match(e1.message, /Is Ollama running/);

    const noTools = new OllamaProvider({
        model: 'tiny',
        fetchImpl: fakeFetch([{ status: 400, json: { error: 'registry.ollama.ai/library/tiny does not support tools' } }])
    });
    const e2 = await noTools.chat({ system: '', messages: [], tools: TOOLS }).catch((e) => e);
    assert.match(e2.message, /does not support tool calling/);
});

test('Ollama: testConnection detects a missing model', async () => {
    const provider = new OllamaProvider({
        model: 'qwen3:4b',
        fetchImpl: fakeFetch([{ json: { models: [{ name: 'llama3.1:8b' }] } }])
    });
    const res = await provider.testConnection();
    assert.equal(res.ok, false);
    assert.match(res.message, /ollama pull qwen3:4b/);
});

test('OpenAI-compatible: request shape and tool call parsing', async () => {
    const fetchImpl = fakeFetch([
        {
            json: {
                choices: [
                    {
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                { id: 'call_1', type: 'function', function: { name: 'list_formats', arguments: '{"url":"https://x.test/v"}' } },
                                { id: 'call_2', type: 'function', function: { name: 'list_formats', arguments: 'not json' } }
                            ]
                        }
                    }
                ]
            }
        }
    ]);
    const provider = new OpenAICompatibleProvider({
        apiKey: 'sk-test',
        model: 'gpt-x',
        baseUrl: 'https://api.example.com/v1/',
        fetchImpl
    });
    const reply = await provider.chat({
        system: 'sys',
        messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'list_formats', args: { url: 'u' } }] },
            { role: 'tool', toolCallId: 'call_0', name: 'list_formats', result: { ok: true } }
        ],
        tools: TOOLS
    });

    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
    assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
    assert.equal(call.body.messages[2].tool_calls[0].function.arguments, '{"url":"u"}');
    assert.deepEqual(call.body.messages[3], { role: 'tool', tool_call_id: 'call_0', content: '{"ok":true}' });

    assert.equal(reply.toolCalls[0].id, 'call_1');
    assert.deepEqual(reply.toolCalls[0].args, { url: 'https://x.test/v' });
    assert.deepEqual(reply.toolCalls[1].args, {});
});

test('OpenAI-compatible: streams response text deltas via SSE', async () => {
    let capturedCall;
    const chunks = [
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hello "}}]}\n\n',
        ': ping\n\n',
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"world!"}}]}\n\n',
        'data: [DONE]\n\n'
    ];
    const fetchImpl = async (url, init) => {
        capturedCall = { url, init, body: init.body ? JSON.parse(init.body) : undefined };
        return {
            ok: true,
            status: 200,
            body: new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                    controller.close();
                }
            })
        };
    };

    const provider = new OpenAICompatibleProvider({
        apiKey: 'key-123',
        model: 'lfm-1.7b',
        baseUrl: 'http://127.0.0.1:8080/v1',
        fetchImpl
    });

    const deltas = [];
    const reply = await provider.chat({
        system: 'be brief',
        messages: [{ role: 'user', text: 'hi' }],
        onTextDelta: (d) => deltas.push(d)
    });

    assert.equal(capturedCall.url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(capturedCall.body.stream, true);
    assert.deepEqual(deltas, ['hello ', 'world!']);
    assert.equal(reply.text, 'hello world!');
    assert.deepEqual(reply.toolCalls, []);
});

test('OpenAI-compatible: streams tool calls split across SSE chunks', async () => {
    const chunks = [
        'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_formats","arguments":"{\\"url\\":"}}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"https://x.test/v\\"}"}}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"download_video","arguments":{"url":"https://x.test/2"}}}]}}]}\n\n',
        'data: {"id":"c2","choices":[{"index":0,"delta":{}}]}\n\n',
        'data: [DONE]\n\n'
    ];
    const fetchImpl = async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            }
        })
    });

    const provider = new OpenAICompatibleProvider({
        model: 'lfm-1.7b',
        baseUrl: 'http://127.0.0.1:8080/v1',
        fetchImpl
    });

    const reply = await provider.chat({
        system: '',
        messages: [{ role: 'user', text: 'get formats' }],
        tools: TOOLS,
        onTextDelta: () => { }
    });

    assert.equal(reply.toolCalls.length, 2);
    assert.equal(reply.toolCalls[0].id, 'call_1');
    assert.equal(reply.toolCalls[0].name, 'list_formats');
    assert.deepEqual(reply.toolCalls[0].args, { url: 'https://x.test/v' });
    assert.equal(reply.toolCalls[1].id, 'call_2');
    assert.equal(reply.toolCalls[1].name, 'download_video');
    assert.deepEqual(reply.toolCalls[1].args, { url: 'https://x.test/2' });
});

test('OpenAI-compatible: streaming error cases', async () => {
    // Malformed JSON in SSE
    const badJsonFetch = async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: not json\n\n'));
                controller.close();
            }
        })
    });
    const p1 = new OpenAICompatibleProvider({ model: 'm', fetchImpl: badJsonFetch });
    const err1 = await p1.chat({ system: '', messages: [], onTextDelta: () => { } }).catch((e) => e);
    assert.equal(err1.kind, 'bad_response');
    assert.match(err1.message, /invalid streaming data/);

    // Empty stream ([DONE] only)
    const emptyFetch = async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
            }
        })
    });
    const p2 = new OpenAICompatibleProvider({ model: 'm', fetchImpl: emptyFetch });
    const err2 = await p2.chat({ system: '', messages: [], onTextDelta: () => { } }).catch((e) => e);
    assert.equal(err2.kind, 'bad_response');
    assert.match(err2.message, /returned no answer/);
});

const okReply = { json: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } };
const busy503 = { status: 503, json: { error: { message: 'This model is currently experiencing high demand.' } } };
const userMessages = [{ role: 'user', text: 'x' }];

test('retry: a temporary 503 is retried automatically and then succeeds', async () => {
    const fetchImpl = fakeFetch([...Array(DEFAULT_RETRIES).fill(busy503), okReply]);
    const retries = [];
    const provider = new GeminiProvider({ apiKey: 'k', retryDelayMs: 1, fetchImpl });
    const reply = await provider.chat({ system: '', messages: userMessages, onRetry: (i) => retries.push(i) });
    assert.equal(reply.text, 'ok');
    assert.equal(fetchImpl.calls.length, DEFAULT_RETRIES + 1);
    assert.deepEqual(retries.map((r) => r.attempt), Array.from({ length: DEFAULT_RETRIES }, (_, i) => i + 1));
    assert.equal(retries[0].reason, 'HTTP 503');
    assert.equal(retries[0].retries, DEFAULT_RETRIES);
    assert.equal(retries[1].delayMs, retries[0].delayMs * 2, 'delay doubles each time');
});

test('retry: gives up after the retry limit with an actionable message', async () => {
    const fetchImpl = fakeFetch([...Array(DEFAULT_RETRIES + 1).fill(busy503), okReply]);
    const provider = new GeminiProvider({ apiKey: 'k', retryDelayMs: 1, fetchImpl });
    const err = await provider.chat({ system: '', messages: userMessages }).catch((e) => e);
    assert.equal(err.kind, 'server');
    assert.equal(err.status, 503);
    assert.equal(fetchImpl.calls.length, DEFAULT_RETRIES + 1, '1 attempt + the default number of retries');
    assert.match(err.message, /on their side/);
    assert.match(err.message, /switch provider/);
});

test('retry: only temporary errors are retried', async () => {
    for (const response of [
        { status: 429, json: { error: { message: 'quota' } } },
        { status: 401, json: { error: { message: 'bad key' } } },
        { status: 404, json: { error: { message: 'no model' } } },
        { status: 400, json: { error: { message: 'bad request' } } }
    ]) {
        const fetchImpl = fakeFetch([response, okReply]);
        const provider = new GeminiProvider({ apiKey: 'k', retryDelayMs: 1, fetchImpl });
        await provider.chat({ system: '', messages: userMessages }).catch(() => { });
        assert.equal(fetchImpl.calls.length, 1, `HTTP ${response.status} must not be retried`);
    }
});

test('retry: connection errors are retried, timeouts and cancellation are not', async () => {
    const flaky = fakeFetch([new TypeError('fetch failed'), okReply]);
    const reply = await new GeminiProvider({ apiKey: 'k', retryDelayMs: 1, fetchImpl: flaky })
        .chat({ system: '', messages: userMessages });
    assert.equal(reply.text, 'ok');
    assert.equal(flaky.calls.length, 2);

    // A request that hit its own timeout must not be repeated (it would double the wait).
    let timeoutAttempts = 0;
    const err = await requestJson({
        fetchImpl: async (_url, init) => {
            timeoutAttempts += 1;
            await new Promise((resolve) => init.signal.addEventListener('abort', resolve));
            throw new Error('aborted by timeout');
        },
        providerName: 'Test',
        url: 'http://x.test',
        timeoutMs: 20,
        retries: 3,
        retryDelayMs: 1
    }).catch((e) => e);
    assert.equal(err.kind, 'network');
    assert.match(err.message, /did not respond in time/);
    assert.equal(timeoutAttempts, 1);
});

test('retry: cancelling during the wait stops immediately', async () => {
    const controller = new AbortController();
    const fetchImpl = fakeFetch([busy503, okReply]);
    const provider = new GeminiProvider({ apiKey: 'k', retryDelayMs: 60000, fetchImpl });
    const pending = provider.chat({
        system: '',
        messages: userMessages,
        signal: controller.signal,
        onRetry: () => setTimeout(() => controller.abort(), 5)
    });
    const started = Date.now();
    const err = await pending.catch((e) => e);
    assert.equal(err.kind, 'aborted');
    assert.ok(Date.now() - started < 2000, 'must not wait out the 60 s delay');
    assert.equal(fetchImpl.calls.length, 1);
});

test('retry: also applies to Ollama and OpenAI-compatible servers', async () => {
    const ollama = fakeFetch([{ status: 503, json: { error: 'overloaded' } }, { json: { message: { content: 'hi' } } }]);
    const o = await new OllamaProvider({ retryDelayMs: 1, fetchImpl: ollama }).chat({ system: '', messages: userMessages });
    assert.equal(o.text, 'hi');

    const openai = fakeFetch([{ status: 502, json: {} }, { json: { choices: [{ message: { content: 'yo' } }] } }]);
    const p = await new OpenAICompatibleProvider({ model: 'm', retryDelayMs: 1, fetchImpl: openai }).chat({ system: '', messages: userMessages });
    assert.equal(p.text, 'yo');
});

test('xAI uses the Responses API with native tool calling and fixed endpoint', async () => {
    const fetchImpl = fakeFetch([{
        json: {
            status: 'completed',
            output: [
                { type: 'message', content: [{ type: 'output_text', text: 'hello from grok' }] },
                { type: 'function_call', call_id: 'call_1', name: 'list_formats', arguments: '{"url":"https://x.test/v"}' }
            ]
        }
    }]);
    const provider = createProvider({ type: 'xai', apiKey: 'xai-secret' }, { fetchImpl });
    assert.equal(provider.id, 'xai');
    assert.equal(provider.displayName, 'xAI');
    assert.equal(provider.model, 'grok-4.3');

    const reply = await provider.chat({
        system: 'sys',
        messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: '', toolCalls: [{ id: 'call_0', name: 'list_formats', args: { url: 'u' } }] },
            { role: 'tool', toolCallId: 'call_0', name: 'list_formats', result: { ok: true } }
        ],
        tools: TOOLS
    });
    assert.equal(reply.text, 'hello from grok');
    assert.equal(reply.toolCalls[0].id, 'call_1');
    assert.deepEqual(reply.toolCalls[0].args, { url: 'https://x.test/v' });
    const call = fetchImpl.calls[0];
    assert.equal(call.url, 'https://api.x.ai/v1/responses');
    assert.equal(call.init.headers.Authorization, 'Bearer xai-secret');
    assert.equal(call.body.model, 'grok-4.3');
    assert.equal(call.body.tools[0].name, 'list_formats');
    assert.deepEqual(call.body.input[2], {
        type: 'function_call_output',
        call_id: 'call_0',
        output: '{"ok":true}'
    });

    // Errors are labelled with the right provider name.
    const failing = createProvider({ type: 'xai', apiKey: 'k' }, { fetchImpl: fakeFetch([{ status: 401, json: { error: 'bad key' } }]) });
    const err = await failing.chat({ system: '', messages: userMessages }).catch((e) => e);
    assert.match(err.message, /^xAI rejected the API key/);

    // A custom model or URL overrides the defaults.
    const custom = createProvider({
        type: 'xai',
        apiKey: 'k',
        model: 'grok-4.3-fast',
        baseUrl: 'https://eu.api.x.ai/v1',
        reasoningEffort: 'high'
    });
    assert.equal(custom.model, 'grok-4.3-fast');
    assert.equal(custom.baseUrl, 'https://api.x.ai/v1');
    assert.equal(custom.reasoningEffort, 'high');
});

test('xAI streams response text deltas from the Responses API', async () => {
    const chunks = [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello "}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello world"}]}]}}\n\n'
    ];
    const fetchImpl = async () => ({
        ok: true,
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
            }
        })
    });
    const deltas = [];
    const provider = createProvider({ type: 'xai', apiKey: 'key' }, { fetchImpl });
    const reply = await provider.chat({
        system: '',
        messages: [{ role: 'user', text: 'hi' }],
        onTextDelta: (delta) => deltas.push(delta)
    });
    assert.deepEqual(deltas, ['hello ', 'world']);
    assert.equal(reply.text, 'hello world');
});

test('createProvider picks the right class and rejects unknown types', () => {
    assert.equal(createProvider({ type: 'gemini', apiKey: 'k' }).id, 'gemini');
    assert.equal(createProvider({ type: 'ollama' }).id, 'ollama');
    assert.equal(createProvider({ type: 'xai', apiKey: 'k' }).id, 'xai');
    assert.equal(createProvider({ type: 'openai-compatible', model: 'm' }).id, 'openai-compatible');
    assert.equal(createProvider({}).id, 'gemini');
    assert.throws(() => createProvider({ type: 'nope' }), ProviderError);
});
