import { ProxyError, errorBody } from './errors.js';
import { stabilizeResponseIds } from './response-ids.js';

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

function anthropicHeaders(headers = {}) {
  const result = { 'anthropic-version': '2023-06-01' };
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (['anthropic-version', 'anthropic-beta'].includes(key) && typeof value === 'string' && value.trim()) {
      result[key] = value;
    }
  }
  return result;
}

async function messagesError(response, apiKey) {
  const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
  let body = errorBody(new ProxyError(
    status, 'copilot_upstream_error',
    `Copilot returned HTTP ${response.status}. Check subscription access, model support, request parameters, or rate limits.`,
  ), true);
  if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    try {
      const candidate = await response.json();
      if (candidate?.type === 'error' && typeof candidate.error?.type === 'string' && typeof candidate.error.message === 'string') {
        body = { type: 'error', error: {
          type: candidate.error.type.replaceAll(apiKey, '[redacted]'),
          message: candidate.error.message.replaceAll(apiKey, '[redacted]'),
        } };
      }
    } catch {
      // Malformed upstream errors must not expose raw bodies or tokens.
    }
  } else {
    await response.body?.cancel();
  }
  const headers = new Headers();
  for (const name of ['retry-after', 'request-id', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return Response.json(body, { status, headers });
}

export function createCopilotUpstream({ auth, headersForRequest, fetchImpl = fetch }) {
  async function send(path, body, signal, extraHeaders = {}) {
    signal.throwIfAborted();
    const { apiKey, baseUrl } = await auth.getAuth(signal);
    const url = new URL(path, validateBaseUrl(baseUrl));
    if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) {
      throw new ProxyError(401, 'invalid_authentication', 'Pi returned invalid Copilot authentication. Run copilot-proxy login --accept-model-policy-changes.', 'authentication_error');
    }
    const headers = await headersForRequest(body);
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...headers,
        ...extraHeaders,
        authorization: `Bearer ${apiKey}`,
        accept: body?.stream ? 'text/event-stream' : 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: 'manual',
    });
    return extraHeaders['anthropic-version'] && !response.ok ? messagesError(response, apiKey) : response;
  }
  return {
    models: signal => send('/models', undefined, signal),
    chat: (body, signal) => send('/chat/completions', body, signal),
    responses: async (body, signal) => stabilizeResponseIds(await send('/responses', body, signal)),
    messages: (body, signal, { headers, beta = false } = {}) => send(
      `/v1/messages${beta === true ? '?beta=true' : ''}`, body, signal, anthropicHeaders(headers),
    ),
  };
}
