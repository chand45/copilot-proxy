import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createCredentialStore } from '../src/credentials.js';

const execute = promisify(execFile);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-proxy-store-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'auth.json');
  return { dir, path, store: createCredentialStore(path) };
}

test('credential store requires explicit login and never discovers another store', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.load(), { status: 401, code: 'login_required' });
});

test('credential writes are private, atomic, replaceable and round-trip provider metadata', async t => {
  const { dir, path, store } = await fixture(t);
  const first = { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: 12345, enterpriseUrl: 'github.com' };
  await store.save(first);
  assert.deepEqual(await store.load(), first);
  const second = { ...first, access: 'fake-new-access', expires: 23456 };
  await store.save(second);
  assert.deepEqual(await store.load(), second);
  assert.deepEqual(await readdir(dir), ['auth.json']);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('Windows credential writes ignore PATH-shadowed system utilities', { skip: process.platform !== 'win32' }, async t => {
  const { dir, path, store } = await fixture(t);
  const shadow = join(dir, 'shadow');
  await mkdir(shadow);
  const systemDirectory = join(process.env.SystemRoot || process.env.WINDIR, 'System32');
  // A real executable with incompatible arguments catches accidental PATH lookup.
  for (const name of ['whoami.exe', 'icacls.exe']) {
    await copyFile(join(systemDirectory, 'where.exe'), join(shadow, name));
  }
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${shadow};${env[pathKey] || ''}`;
  await assert.rejects(execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { env, windowsHide: true }));
  await assert.rejects(execute('icacls.exe', [path, '/inheritance:r'], { env, windowsHide: true }));
  const credentials = { type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: 12345 };
  const script = `
    import { createCredentialStore } from ${JSON.stringify(new URL('../src/credentials.js', import.meta.url).href)};
    await createCredentialStore(process.argv[1]).save(${JSON.stringify(credentials)});
  `;
  await execute(process.execPath, ['--input-type=module', '--eval', script, path], { env, windowsHide: true });
  assert.deepEqual(await store.load(), credentials);
  const { stdout } = await execute(join(systemDirectory, 'icacls.exe'), [path], { windowsHide: true });
  assert.doesNotMatch(stdout, /\(I\)/, 'Saved credentials must not inherit directory permissions.');
  assert.deepEqual((await readdir(dir)).sort(), ['auth.json', 'shadow']);
});

test('malformed or oversized credential stores fail explicitly', async t => {
  const { path, store } = await fixture(t);
  for (const value of ['{', '{}', 'null', '[]', '42', 'x'.repeat(65537), JSON.stringify({ version: 1, provider: 'unrelated', credentials: {} })]) {
    await writeFile(path, value, { mode: 0o600 });
    await assert.rejects(store.load(), { code: 'invalid_credentials' });
  }
});

test('Unix credential stores reject world-readable permissions', { skip: process.platform === 'win32' }, async t => {
  const { path, store } = await fixture(t);
  await store.save({ type: 'oauth', access: 'fake-access', refresh: 'fake-refresh', expires: 123 });
  await chmod(path, 0o644);
  await assert.rejects(store.load(), { code: 'insecure_credentials' });
});
