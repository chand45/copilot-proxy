import { ProxyError } from './errors.js';

function authFailure(error, operation, signal) {
  const action = operation === 'login' ? 'GitHub Copilot login' : 'Copilot token refresh';
  const retry = operation === 'login'
    ? 'Retry copilot-proxy login --accept-model-policy-changes.'
    : 'Retry the request; signing in again is not required for this error.';
  const login = 'Run copilot-proxy login --accept-model-policy-changes.';
  const failure = (status, message, type = 'server_error') =>
    new ProxyError(status, `${operation}_failed`, `${action} failed. ${message}`, type);
  const message = typeof error?.message === 'string' ? error.message : '';

  if (signal?.reason?.name === 'TimeoutError' || error?.name === 'TimeoutError') {
    return failure(504, `The authentication request timed out. ${retry}`);
  }
  if (signal?.aborted || error?.name === 'AbortError' || message === 'Login cancelled') {
    return failure(401, `Authentication was cancelled. ${login}`, 'authentication_error');
  }
  if (message.startsWith('Device flow timed out')) {
    const clock = message.includes('slow_down') ? ' Check the system clock if this keeps happening.' : '';
    return failure(401, `The device login code expired before authorization completed.${clock} ${login}`, 'authentication_error');
  }
  if (/^Device flow failed: expired_token(?::|$)/.test(message)) {
    return failure(401, `The device login code expired. ${login}`, 'authentication_error');
  }
  if (/^Device flow failed: access_denied(?::|$)/.test(message)) {
    return failure(403, `Device authorization was denied. Approve the device login in your browser only if you intended to sign in. ${login}`, 'authentication_error');
  }
  // Pi includes raw response bodies in HTTP errors. Extract only the status, never the body.
  const status = Number(message.match(/^([45]\d{2})\b/)?.[1]);
  if (status === 401) {
    return failure(401, `GitHub/Copilot rejected authentication (HTTP 401). ${login}`, 'authentication_error');
  }
  if (status === 403) {
    return failure(403, 'GitHub/Copilot denied access (HTTP 403). Check Copilot subscription access and organization policies.', 'authentication_error');
  }
  if (status === 429) {
    return failure(429, `GitHub/Copilot rate-limited authentication (HTTP 429). Wait before retrying. ${retry}`, 'rate_limit_error');
  }
  if (status >= 500) {
    return failure(status, `GitHub/Copilot returned HTTP ${status}. ${retry}`);
  }
  if (status) {
    return failure(502, `GitHub/Copilot returned HTTP ${status} during authentication. Check proxy/provider compatibility before retrying.`);
  }
  if (message === 'fetch failed') {
    return failure(502, `Could not reach GitHub/Copilot. Check network, proxy, and TLS certificate settings. ${retry}`);
  }
  return failure(502, 'The authentication provider failed without a recognized error. Retry; if it persists, check network connectivity, Copilot access, and proxy/provider compatibility.');
}

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
        const signal = AbortSignal.timeout(60000);
        try {
          refreshed = await provider.refresh(current, signal);
        } catch (error) {
          throw authFailure(error, 'refresh', signal);
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
      } catch (error) {
        throw authFailure(error, 'login', callbacks.signal);
      }
      await store.save(value);
    },
  };
}
