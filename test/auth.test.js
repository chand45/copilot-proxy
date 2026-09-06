import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAuthManager } from '../src/auth.js';
import { ProxyError } from '../src/errors.js';

function fixture(overrides = {}) {
  let stored = { type: 'oauth', access: 'fake-old', refresh: 'fake-refresh', expires: 0 };
  let refreshCount = 0;
  let saves = 0;
  const provider = {
    refresh: async value => {
      refreshCount++;
      await delay(20);
      return { ...value, access: 'fake-new', expires: Date.now() + 3600000 };
    },
    toAuth: value => ({ apiKey: value.access, baseUrl: 'https://api.individual.githubcopilot.com' }),
    login: async () => ({ type: 'oauth', access: 'fake-login', refresh: 'fake-refresh', expires: Date.now() + 3600000 }),
    ...overrides,
  };
  const store = {
    load: async () => stored,
    save: async value => { stored = value; saves++; },
  };
  return {
    manager: createAuthManager({ store, provider }),
    provider, store,
    refreshCount: () => refreshCount,
    saves: () => saves,
  };
}

test('expired tokens refresh once for concurrent requests and persist before use', async () => {
  const { manager, refreshCount, saves } = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => manager.getAuth()));
  assert.equal(refreshCount(), 1);
  assert.equal(saves(), 1);
  assert.ok(results.every(result => result.apiKey === 'fake-new'));
  await manager.getAuth();
  assert.equal(refreshCount(), 1);
});

test('explicit login saves only newly obtained credentials', async () => {
  const { manager, store, saves, refreshCount } = fixture();
  store.load = async () => { throw new Error('Must not load existing credentials during login'); };
  await manager.login({});
  assert.equal(saves(), 1);
  assert.equal(refreshCount(), 0);
});

test('refresh and login errors are redacted and refresh failures can retry', async () => {
  let count = 0;
  const { manager } = fixture({
    refresh: async () => { count++; throw new Error('private-upstream-message'); },
    login: async () => { throw new Error('private-upstream-message'); },
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(manager.getAuth(), error => error.code === 'refresh_failed' && !error.message.includes('private-upstream-message'));
  }
  assert.equal(count, 2);
  await assert.rejects(manager.login({}), { code: 'login_failed' });
});

test('one aborted waiter does not cancel shared token refresh', async () => {
  const { manager, refreshCount } = fixture();
  const controller = new AbortController();
  const cancelled = manager.getAuth(controller.signal);
  const continuing = manager.getAuth();
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await continuing).apiKey, 'fake-new');
  assert.equal(refreshCount(), 1);
});

test('persistence failures remain server errors rather than being hidden', async () => {
  const { manager, store } = fixture();
  store.save = async () => { throw new ProxyError(500, 'credential_write_failed', 'Cannot save'); };
  await assert.rejects(manager.getAuth(), { status: 500, code: 'credential_write_failed' });
});
