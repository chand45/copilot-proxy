import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import test from 'node:test';
import { startServices } from '../src/services.js';
import { listen } from '../src/server.js';
import { endpoint } from '../src/config.js';
import { getStatus } from '../src/status.js';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-proxy-services-'));
  const authPath = join(directory, 'auth.json');
  await writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-codex-token' } }));
  const config = { host: '127.0.0.1', port: 0, adapterPort: 0, adapterEnabled: true,
    apiKey: 'fake-proxy-key', maxBodyBytes: 2048, timeoutMs: 1000, ...overrides };
  const calls = [], logs = [];
  const services = await startServices(config, {
    env: { CODEX_HOME: directory }, log: entry => logs.push(entry),
    upstream: {
      models: async () => Response.json({ data: [{ id: 'test-model' }] }),
      responses: async body => {
        calls.push(body);
        return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      },
    },
  });
  t.after(async () => {
    await services.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return { services, calls, logs, authPath, config: { ...config, port: services.port, adapterPort: services.adapterPort } };
}

test('combined services forward compressed requests through the actual IPv4 or IPv6 proxy port', async t => {
  for (const host of ['127.0.0.1', '::1']) {
    await t.test(host, async t => {
      const f = await fixture(t, { host });
      const url = endpoint('127.0.0.1', f.config.adapterPort);
      const health = await (await fetch(`${url}/health`)).json();
      assert.equal(health.upstream, endpoint(host, f.config.port));
      const headers = { authorization: 'Bearer fake-codex-token' };
      assert.deepEqual(await (await fetch(`${url}/v1/models`, { headers })).json(), { models: [] });
      const body = { model: 'test-model', input: 'private-prompt', stream: true };
      const response = await fetch(`${url}/v1/responses`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'content-encoding': 'zstd' },
        body: zstdCompressSync(JSON.stringify(body)) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /response.completed/);
      assert.deepEqual(f.calls, [body]);
      assert.doesNotMatch(f.logs.join('\n'), /private-prompt|fake-codex-token|fake-proxy-key/);
      await writeFile(f.authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'rotated-token' } }));
      const expired = await fetch(`${url}/v1/models`, { headers });
      assert.equal(expired.status, 401);
      await expired.text();
      const rotated = await fetch(`${url}/v1/models`, { headers: { authorization: 'Bearer rotated-token' } });
      assert.equal(rotated.status, 200);
      await rotated.text();
    });
  }
});

test('the adapter applies the configured body limit before forwarding', async t => {
  const f = await fixture(t, { maxBodyBytes: 128 });
  const response = await fetch(`${endpoint('127.0.0.1', f.config.adapterPort)}/v1/responses`, {
    method: 'POST', headers: { authorization: 'Bearer fake-codex-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', input: 'x'.repeat(200) }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.type, 'adapter_error');
  assert.equal(f.calls.length, 0);
});

test('an occupied adapter is never borrowed, and failed startup releases the new proxy port', async t => {
  const f = await fixture(t);
  const probe = http.createServer();
  const port = await listen(probe, { host: '127.0.0.1', port: 0 });
  await new Promise(resolve => probe.close(resolve));
  await assert.rejects(startServices({ ...f.config, port }, { upstream: {} }), { code: 'adapter_start_failed' });
  await listen(probe, { host: '127.0.0.1', port });
  await new Promise(resolve => probe.close(resolve));
  assert.deepEqual((await getStatus(f.config)).map(row => row.state), ['Running', 'Running']);
});

test('shutdown is idempotent and closes both listeners with incomplete HTTP connections', async t => {
  const f = await fixture(t);
  // Leave a fetch connection in the shared pool before shutting down.
  const health = await fetch(`${endpoint(f.config.host, f.config.port)}/health`);
  await health.json();
  const sockets = [];
  t.after(() => sockets.forEach(socket => socket.destroy()));
  for (const port of [f.config.port, f.config.adapterPort]) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write('GET /health HTTP/1.1\r\n');
  }
  const closed = sockets.map(socket => new Promise(resolve => socket.once('close', resolve)));
  await Promise.all([f.services.shutdown(), f.services.shutdown(), ...closed]);
  assert.deepEqual((await getStatus(f.config)).map(row => row.state), ['Stopped', 'Stopped']);
});

test('explicit opt-out starts just the proxy even if the adapter port is occupied', async t => {
  const occupied = http.createServer();
  const port = await listen(occupied, { host: '127.0.0.1', port: 0 });
  t.after(() => occupied.close());
  const f = await fixture(t, { adapterEnabled: false, adapterPort: port });
  assert.equal(f.services.adapterPort, undefined);
  assert.equal((await fetch(`${endpoint(f.config.host, f.config.port)}/health`)).status, 200);
});
