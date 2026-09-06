import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialStore } from '../src/credentials.js';

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
