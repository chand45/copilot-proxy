import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAuthManager } from '../src/auth.js';
import { ProxyError } from '../src/errors.js';
import { createPiIntegration } from '../src/pi.js';

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
    await assert.rejects(manager.getAuth(), error => error.code === 'refresh_failed'
      && error.status === 502 && !error.message.includes('private-upstream-message'));
  }
  assert.equal(count, 2);
  await assert.rejects(manager.login({}), { code: 'login_failed', status: 502 });
});

test('authentication errors retain safe HTTP diagnostics without exposing provider response bodies', async t => {
  for (const [upstreamStatus, expectedStatus, type, guidance] of [
    [400, 502, 'server_error', /compatibility/],
    [401, 401, 'authentication_error', /Run copilot-proxy login/],
    [403, 403, 'authentication_error', /subscription access and organization policies/],
    [404, 502, 'server_error', /compatibility/],
    [429, 429, 'rate_limit_error', /Wait before retrying/],
    [500, 500, 'server_error', /Retry/],
    [502, 502, 'server_error', /Retry/],
    [503, 503, 'server_error', /Retry/],
    [504, 504, 'server_error', /Retry/],
  ]) {
    for (const operation of ['refresh', 'login']) {
      await t.test(`${operation}: HTTP ${upstreamStatus}`, async () => {
        const { manager, saves } = fixture({
          [operation]: async () => {
            throw new Error(`${upstreamStatus} Provider status: {"token":"private-upstream-token","message":"private-account-data"}`);
          },
        });
        const request = operation === 'refresh' ? manager.getAuth() : manager.login({});
        await assert.rejects(request, error => {
          assert.equal(error.status, expectedStatus);
          assert.equal(error.code, `${operation}_failed`);
          assert.equal(error.type, type);
          assert.match(error.message, new RegExp(`HTTP ${upstreamStatus}`));
          assert.match(error.message, guidance);
          assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-upstream-token|private-account-data|Provider status/);
          if (operation === 'refresh' && (upstreamStatus === 429 || upstreamStatus >= 500)) {
            assert.doesNotMatch(error.message, /copilot-proxy login/);
          }
          return true;
        });
        assert.equal(saves(), 0);
      });
    }
  }
});

test('network failures and timeouts are not authentication rejections', async t => {
  for (const operation of ['refresh', 'login']) {
    for (const [cause, status, guidance] of [
      [new TypeError('fetch failed', { cause: new Error('private-connection-data') }), 502, /network, proxy, and TLS/],
      [new DOMException('private-timeout-data', 'TimeoutError'), 504, /timed out/],
    ]) {
      await t.test(`${operation}: ${cause.name}`, async () => {
        const { manager, saves } = fixture({ [operation]: async () => { throw cause; } });
        await assert.rejects(operation === 'refresh' ? manager.getAuth() : manager.login({}), error => {
          assert.equal(error.status, status);
          assert.equal(error.type, 'server_error');
          assert.match(error.message, guidance);
          assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-/);
          if (operation === 'refresh') assert.doesNotMatch(error.message, /copilot-proxy login/);
          return true;
        });
        assert.equal(saves(), 0);
      });
    }
  }
});

test('device login explains expiry, denial, cancellation, and slow polling safely', async t => {
  for (const [message, status, guidance] of [
    ['Device flow failed: expired_token: private-device-data', 401, /code expired/],
    ['Device flow failed: access_denied: private-device-data', 403, /authorization was denied/],
    ['Device flow timed out', 401, /code expired/],
    ['Device flow timed out after one or more slow_down responses. private-device-data', 401, /system clock/],
    ['Login cancelled', 401, /cancelled/],
  ]) {
    await t.test(guidance.source, async () => {
      const { manager, saves } = fixture({ login: async () => { throw new Error(message); } });
      await assert.rejects(manager.login({}), error => {
        assert.equal(error.status, status);
        assert.equal(error.code, 'login_failed');
        assert.match(error.message, guidance);
        assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /private-device-data/);
        return true;
      });
      assert.equal(saves(), 0);
    });
  }
});

test('the login deadline is not misreported as cancellation when Pi masks the abort reason', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('private-timeout-data', 'TimeoutError'));
  const { manager } = fixture({ login: async () => { throw new Error('Login cancelled'); } });
  await assert.rejects(manager.login({ signal: controller.signal }), error => {
    assert.equal(error.status, 504);
    assert.match(error.message, /timed out/);
    assert.doesNotMatch(error.message, /cancelled|private-timeout-data/);
    return true;
  });
});

test('a successful retry after a transient refresh error still persists fresh credentials', async () => {
  const { manager, provider, saves } = fixture();
  const refresh = provider.refresh;
  provider.refresh = async () => { throw new Error('503 Service Unavailable: private-upstream-data'); };
  await assert.rejects(manager.getAuth(), { code: 'refresh_failed', status: 503 });
  assert.equal(saves(), 0);
  provider.refresh = refresh;
  assert.equal((await manager.getAuth()).apiKey, 'fake-new');
  assert.equal(saves(), 1);
});

test('pinned Pi refresh can fail at either token exchange or model discovery', async t => {
  const { oauth } = await createPiIntegration();
  for (const stage of ['token', 'models']) {
    await t.test(stage, async t => {
      const calls = [];
      t.mock.method(globalThis, 'fetch', async url => {
        calls.push(String(url));
        if (url === 'https://api.github.com/copilot_internal/v2/token') {
          return stage === 'token'
            ? new Response('private-upstream-body', { status: 401 })
            : Response.json({ token: 'fake-access', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        }
        assert.equal(url, 'https://api.individual.githubcopilot.com/models');
        return new Response('private-upstream-body', { status: 429 });
      });
      const { manager, saves } = fixture({ refresh: oauth.refresh });
      await assert.rejects(manager.getAuth(), error => {
        const status = stage === 'token' ? 401 : 429;
        assert.equal(error.status, status);
        assert.equal(error.code, 'refresh_failed');
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /private-upstream-body|fake-access/);
        return true;
      });
      assert.equal(calls.length, stage === 'token' ? 1 : 2);
      assert.equal(saves(), 0);
    });
  }
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
