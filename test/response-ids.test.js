import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stabilizeResponseIds } from '../src/response-ids.js';
import { createCopilotUpstream } from '../src/upstream.js';

const encode = value => new TextEncoder().encode(value);
const frame = (value, newline = '\n') => `event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
const parse = text => text.split(/(?:\r\n|\r(?!\n)|\n){2}/).flatMap(part => {
  const data = part.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
});
function upstream(text, chunkSize = Infinity, extraHeaders = {}) {
  const bytes = encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  }), { headers: { 'content-type': 'text/event-stream', ...extraHeaders } });
}
const added = (index, id, extra = {}) => ({ type: 'response.output_item.added', output_index: index, item: { type: 'message', id, ...extra } });
const delta = (index, id, text = 'Hello') => ({ type: 'response.output_text.delta', output_index: index, item_id: id, content_index: 0, delta: text });
const done = (index, id, extra = {}) => ({ type: 'response.output_item.done', output_index: index, item: { type: 'message', id, ...extra } });

test('captured failing stream has one stable identity after normalization, including response.completed', async () => {
  const { events } = JSON.parse(await readFile(new URL('./fixtures/rotating-response-ids.json', import.meta.url), 'utf8'));
  const originalText = events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('');
  const result = parse(await stabilizeResponseIds(upstream(events.map(e => frame(e)).join(''), 7)).text());
  const ids = result.flatMap(e => e.item_id ? [e.item_id] : e.item ? [e.item.id] : e.response?.output?.map(i => i.id) ?? []);
  assert.equal(new Set(ids).size, 1);
  assert.equal(new Set(result.flatMap(e => e.response?.id ? [e.response.id] : [])).size, 1);
  assert.equal(result.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''), originalText);
  assert.deepEqual(result.map(e => e.sequence_number), events.map(e => e.sequence_number));
  assert.deepEqual(result.at(-1).response.usage, events.at(-1).response.usage);
});

test('interleaved items and identical commentary keep their separate output identities', async () => {
  const events = [added(0, 'first'), added(1, 'second'), delta(1, 'second-rotated', 'same text'), delta(0, 'first-rotated', 'same text'), done(1, 'second-done'), done(0, 'first-done')];
  const result = parse(await stabilizeResponseIds(upstream(events.map(e => frame(e)).join(''))).text());
  assert.deepEqual(result.map(e => e.item_id ?? e.item.id), ['first', 'second', 'second', 'first', 'second', 'first']);
  assert.equal(result.length, events.length);
});

test('reasoning, namespaced function and custom tools preserve payloads and call IDs', async () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'opaque-reasoning-do-not-change', summary: [{ type: 'summary_text', text: 'Checking.' }] };
  const tool = { type: 'function_call', call_id: 'call_123', name: 'read', namespace: 'files', arguments: '{"path":"x"}' };
  const custom = { type: 'custom_tool_call', call_id: 'call_456', name: 'exec', input: 'print(1)' };
  const events = [added(0, 'reason-start', reasoning), added(1, 'tool-start', tool), added(2, 'custom-start', custom),
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'reason-delta', summary_index: 0, delta: 'Checking.' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'tool-delta', delta: tool.arguments },
    { type: 'response.custom_tool_call_input.delta', output_index: 2, item_id: 'custom-delta', delta: custom.input },
    done(0, 'reason-done', reasoning), done(1, 'tool-done', tool), done(2, 'custom-done', custom),
    { type: 'response.completed', response: { id: 'resp', output: [{ ...reasoning, id: 'reason-final' }, { ...tool, id: 'tool-final' }, { ...custom, id: 'custom-final' }] } }];
  const result = parse(await stabilizeResponseIds(upstream(events.map(e => frame(e)).join(''))).text());
  assert.deepEqual(result.at(-1).response.output, [{ ...reasoning, id: 'reason-start' }, { ...tool, id: 'tool-start' }, { ...custom, id: 'custom-start' }]);
  assert.deepEqual(result.slice(3, 6).map(e => e.item_id), ['reason-start', 'tool-start', 'custom-start']);
});

for (const newline of ['\n', '\r\n', '\r']) {
  test(`SSE and UTF-8 fragmentation with ${JSON.stringify(newline)} line endings`, async () => {
    const text = [added(0, 'first'), delta(0, 'rotated', '你好 → café'), done(0, 'done')].map(e => frame(e, newline)).join('');
    const result = parse(await stabilizeResponseIds(upstream(text, 1)).text());
    assert.equal(result[1].delta, '你好 → café');
    assert.deepEqual(result.map(e => e.item_id ?? e.item.id), ['first', 'first', 'first']);
  });
}

test('stable streams retain exact formatting, comments, unknown events and DONE', async () => {
  const text = ': keepalive\r\n\r\n' + frame(added(0, 'stable'), '\r\n')
    + 'retry: 1000\r\nid: transport-id\r\nevent: response.output_text.delta\r\ndata: { "type": "response.output_text.delta", "output_index": 0, "item_id": "stable", "delta": "é" }\r\n\r\n'
    + frame({ type: 'unknown', item_id: 'not-an-output-id', output_index: 0 }) + 'data: [DONE]\n\n';
  assert.equal(await stabilizeResponseIds(upstream(text, 1)).text(), text);
});

test('multiline data changes only data fields and preserves SSE transport metadata', async () => {
  const text = frame(added(0, 'first')) + ': keep\r\nid: transport-id\r\nretry: 1000\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "output_index":0,"item_id":"rotated","delta":"OK"}\r\n\r\n';
  const output = await stabilizeResponseIds(upstream(text, 2)).text();
  assert.match(output, /: keep\r\nid: transport-id\r\nretry: 1000\r\nevent: response.output_text.delta/);
  assert.equal(parse(output)[1].item_id, 'first');
});

test('delta before added, response_id references and terminal events are consistent', async () => {
  const events = [{ ...delta(0, 'early'), response_id: 'resp-first' }, added(0, 'late'), { type: 'response.incomplete', response: { id: 'resp-late', status: 'incomplete', output: [{ type: 'message', id: 'terminal' }], incomplete_details: { reason: 'max_output_tokens' } } }];
  const result = parse(await stabilizeResponseIds(upstream(events.map(e => frame(e)).join('').trimEnd())).text());
  assert.equal(result[1].item.id, 'early');
  assert.equal(result[2].response.id, 'resp-first');
  assert.equal(result[2].response.output[0].id, 'early');
  assert.equal(result[2].response.status, 'incomplete');
});

test('normalization state is isolated per HTTP response', async () => {
  const [first, second] = await Promise.all(['a', 'b'].map(id => stabilizeResponseIds(upstream(frame(added(0, id)) + frame(done(0, 'rotated')), 3)).text()));
  assert.equal(parse(first)[1].item.id, 'a');
  assert.equal(parse(second)[1].item.id, 'b');
});

test('non-streaming JSON, HTTP errors and unrelated streams are not rewritten', async () => {
  for (const response of [new Response('{"id":"json"}', { headers: { 'content-type': 'application/json' } }), new Response('error', { status: 429 }), new Response(null, { status: 204 })]) {
    assert.equal(stabilizeResponseIds(response), response);
  }
  const text = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n';
  assert.equal(await stabilizeResponseIds(upstream(text)).text(), text);
});

test('invalid or interrupted streams fail without inventing a completed response', async () => {
  await assert.rejects(stabilizeResponseIds(upstream(frame(added(0, 'id')) + 'data: {broken}\n\n')).text(), { code: 'invalid_responses_stream' });
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('disconnected')); } }), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(stabilizeResponseIds(response).text(), /disconnected/);
});

test('client cancellation propagates to the upstream body', async () => {
  let cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(encode(frame(added(0, 'first')))); },
    cancel(reason) { cancelled(reason); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const reader = stabilizeResponseIds(response).body.getReader();
  await reader.read();
  await reader.cancel('client stopped');
  assert.equal(await cancellation, 'client stopped');
});

test('rewritten streams drop invalid length and encoding but retain response headers', async () => {
  const response = stabilizeResponseIds(upstream(frame(added(0, 'first')), Infinity, { 'content-length': '999', 'content-encoding': 'gzip', 'x-request-id': 'trace' }));
  assert.equal(response.headers.has('content-length'), false);
  assert.equal(response.headers.has('content-encoding'), false);
  assert.equal(response.headers.get('x-request-id'), 'trace');
  await response.text();
});

test('upstream integration preserves full replay request, reasoning and tool result IDs', async () => {
  const body = { model: 'test-model', stream: true, store: false, input: [
    { type: 'reasoning', id: 'first-provider-reason-id', encrypted_content: 'encrypted' },
    { type: 'function_call', id: 'first-provider-tool-id', call_id: 'call_1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '42' },
  ] };
  let forwarded;
  const adapter = createCopilotUpstream({
    auth: { getAuth: async () => ({ apiKey: 'fake-token', baseUrl: 'https://api.individual.githubcopilot.com' }) },
    headersForRequest: () => ({}),
    fetchImpl: async (_url, init) => { forwarded = JSON.parse(init.body); return upstream(frame(added(0, 'first')) + frame(done(0, 'rotated'))); },
  });
  const result = parse(await (await adapter.responses(body, new AbortController().signal)).text());
  assert.deepEqual(forwarded, body);
  assert.equal(result[1].item.id, 'first');
});
