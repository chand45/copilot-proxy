import { ProxyError } from './errors.js';

export function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyError(502, 'invalid_copilot_endpoint', 'Pi returned an invalid Copilot endpoint.', 'server_error');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.githubcopilot.com')
    || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') {
    throw new ProxyError(502, 'invalid_copilot_endpoint', 'Pi returned an unsupported Copilot endpoint.', 'server_error');
  }
  return url;
}

export function createCopilotUpstream({ auth, headersForRequest, fetchImpl = fetch }) {
  async function send(path, body, signal) {
    signal.throwIfAborted();
    const { apiKey, baseUrl } = await auth.getAuth(signal);
    const url = new URL(path, validateBaseUrl(baseUrl));
    if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) {
      throw new ProxyError(401, 'invalid_authentication', 'Pi returned invalid Copilot authentication. Run copilot-proxy login --accept-model-policy-changes.', 'authentication_error');
    }
    const headers = await headersForRequest(body);
    signal.throwIfAborted();
    return fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...headers,
        authorization: `Bearer ${apiKey}`,
        accept: body?.stream ? 'text/event-stream' : 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: 'manual',
    });
  }
  return {
    models: signal => send('/models', undefined, signal),
    chat: (body, signal) => send('/chat/completions', body, signal),
    responses: (body, signal) => send('/responses', body, signal),
  };
}
