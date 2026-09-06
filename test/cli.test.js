import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import packageJson from '../package.json' with { type: 'json' };

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI help/env work and login requires policy acknowledgment before loading auth', async () => {
  const env = { ...process.env, COPILOT_PROXY_API_KEY: 'fake-local-secret', COPILOT_PROXY_HOST: '127.0.0.1', COPILOT_PROXY_PORT: '4141' };
  const help = await execute(process.execPath, [cli, '--help'], { env });
  assert.match(help.stdout, /--accept-model-policy-changes/);
  assert.match(help.stdout, /copilot-proxy start/);
  assert.match(help.stdout, /copilot-proxy login/);
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

test('CLI starts a real local server without login and prints its actual ephemeral port', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-proxy-cli-test-'));
  const authFile = join(directory, 'not-logged-in.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, 'start', '--port', '0', '--auth-file', authFile], {
    env: {
      ...process.env, COPILOT_PROXY_HOST: '127.0.0.1', COPILOT_PROXY_API_KEY: '',
      COPILOT_PROXY_MODEL: '', COPILOT_PROXY_TIMEOUT_MS: '1000',
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
  assert.match(output, new RegExp(`${new URL(url).port}/v1`));
  await assert.rejects(stat(authFile), { code: 'ENOENT' });
});
