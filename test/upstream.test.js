import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createCopilotUpstream, validateBaseUrl } from '../src/upstream.js';
import { createPiIntegration } from '../src/pi.js';
import { createProxyServer, listen } from '../src/server.js';

test('installed published Pi exposes OAuth and bundled headers without account access', async () => {
  const { oauth, headersForRequest } = await createPiIntegration();
  for (const name of ['login', 'refresh', 'toAuth']) assert.equal(typeof oauth[name], 'function');
  const headers = headersForRequest({ model: 'unbundled-test-model', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(headers['Copilot-Integration-Id'], 'vscode-chat');
  assert.match(headers['User-Agent'], /^GitHubCopilotChat\//);
  assert.equal(headers['X-Initiator'], 'user');
  assert.equal(headers['Openai-Intent'], 'conversation-edits');
  assert.equal(headersForRequest()['X-GitHub-Api-Version'], '2026-06-01');
});

test('Copilot dynamic headers classify tool turns, Responses input, and images', async () => {
  const { headersForRequest } = await createPiIntegration();
  assert.equal(headersForRequest({ messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'done' }] })['X-Initiator'], 'agent');
  assert.equal(headersForRequest({ input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }] })['X-Initiator'], 'agent');
  assert.equal(headersForRequest({ input: 'Hi' })['X-Initiator'], 'user');
  assert.equal(headersForRequest({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,fake' }] }] })['Copilot-Vision-Request'], 'true');
  assert.equal(headersForRequest({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/fake.png' } }] }] })['Copilot-Vision-Request'], 'true');
});

test('native Anthropic tool results use agent headers and retain nested image detection', async () => {
  const { headersForRequest } = await createPiIntegration();
  const body = {
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'toolu_1',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fake' } }],
      }],
    }],
  };
  const original = structuredClone(body);
  const headers = headersForRequest(body);
  assert.equal(headers['X-Initiator'], 'agent');
  assert.equal(headers['Copilot-Vision-Request'], 'true');
  assert.equal(headers['Openai-Intent'], 'conversation-edits');
  assert.deepEqual(body, original);
  const textResult = headersForRequest({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] }] });
  assert.equal(textResult['X-Initiator'], 'agent');
  assert.equal(textResult['Copilot-Vision-Request'], undefined);
  assert.equal(headersForRequest({ messages: [...body.messages, { role: 'user', content: 'Now explain it.' }] })['X-Initiator'], 'user');
  assert.equal(headersForRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] })['X-Initiator'], 'user');
});

test('Messages forwards native payloads with allowlisted headers and Copilot authentication', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const upstreamResponse = Response.json({ type: 'message', content: [{ type: 'text', text: 'Hello' }] });
  const upstream = createCopilotUpstream({
    auth: { getAuth: async requestSignal => {
      assert.equal(requestSignal, signal);
      return { apiKey: 'fake-copilot-token', baseUrl: 'https://api.business.githubcopilot.com' };
    } },
    headersForRequest: () => ({ 'Copilot-Integration-Id': 'vscode-chat', 'X-Initiator': 'agent' }),
    fetchImpl: async (url, init) => {
      calls.push({ url: url.href, ...init, headers: new Headers(init.headers) });
      return upstreamResponse;
    },
  });
  const body = {
    model: 'claude-test', max_tokens: 2048,
    system: [{ type: 'text', text: 'Keep this exactly.', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Plan', signature: 'opaque-signature' },
        { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.js' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
    ],
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    thinking: { type: 'adaptive' }, metadata: { user_id: 'test' }, future_option: { preserve: true },
  };
  const original = structuredClone(body);
  const response = await upstream.messages(body, signal, {
    beta: true,
    headers: {
      'Anthropic-Version': '2023-06-02', 'ANTHROPIC-BETA': 'test-beta,other-beta',
      Authorization: 'Bearer fake-client-token', 'x-api-key': 'fake-client-key',
      'X-Initiator': 'user', 'Copilot-Integration-Id': 'untrusted', 'x-arbitrary': 'drop-me',
    },
  });
  assert.equal(response, upstreamResponse);
  assert.equal(calls[0].url, 'https://api.business.githubcopilot.com/v1/messages?beta=true');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer fake-copilot-token');
  assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-02');
  assert.equal(calls[0].headers.get('anthropic-beta'), 'test-beta,other-beta');
  assert.equal(calls[0].headers.get('x-initiator'), 'agent');
  assert.equal(calls[0].headers.get('copilot-integration-id'), 'vscode-chat');
  assert.equal(calls[0].headers.get('accept'), 'application/json');
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  assert.equal(calls[0].headers.get('x-api-key'), null);
  assert.equal(calls[0].headers.get('x-arbitrary'), null);
  assert.deepEqual(JSON.parse(calls[0].body), original);
  assert.deepEqual(body, original);
});

test('Messages defaults its version, leaves beta opt-in, and returns native SSE unchanged', async () => {
  const calls = [];
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\nevent: future_event\ndata: {"type":"future_event","opaque":true}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstream = createCopilotUpstream({
    auth: { getAuth: async () => ({ apiKey: 'fake-copilot-token', baseUrl: 'https://api.individual.githubcopilot.com' }) },
    headersForRequest: () => ({}),
    fetchImpl: async (url, init) => {
      calls.push({ url: url.href, headers: new Headers(init.headers) });
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await upstream.messages({ model: 'claude-test', messages: [], stream: true }, new AbortController().signal);
  assert.equal(calls[0].url, 'https://api.individual.githubcopilot.com/v1/messages');
  assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01');
  assert.equal(calls[0].headers.get('anthropic-beta'), null);
  assert.equal(calls[0].headers.get('accept'), 'text/event-stream');
  assert.equal(await response.text(), sse);
});

test('Messages errors retain capability details while removing secrets and arbitrary fields', async () => {
  const token = 'fake-upstream-secret';
  const upstream = createCopilotUpstream({
    auth: { getAuth: async () => ({ apiKey: token, baseUrl: 'https://api.individual.githubcopilot.com' }) },
    headersForRequest: () => ({}),
    fetchImpl: async () => Response.json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Unsupported beta capability for bearer ${token}; token=${token}`,
        debug: { authorization: token },
      },
      secret: token, request: { headers: { authorization: token } },
    }, { status: 400, headers: {
      'retry-after': '2', 'x-request-id': 'request-1', 'x-ratelimit-remaining': '0',
      'content-length': '9000', 'content-encoding': 'gzip', 'x-debug-secret': token,
    } }),
  });
  const response = await upstream.messages({ model: 'claude-test' }, new AbortController().signal);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(response.headers.get('x-request-id'), 'request-1');
  assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('x-debug-secret'), null);
  assert.deepEqual(await response.json(), {
    type: 'error', error: {
      type: 'invalid_request_error',
      message: 'Unsupported beta capability for bearer [redacted]; token=[redacted]',
    },
  });
});

test('Messages malformed and non-native errors use a safe Anthropic fallback', async () => {
  for (const failure of [
    { body: 'not-json fake-upstream-secret', contentType: 'application/json', status: 400 },
    { body: '{"error":{"message":"fake-upstream-secret"},"debug":"secret"}', contentType: 'application/json', status: 503 },
    { body: '<html>fake-upstream-secret</html>', contentType: 'text/html', status: 302 },
  ]) {
    const upstream = createCopilotUpstream({
      auth: { getAuth: async () => ({ apiKey: 'fake-upstream-secret', baseUrl: 'https://api.individual.githubcopilot.com' }) },
      headersForRequest: () => ({}),
      fetchImpl: async () => new Response(failure.body, { status: failure.status, headers: { 'content-type': failure.contentType } }),
    });
    const response = await upstream.messages({ model: 'claude-test' }, new AbortController().signal);
    assert.equal(response.status, failure.status === 302 ? 502 : failure.status);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const body = await response.json();
    assert.deepEqual(body, {
      type: 'error', error: {
        type: response.status >= 500 ? 'api_error' : 'invalid_request_error',
        message: `Copilot returned HTTP ${failure.status}. Check subscription access, model support, request parameters, or rate limits.`,
      },
    });
  }
});

test('untrusted credential endpoints cannot receive tokens', () => {
  assert.equal(validateBaseUrl('https://api.individual.githubcopilot.com').origin, 'https://api.individual.githubcopilot.com');
  for (const url of [
    'http://api.individual.githubcopilot.com', 'https://githubcopilot.com.attacker.invalid',
    'https://attacker.invalid', 'https://user:password@api.githubcopilot.com',
    'https://api.githubcopilot.com:444', 'https://api.githubcopilot.com/path',
    'https://api.githubcopilot.com?token=fake', 'not-a-url',
  ]) assert.throws(() => validateBaseUrl(url), { code: 'invalid_copilot_endpoint' });
});

test('HTTP end-to-end relays through a mocked Copilot network boundary', async t => {
  const calls = [];
  const copilot = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    if (req.url === '/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    } else if (JSON.parse(text).stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }], usage: { total_tokens: 8 } }));
    }
  });
  await new Promise(resolve => copilot.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { copilot.close(resolve); copilot.closeAllConnections(); }));
  const copilotUrl = `http://127.0.0.1:${copilot.address().port}`;
  const integration = await createPiIntegration();
  const upstream = createCopilotUpstream({
    auth: { getAuth: async () => ({ apiKey: 'fake-upstream-token', baseUrl: 'https://api.individual.githubcopilot.com' }) },
    headersForRequest: integration.headersForRequest,
    fetchImpl: (url, init) => {
      assert.equal(url.origin, 'https://api.individual.githubcopilot.com');
      assert.equal(init.redirect, 'manual');
      return fetch(new URL(url.pathname, copilotUrl), init);
    },
  });
  const config = { host: '127.0.0.1', port: 0, timeoutMs: 5000, apiKey: 'fake-local-key', maxBodyBytes: 2048 };
  const proxy = createProxyServer(config, { upstream });
  const port = await listen(proxy, config);
  t.after(() => proxy.shutdown());
  const base = `http://127.0.0.1:${port}/v1`;
  const headers = { authorization: 'Bearer fake-local-key', 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/models`, { headers })).status, 200);
  const requestBody = {
    model: 'fake-model',
    messages: [{ role: 'user', content: 'Read a.js' }, { role: 'tool', content: 'export default 1;', tool_call_id: 'call_1' }],
  };
  const json = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(requestBody) });
  assert.equal((await json.json()).usage.total_tokens, 8);
  const streaming = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...requestBody, stream: true }) });
  assert.match(await streaming.text(), /\[DONE\]/);
  const responses = await fetch(`${base}/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'fake-model', input: 'Hi' }) });
  assert.equal(responses.status, 200);
  assert.deepEqual(calls.map(call => call.path), ['/models', '/chat/completions', '/chat/completions', '/responses']);
  for (const call of calls) {
    assert.equal(call.headers.authorization, 'Bearer fake-upstream-token');
    assert.equal(call.headers['copilot-integration-id'], 'vscode-chat');
  }
  assert.equal(calls[0].headers['x-github-api-version'], '2026-06-01');
  assert.equal(calls[1].headers['x-initiator'], 'agent');
  assert.deepEqual(calls[1].body, requestBody);
});
