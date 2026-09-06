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
