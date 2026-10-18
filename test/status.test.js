import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { listen } from '../src/server.js';
import { getStatus } from '../src/status.js';

test('status only requests local health and distinguishes service failures', async t => {
  let status = 200, body, requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/health');
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(status, { 'content-type': 'application/json', location: '/must-not-follow' });
    res.end(body);
  });
  const port = await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { host: '127.0.0.1', port, adapterPort: port,
    get apiKey() { assert.fail('Status must not read credentials'); } };
  for (const [httpStatus, payload, expected] of [
    [200, '{"service":"copilot-proxy","status":"ok"}', 'Running'],
    [200, '{"service":"copilot-proxy","status":"failed"}', 'Unhealthy'],
    [200, '{"service":"another-service","status":"ok"}', 'Other service'],
    [200, 'null', 'Other service'],
    [200, 'not-json', 'Unexpected response'],
    [503, '{}', 'HTTP 503'],
    [302, '{}', 'HTTP 302'],
  ]) {
    status = httpStatus; body = payload;
    const before = requests;
    assert.equal((await getStatus(config))[0].state, expected);
    assert.equal(requests - before, 2);
  }
  await new Promise(resolve => server.close(resolve));
  assert.deepEqual((await getStatus(config)).map(row => row.state), ['Stopped', 'Stopped']);
});

test('status times out an unresponsive listener', { timeout: 5000 }, async t => {
  const server = http.createServer(() => {});
  const port = await listen(server, { host: '127.0.0.1', port: 0 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.deepEqual((await getStatus({ host: '127.0.0.1', port, adapterPort: port })).map(row => row.state),
    ['Unreachable', 'Unreachable']);
});
