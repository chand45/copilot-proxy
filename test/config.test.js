import assert from 'node:assert/strict';
import { constants as bufferConstants } from 'node:buffer';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test from 'node:test';
import { defaultAuthFile, endpoint, environmentSetup, parseArgs } from '../src/config.js';

const cwd = join(tmpdir(), 'copilot-proxy-config-test');
const env = { COPILOT_PROXY_AUTH_FILE: join(tmpdir(), 'proxy-auth-test.json') };

test('defaults are loopback-only with no assumed model', () => {
  const config = parseArgs([], env, cwd);
  assert.equal(config.command, 'start');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4141);
  assert.equal(config.model, '');
  assert.equal(config.apiKey, '');
  assert.equal(config.maxBodyBytes, 512_000_000);
  assert.ok(config.maxBodyBytes < bufferConstants.MAX_STRING_LENGTH);
});

test('body limits honor environment and CLI overrides up to 512 MB', () => {
  const bodyEnv = { ...env, COPILOT_PROXY_MAX_BODY_BYTES: '4194304' };
  assert.equal(parseArgs([], bodyEnv, cwd).maxBodyBytes, 4194304);
  assert.equal(parseArgs(['--max-body-bytes', '512000000'], bodyEnv, cwd).maxBodyBytes, 512000000);
  assert.equal(parseArgs([], { ...env, COPILOT_PROXY_MAX_BODY_BYTES: '512000000' }, cwd).maxBodyBytes, 512000000);
  assert.throws(() => parseArgs([], { ...env, COPILOT_PROXY_MAX_BODY_BYTES: '512000001' }, cwd));
});

test('installed commands can use the default credential store from the home directory', () => {
  for (const command of ['start', 'login', 'env']) {
    const config = parseArgs([command], {}, homedir());
    assert.equal(config.command, command);
    assert.equal(config.authFile, defaultAuthFile({}));
  }
});

test('CLI settings override environment settings and honor actual port', () => {
  const config = parseArgs(['start', '--port=0', '--host', '::1', '--model', 'test-model'], {
    ...env, COPILOT_PROXY_PORT: '10000', COPILOT_PROXY_API_KEY: 'private-test-value',
  }, cwd);
  assert.equal(config.port, 0);
  assert.equal(config.model, 'test-model');
  assert.equal(endpoint(config.host, 43123), 'http://[::1]:43123');
  const output = environmentSetup(config, 43123);
  assert.match(output, /http:\/\/\[::1\]:43123\/v1/);
  assert.doesNotMatch(output, /private-test-value/);
  assert.match(output, /<your-local-api-key>/);
});

test('configuration rejects remote binds, invalid limits and project credentials', () => {
  for (const args of [
    ['--host', '0.0.0.0'],
    ['--host', '192.168.1.1'],
    ['--port', '65536'],
    ['--port', '-1'],
    ['--timeout-ms', 'NaN'],
    ['--max-body-bytes', '0'],
    ['--max-body-bytes', '512000001'],
    ['--auth-file', 'auth.json'],
    ['--shell', 'fish'],
    ['--api-key', 'two words'],
    ['env', '--port', '0'],
    ['--unknown'],
    ['--port'],
  ]) {
    assert.throws(() => parseArgs(args, env, cwd), undefined, args.join(' '));
  }
});

test('help works even with invalid environment configuration', () => {
  assert.deepEqual(parseArgs(['--help'], { COPILOT_PROXY_HOST: '0.0.0.0' }, cwd), { command: 'help' });
});
