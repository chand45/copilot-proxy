import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import packageJson from '../package.json' with { type: 'json' };
import { listen } from '../src/server.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI help/env work and login requires policy acknowledgment before loading auth', async () => {
  const env = { ...process.env, COPILOT_PROXY_API_KEY: 'fake-local-secret', COPILOT_PROXY_HOST: '127.0.0.1', COPILOT_PROXY_PORT: '4141' };
  const help = await execute(process.execPath, [cli, '--help'], { env });
  assert.match(help.stdout, /--accept-model-policy-changes/);
  assert.match(help.stdout, /copilot-proxy start/);
  assert.match(help.stdout, /copilot-proxy login/);
  assert.match(help.stdout, /Default\/max: 512000000 \(512 MB\)/);
  const version = await execute(process.execPath, [cli, '--version'], { env });
  assert.equal(version.stdout.trim(), packageJson.version);
  const setup = await execute(process.execPath, [cli, 'env', '--port', '43210'], { env });
  assert.match(setup.stdout, /127\.0\.0\.1:43210\/v1/);
  assert.match(setup.stdout, /OPENAI_API_BASE/);
  assert.doesNotMatch(setup.stdout, /fake-local-secret/);
  await assert.rejects(execute(process.execPath, [cli, 'login'], { env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /copilot-proxy login --accept-model-policy-changes/);
    assert.doesNotMatch(error.stdout, /device code/i);
    return true;
  });
});

test('CLI exits cleanly when the adapter port is occupied, and --no-adapter permits proxy-only startup', async t => {
  const occupied = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"service":"another-service","status":"ok"}'); });
  const port = await listen(occupied, { host: '127.0.0.1', port: 0 });
  t.after(() => { occupied.closeAllConnections(); occupied.close(); });
  await assert.rejects(execute(process.execPath, [cli, 'start', '--port', '0', '--adapter-port', String(port)], {
    env: { ...process.env, COPILOT_PROXY_HOST: '127.0.0.1' }, timeout: 10000,
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /adapter_start_failed/);
    assert.doesNotMatch(error.stdout, /listening at/);
    return true;
  });
  const child = spawn(process.execPath, [cli, 'start', '--port', '0', '--adapter-port', String(port), '--no-adapter'], {
    env: { ...process.env, COPILOT_PROXY_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const deadline = Date.now() + 10000;
  while (!output.includes('listening at') && Date.now() < deadline) await delay(20);
  assert.match(output, /Copilot proxy listening at/);
  assert.doesNotMatch(output, /Codex Remote adapter/);
  const proxyUrl = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)[1];
  await assert.rejects(execute(process.execPath, [cli, 'status', '--port', new URL(proxyUrl).port,
    '--adapter-port', String(port)], { env: { ...process.env, COPILOT_PROXY_HOST: '127.0.0.1' } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /Model serving.*Running/);
    assert.match(error.stdout, /Codex Remote adapter.*Other service/);
    return true;
  });
});

test('CLI starts a real local server without login and prints its actual ephemeral port', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-proxy-cli-test-'));
  const authFile = join(directory, 'not-logged-in.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake-codex-token' } }));
  const child = spawn(process.execPath, [cli, 'start', '--port', '0', '--adapter-port', '0', '--auth-file', authFile], {
    env: {
      ...process.env, COPILOT_PROXY_HOST: '127.0.0.1', COPILOT_PROXY_API_KEY: '',
      COPILOT_PROXY_MODEL: '', COPILOT_PROXY_TIMEOUT_MS: '1000',
      COPILOT_PROXY_MAX_BODY_BYTES: '512000000',
      CODEX_HOME: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { errors += value; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  });
  const deadline = Date.now() + 10000;
  let url;
  while (!url && Date.now() < deadline) {
    if (child.exitCode !== null) assert.fail(`CLI exited: ${errors}`);
    url = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) await delay(20);
  }
  assert.ok(url, `CLI did not become ready: ${errors}`);
  assert.notEqual(new URL(url).port, '0');
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const denied = await fetch(`${url}/v1/models`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'login_required');
  const adapterUrl = output.match(/Codex Remote adapter listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(adapterUrl, output);
  const adapterHealth = await (await fetch(`${adapterUrl}/health`)).json();
  assert.equal(adapterHealth.service, 'codex-copilot-adapter');
  assert.equal(adapterHealth.pid, child.pid);
  assert.equal(adapterHealth.upstream, url);
  const adapterModels = await fetch(`${adapterUrl}/v1/models`, { headers: { authorization: 'Bearer fake-codex-token' } });
  assert.equal(adapterModels.status, 401);
  assert.equal((await adapterModels.json()).error.code, 'login_required');
  const status = await execute(process.execPath, [cli, 'status', '--port', new URL(url).port,
    '--adapter-port', new URL(adapterUrl).port], { env: { ...process.env, CODEX_HOME: join(directory, 'missing') } });
  assert.match(status.stdout, /Model serving.*Running/);
  assert.match(status.stdout, /Codex Remote adapter.*Running/);
  assert.doesNotMatch(status.stdout + status.stderr, /fake-codex-token/);
  assert.match(output, new RegExp(`${new URL(url).port}/v1`));
  assert.match(output, /Request body limit: 512000000 bytes/);
  await assert.rejects(stat(authFile), { code: 'ENOENT' });
});
