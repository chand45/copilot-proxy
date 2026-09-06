import { ProxyError } from './errors.js';

async function withAbort(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createAuthManager({ store, provider, now = Date.now }) {
  let refreshPromise;

  async function credentials() {
    if (refreshPromise) return refreshPromise;
    const current = await store.load();
    if (current.expires > now() + 60000) return current;
    if (!refreshPromise) {
      refreshPromise = (async () => {
        let refreshed;
        try {
          refreshed = await provider.refresh(current, AbortSignal.timeout(60000));
        } catch {
          throw new ProxyError(401, 'refresh_failed', 'Copilot authentication could not be refreshed. Run copilot-proxy login --accept-model-policy-changes.', 'authentication_error');
        }
        await store.save(refreshed);
        return refreshed;
      })().finally(() => { refreshPromise = undefined; });
    }
    return refreshPromise;
  }

  return {
    async getAuth(signal) {
      signal?.throwIfAborted();
      return withAbort((async () => {
        const value = await credentials();
        try {
          return await provider.toAuth(value);
        } catch {
          throw new ProxyError(401, 'invalid_authentication', 'Copilot credentials could not be used. Run copilot-proxy login --accept-model-policy-changes.', 'authentication_error');
        }
      })(), signal);
    },
    async login(callbacks) {
      let value;
      try {
        value = await provider.login(callbacks);
      } catch {
        throw new ProxyError(401, 'login_failed', 'GitHub Copilot login failed or was cancelled. Retry copilot-proxy login --accept-model-policy-changes.', 'authentication_error');
      }
      await store.save(value);
    },
  };
}
