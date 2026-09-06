import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ProxyError, errorBody } from './errors.js';

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function checkRequest(req, config, port) {
  if (req.headers.origin) throw new ProxyError(403, 'origin_not_allowed', 'Browser-origin requests are not supported.');
  const host = req.headers.host?.toLowerCase();
  if (![`${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`, `localhost:${port}`].includes(host)) {
    throw new ProxyError(403, 'invalid_host', 'Host must match this local endpoint.');
  }
}

function authorize(req, apiKey) {
  if (!apiKey) return;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${apiKey}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ProxyError(401, 'invalid_api_key', 'A valid local bearer API key is required.', 'authentication_error');
  }
}

async function readJson(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ProxyError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new ProxyError(415, 'unsupported_content_encoding', 'Compressed request bodies are not supported.');
  }
  if (Number(req.headers['content-length']) > limit) {
    throw new ProxyError(413, 'body_too_large', `Request body exceeds ${limit} bytes.`);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new ProxyError(413, 'body_too_large', `Request body exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProxyError(400, 'invalid_json', 'Request body must contain valid JSON.');
  }
}

function chatBody(body, defaultModel) {
  const result = modelBody(body, defaultModel);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ProxyError(400, 'invalid_messages', 'messages must be a non-empty array.');
  }
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.role !== 'string') {
      throw new ProxyError(400, 'invalid_messages', 'Each message must be an object with a role.');
    }
  }
  return result;
}

function responsesBody(body, defaultModel) {
  const result = modelBody(body, defaultModel);
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw new ProxyError(400, 'invalid_input', 'Responses input must be a string or an array.');
  }
  if (body.input === undefined && typeof body.previous_response_id !== 'string') {
    throw new ProxyError(400, 'input_required', 'Supply input or previous_response_id.');
  }
  return result;
}

function modelBody(body, defaultModel) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProxyError(400, 'invalid_body', 'Request body must be a JSON object.');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new ProxyError(400, 'invalid_stream', 'stream must be a boolean.');
  }
  const model = body.model ?? defaultModel;
  if (typeof model !== 'string' || !model.trim()) {
    throw new ProxyError(400, 'model_required', 'Supply model in the request or configure COPILOT_PROXY_MODEL.');
  }
  return { ...body, model };
}

function forwardedHeaders(response) {
  const headers = {};
  for (const name of ['retry-after', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function modelCatalog(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    throw new ProxyError(502, 'invalid_model_catalog', 'Copilot did not return a JSON model catalog.', 'server_error');
  }
  let catalog;
  try {
    catalog = await response.json();
  } catch {
    throw new ProxyError(502, 'invalid_model_catalog', 'Copilot returned an invalid model catalog.', 'server_error');
  }
  if (!catalog || !Array.isArray(catalog.data)
    || catalog.data.some(model => !model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id)) {
    throw new ProxyError(502, 'invalid_model_catalog', 'Copilot returned an invalid model catalog.', 'server_error');
  }
  return {
    ...catalog,
    object: 'list',
    data: catalog.data.map(model => ({
      ...model,
      object: 'model',
      created: Number.isInteger(model.created) && model.created >= 0 ? model.created : 0,
      owned_by: typeof model.owned_by === 'string' && model.owned_by
        ? model.owned_by
        : typeof model.vendor === 'string' && model.vendor ? model.vendor : 'github-copilot',
    })),
  };
}

async function relay(response, res, signal, streaming) {
  const contentType = response.headers.get('content-type') || '';
  if (streaming && !contentType.toLowerCase().includes('text/event-stream')) {
    await response.body?.cancel();
    throw new ProxyError(502, 'invalid_upstream_response', 'Copilot did not return an SSE stream.', 'server_error');
  }
  if (!streaming && !contentType.toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    throw new ProxyError(502, 'invalid_upstream_response', 'Copilot did not return JSON.', 'server_error');
  }
  if (!response.body) throw new ProxyError(502, 'empty_upstream_response', 'Copilot returned an empty response.', 'server_error');
  res.setHeader('content-type', streaming ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
  res.writeHead(response.status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(streaming ? { 'x-accel-buffering': 'no' } : {}),
    ...forwardedHeaders(response),
  });
  res.flushHeaders();
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    if (!res.write(chunk)) await once(res, 'drain', { signal });
  }
  res.end();
}

export function createProxyServer(config, { upstream, log = console.error }) {
  const active = new Set();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    active.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!req.complete) req.destroy();
    }, config.timeoutMs);
    timeout.unref();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', disconnect);
    res.once('close', disconnect);
    try {
      checkRequest(req, config, server.address().port);
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/health') {
        if (req.method !== 'GET') throw new ProxyError(405, 'method_not_allowed', 'Use GET for /health.');
        sendJson(res, 200, { status: 'ok', service: 'copilot-proxy' });
        return;
      }
      authorize(req, config.apiKey);
      let response;
      let streaming = false;
      if (path === '/v1/models') {
        if (req.method !== 'GET') throw new ProxyError(405, 'method_not_allowed', 'Use GET for /v1/models.');
        response = await upstream.models(controller.signal);
      } else if (path === '/v1/chat/completions') {
        if (req.method !== 'POST') throw new ProxyError(405, 'method_not_allowed', 'Use POST for /v1/chat/completions.');
        const body = chatBody(await readJson(req, config.maxBodyBytes), config.model);
        streaming = body.stream === true;
        response = await upstream.chat(body, controller.signal);
      } else if (path === '/v1/responses') {
        if (req.method !== 'POST') throw new ProxyError(405, 'method_not_allowed', 'Use POST for /v1/responses.');
        const body = responsesBody(await readJson(req, config.maxBodyBytes), config.model);
        streaming = body.stream === true;
        response = await upstream.responses(body, controller.signal);
      } else {
        throw new ProxyError(404, 'not_found', 'Supported routes: GET /health, GET /v1/models, POST /v1/chat/completions, POST /v1/responses.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
        sendJson(res, status, errorBody(new ProxyError(
          status,
          'copilot_upstream_error',
          `Copilot returned HTTP ${response.status}. Check subscription access, model support, request parameters, or rate limits.`,
          status === 401 || status === 403 ? 'authentication_error' : 'api_error',
        )), forwardedHeaders(response));
        return;
      }
      if (path === '/v1/models') {
        sendJson(res, response.status, await modelCatalog(response), forwardedHeaders(response));
        return;
      }
      await relay(response, res, controller.signal, streaming);
    } catch (error) {
      if (controller.signal.aborted && !timedOut) return;
      const safeError = timedOut
        ? new ProxyError(504, 'upstream_timeout', 'The request exceeded the configured timeout.', 'server_error')
        : error instanceof ProxyError
          ? error
          : new ProxyError(502, 'upstream_unavailable', 'Unable to complete the Copilot request.', 'server_error');
      // Do not log upstream exceptions: OAuth and fetch errors can contain tokens.
      if (safeError.status >= 500) log(`Request failed: ${safeError.code}`);
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
          if (res.getHeader('content-type')?.startsWith('text/event-stream')) {
            res.end(`\n\ndata: ${JSON.stringify(errorBody(safeError))}\n\n`);
          } else {
            res.destroy();
          }
        }
      } else {
        sendJson(res, safeError.status, errorBody(safeError), safeError.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
      }
    } finally {
      clearTimeout(timeout);
      active.delete(controller);
      req.off('aborted', disconnect);
      res.off('close', disconnect);
      if (!req.complete) {
        res.once('finish', () => req.destroy());
        req.resume();
      }
    }
  });
  server.requestTimeout = config.timeoutMs;
  server.headersTimeout = Math.min(config.timeoutMs, 60000);
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.shutdown = async () => {
    for (const controller of active) controller.abort();
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  };
  return server;
}

export async function listen(server, config) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}
