import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ProxyError } from '../src/errors.js';
import { createProxyServer, listen } from '../src/server.js';

async function fixture(t, upstream = {}, overrides = {}) {
  const calls = [];
  const logs = [];
  const config = {
    host: '127.0.0.1', port: 0, model: '', apiKey: '', maxBodyBytes: 2048, timeoutMs: 5000, ...overrides,
  };
  const server = createProxyServer(config, {
    upstream: {
      models: async () => Response.json({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }),
      chat: async body => {
        calls.push(body);
        return Response.json({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } });
      },
      ...upstream,
    },
    log: message => logs.push(message),
  });
  const port = await listen(server, config);
  t.after(() => server.shutdown());
  return { url: `http://127.0.0.1:${port}`, port, calls, logs, server };
}

function post(url, body, options = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...options,
  });
}

test('health and model discovery use the actual bound port', async t => {
  const { url, port } = await fixture(t);
  assert.ok(port > 0);
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const catalog = await fetch(`${url}/v1/models`);
  assert.deepEqual((await catalog.json()).data.map(model => model.id), ['test-model']);
});

test('raw Copilot catalog is normalized to OpenAI model objects without dropping metadata', async t => {
  const raw = {
    data: [
      { id: 'copilot-raw-model', name: 'Raw model', vendor: 'Example vendor', capabilities: { type: 'chat', supports: { tool_calls: true } }, supported_endpoints: ['/chat/completions'] },
      { id: 'complete-model', object: 'model', created: 123, owned_by: 'existing-owner' },
      { id: 'minimal-model' },
    ],
  };
  const { url } = await fixture(t, { models: async () => Response.json(raw) });
  const catalog = await (await fetch(`${url}/v1/models`)).json();
  assert.equal(catalog.object, 'list');
  assert.equal(catalog.data[0].object, 'model');
  assert.equal(catalog.data[0].created, 0);
  assert.equal(catalog.data[0].owned_by, 'Example vendor');
  assert.deepEqual(catalog.data[0].capabilities, raw.data[0].capabilities);
  assert.deepEqual(catalog.data[0].supported_endpoints, ['/chat/completions']);
  assert.equal(catalog.data[1].created, 123);
  assert.equal(catalog.data[1].owned_by, 'existing-owner');
  assert.equal(catalog.data[2].owned_by, 'github-copilot');
});

test('malformed upstream catalogs are explicit errors, not empty success lists', async t => {
  const { url } = await fixture(t, { models: async () => Response.json({ data: [null] }) });
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_model_catalog');
});

test('optional bearer protects API routes but not liveness', async t => {
  const { url } = await fixture(t, {}, { apiKey: 'test-local-key' });
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const denied = await fetch(`${url}/v1/models`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'invalid_api_key');
  assert.equal((await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer test-local-key' } })).status, 200);
});

test('rejects browser origins and DNS rebinding hosts', async t => {
  const { url, port } = await fixture(t);
  assert.equal((await fetch(`${url}/health`, { headers: { origin: 'https://untrusted.invalid' } } )).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/health', headers: { host: 'untrusted.invalid' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('non-streaming tool messages and request parameters pass through without translation', async t => {
  const { url, calls } = await fixture(t);
  const body = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You write code.' },
      { role: 'user', content: 'Read the file.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'export default 1;' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    tool_choice: 'auto', temperature: 0.2, max_tokens: 32,
  };
  const response = await post(url, body);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [body]);
  const result = await response.json();
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.equal(result.usage.total_tokens, 4);
});

test('SSE relays tool deltas, usage, finish reasons and DONE byte-for-byte', async t => {
  const chunks = [
    'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a.js\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
    'data: [DONE]\n\n',
  ];
  let received;
  const { url } = await fixture(t, {
    chat: async body => {
      received = body;
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await post(url, { model: 'test-model', messages: [{ role: 'user', content: 'Hi' }], stream: true, stream_options: { include_usage: true } });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(await response.text(), chunks.join(''));
  assert.deepEqual(received.stream_options, { include_usage: true });
});

test('default model is used only when the request omits a model', async t => {
  const { url, calls } = await fixture(t, {}, { model: 'default-model' });
  await post(url, { messages: [{ role: 'user', content: 'Hi' }] });
  await post(url, { model: 'explicit-model', messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(calls.map(call => call.model), ['default-model', 'explicit-model']);
});

test('invalid JSON, shape, content type and over-limit bodies return structured errors', async t => {
  const { url } = await fixture(t);
  for (const [body, status] of [
    ['{', 400],
    [[], 400],
    [{ model: 'x', messages: [] }, 400],
    [{ messages: [{ role: 'user', content: 'Hi' }] }, 400],
    [{ model: 'x', messages: [{ role: 'user' }], stream: 'true' }, 400],
    ['x'.repeat(2049), 413],
  ]) {
    const response = await post(url, body);
    assert.equal(response.status, status);
    assert.ok((await response.json()).error.code);
  }
  const media = await post(url, '{}', { headers: { 'content-type': 'text/plain' } });
  assert.equal(media.status, 415);
});

test('chunked requests are bounded without destroying the error response', async t => {
  const { port } = await fixture(t, {}, { maxBodyBytes: 10 });
  const result = await new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write('123456');
    req.end('789012');
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'body_too_large');
});

test('upstream errors retain HTTP status and retry-after but redact raw bodies and headers', async t => {
  const { url } = await fixture(t, {
    models: async () => new Response('secret-upstream-token', { status: 429, headers: { 'retry-after': '3', authorization: 'Bearer secret-upstream-token' } }),
  });
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(response.headers.get('authorization'), null);
  assert.doesNotMatch(await response.text(), /secret-upstream-token/);
});

test('missing credentials fail before streaming and never leak exceptions', async t => {
  const { url, logs } = await fixture(t, {
    chat: async () => { throw new ProxyError(401, 'login_required', 'Run copilot-proxy login --accept-model-policy-changes first.', 'authentication_error'); },
    models: async () => { throw new Error('Bearer secret-upstream-token'); },
  });
  const response = await post(url, { model: 'x', messages: [{ role: 'user', content: 'Hi' }], stream: true });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const failed = await fetch(`${url}/v1/models`);
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /secret-upstream-token/);
  assert.doesNotMatch(logs.join(''), /secret-upstream-token/);
});

test('timeouts abort upstream and return 504 before headers', async t => {
  let aborted = false;
  const { url } = await fixture(t, {
    models: async signal => {
      try {
        await delay(10000, undefined, { signal });
      } finally {
        aborted = signal.aborted;
      }
    },
  }, { timeoutMs: 30 });
  const response = await fetch(`${url}/v1/models`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
  assert.equal(aborted, true);
});

test('client disconnect aborts an in-flight upstream request', async t => {
  let observeAbort;
  const aborted = new Promise(resolve => { observeAbort = resolve; });
  const { port } = await fixture(t, {
    models: async signal => {
      signal.addEventListener('abort', observeAbort, { once: true });
      await delay(10000, undefined, { signal });
    },
  });
  const req = request({ hostname: '127.0.0.1', port, path: '/v1/models' });
  req.on('error', () => {});
  req.end();
  await delay(30);
  req.destroy();
  await Promise.race([aborted, delay(1000).then(() => { throw new Error('Upstream was not aborted'); })]);
});

test('unknown APIs and wrong methods have explicit errors', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(`${url}/v1/responses`)).status, 405);
  assert.equal((await fetch(`${url}/v1/embeddings`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${url}/v1/chat/completions`)).status, 405);
});

test('an occupied port fails instead of silently choosing another', async t => {
  const first = await fixture(t);
  const config = { host: '127.0.0.1', port: first.port, timeoutMs: 1000 };
  const second = createProxyServer(config, { upstream: {} });
  await assert.rejects(listen(second, config), { code: 'EADDRINUSE' });
});

test('Responses HTTP requests and event streams pass through unchanged', async t => {
  const body = {
    model: 'responses-test-model', stream: true, store: false,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Read a.js' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'export default 1;' },
    ],
  };
  const events = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"total_tokens":8}}}\n\n';
  let forwarded;
  const { url } = await fixture(t, {
    responses: async value => {
      forwarded = value;
      return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await fetch(`${url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, body);
  assert.equal(await response.text(), events);
});

test('mid-stream failure emits a structured error without pretending success', async t => {
  const { url } = await fixture(t, {
    chat: async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
        await delay(20);
        controller.error(new Error('secret-stream-error'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const response = await post(url, { model: 'x', stream: true, messages: [{ role: 'user', content: 'Hi' }] });
  const content = await response.text();
  assert.match(content, /upstream_unavailable/);
  assert.doesNotMatch(content, /secret-stream-error|\[DONE\]/);
});
