import http from 'node:http';
import { readFile, appendFile, stat, rename } from 'node:fs/promises';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { zstdDecompress, gunzip } from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const decompress = { zstd: promisify(zstdDecompress), gzip: promisify(gunzip) };
const DEFAULT_LIMIT = 64 * 1024 * 1024;
class Failure extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function codexCredentials(authPath) {
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) throw new Failure(503, 'codex_login_unavailable');
  return auth.tokens.access_token;
}
function send(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close' });
  res.end(JSON.stringify(data));
}
function checkLocal(req, port) {
  if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw new Failure(403, 'loopback_required');
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host?.toLowerCase())) throw new Failure(403, 'invalid_host');
  if ('origin' in req.headers) throw new Failure(403, 'browser_origin_denied');
  if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Failure(400, 'invalid_target');
}
async function authorize(req, credentials) {
  let token;
  try { token = await credentials(); } catch { throw new Failure(503, 'codex_login_unavailable'); }
  if (!equal(req.headers.authorization, `Bearer ${token}`)) throw new Failure(401, 'invalid_codex_token');
}
async function bodyBytes(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new Failure(415, 'json_required');
  const encoding = (req.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity' && !decompress[encoding]) throw new Failure(415, 'unsupported_encoding');
  if (Number(req.headers['content-length']) > limit) throw new Failure(413, 'body_too_large');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new Failure(413, 'body_too_large');
    chunks.push(chunk);
  }
  let data = Buffer.concat(chunks);
  if (encoding !== 'identity') {
    try { data = await decompress[encoding](data, { maxOutputLength: limit }); }
    catch (e) { throw new Failure(e.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, e.code === 'ERR_BUFFER_TOO_LARGE' ? 'body_too_large' : 'invalid_compression'); }
  }
  let body;
  try { body = JSON.parse(data.toString('utf8')); } catch { throw new Failure(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Failure(400, 'invalid_body');
  return { data, body };
}

// No third-party packages. All upstream destinations are fixed loopback URLs.
export function createAdapter({ upstream = 'http://127.0.0.1:4141', proxyKey,
  credentials = () => codexCredentials(join(homedir(), '.codex', 'auth.json')),
  maxBodyBytes = DEFAULT_LIMIT, timeoutMs = 300000, maxConcurrent = 8,
  log = () => {} } = {}) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Upstream must be a fixed HTTP loopback endpoint.');
  if (!proxyKey || /[\r\n]/.test(proxyKey)) throw new Error('COPILOT_PROXY_KEY is required.');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 512000000) throw new Error('Invalid body limit.');
  const active = new Set();
  const sockets = new Set();
  const counters = { forwarded: 0, completed: 0, failed: 0, websocketFallbacks: 0 };
  const record = (event, fields = {}) => log({ time: new Date().toISOString(), event, ...fields });
  const server = http.createServer(async (req, res) => {
    const id = randomUUID();
    let controller, timer, response, timedOut = false, path;
    try {
      checkLocal(req, server.address().port);
      path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/health' && req.method === 'GET') {
        send(res, 200, { service: 'codex-copilot-adapter', version: 1, status: 'ok', pid: process.pid, upstream: target.origin, ...counters }); return;
      }
      await authorize(req, credentials);
      if (req.destroyed || res.destroyed) return;
      if (!['/v1/responses', '/v1/models'].includes(path)) throw new Failure(404, 'route_not_supported');
      if (req.method !== (path === '/v1/models' ? 'GET' : 'POST')) throw new Failure(405, 'method_not_allowed');
      if (active.size >= maxConcurrent) throw new Failure(503, 'adapter_busy');
      controller = new AbortController(); active.add(controller);
      timer = setTimeout(() => { timedOut = true; controller.abort(); if (!req.complete) req.destroy(); }, timeoutMs);
      timer.unref();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      req.once('aborted', () => controller.abort());
      const payload = path === '/v1/responses' ? await bodyBytes(req, maxBodyBytes) : undefined;
      controller.signal.throwIfAborted();
      const session = req.headers.session_id;
      const trace = typeof session === 'string' && /^[a-f0-9-]{36}$/i.test(session) ? { session } : {};
      record('forward', { id, path, ...trace, model: typeof payload?.body.model === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(payload.body.model) ? payload.body.model : undefined,
        encoding: req.headers['content-encoding'] || 'identity', bytes: payload?.data.length });
      counters.forwarded++;
      response = await fetch(new URL(path, target), { method: req.method, redirect: 'manual', signal: controller.signal,
        headers: { authorization: `Bearer ${proxyKey}`, accept: payload?.body.stream ? 'text/event-stream' : 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload?.data });
      if (response.status >= 300 && response.status < 400) throw new Failure(502, 'upstream_redirect_denied');
      if (path === '/v1/models' && response.ok) {
        // Copilot's OpenAI model list is not a Codex ModelInfo catalog. An empty
        // override preserves Codex's built-in definitions (validated with model/list).
        // Check the upstream catalog is healthy without inventing model instructions.
        const catalog = await response.json();
        if (!Array.isArray(catalog.data)) throw new Failure(502, 'invalid_proxy_catalog');
        send(res, 200, { models: [] });
        record('catalog', { id, proxyModels: catalog.data.length }); return;
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/application\/json|text\/event-stream/i.test(contentType)) throw new Failure(502, 'invalid_proxy_content_type');
      const headers = { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' };
      for (const h of ['retry-after', 'request-id', 'x-request-id']) { if (response.headers.has(h)) headers[h] = response.headers.get(h); }
      res.writeHead(response.status, headers); res.flushHeaders();
      let tail = '', droppingLine = false, completed = false, failed = false;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        controller.signal.throwIfAborted();
        // Parse SSE field lines, never substrings inside generated text. Bound
        // the diagnostic parser independently of the byte-for-byte relay.
        tail += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = tail.indexOf('\n')) !== -1) {
          const line = tail.slice(0, newline).replace(/\r$/, ''); tail = tail.slice(newline + 1);
          if (droppingLine) { droppingLine = false; continue; }
          let type;
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:') && line.length <= 262144) {
            try { type = JSON.parse(line.slice(5)).type; } catch { /* SSE keepalive or malformed event */ }
          }
          completed ||= type === 'response.completed'; failed ||= type === 'response.failed';
        }
        if (tail.length > 262144) { tail = ''; droppingLine = true; }
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
      if (completed) counters.completed++;
      if (failed || !response.ok) counters.failed++;
      record('end', { id, status: response.status, completed, failed });
    } catch (e) {
      const status = e instanceof Failure ? e.status : timedOut ? 504 : controller?.signal.aborted ? 499 : 502;
      const code = e instanceof Failure ? e.code : timedOut ? 'proxy_timeout' : controller?.signal.aborted ? 'client_disconnected' : 'proxy_unavailable';
      counters.failed++;
      record('error', { id, status, code });
      if (!res.headersSent) send(res, status === 499 ? 502 : status, { error: { type: 'adapter_error', code, message: code } });
      else res.destroy();
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      controller?.abort(); active.delete(controller);
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', async (req, socket) => {
    // Node removes its HTTP socket error listener on upgrade. Own errors before
    // awaiting credentials: a client can reset the connection during that read.
    socket.on('error', () => socket.destroy());
    try {
      checkLocal(req, server.address().port); await authorize(req, credentials);
      if (socket.destroyed) return;
      if (req.method !== 'GET' || new URL(req.url, 'http://localhost').pathname !== '/v1/responses') throw new Failure(404, 'route_not_supported');
      counters.websocketFallbacks++;
      record('websocket_fallback');
      // 426 is Codex's tested signal to retry via HTTP/SSE. A 400 is fatal.
      socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    } catch (e) {
      if (socket.destroyed) return;
      const status = e instanceof Failure ? e.status : 503;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    }
  });
  server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 30000);
  server.keepAliveTimeout = 5000; server.maxConnections = 32;
  server.on('close', () => { for (const controller of active) controller.abort(); });
  server.shutdown = async () => {
    for (const controller of active) controller.abort();
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // closeAllConnections omits upgraded sockets, which are also ours to close.
    for (const socket of sockets) socket.destroy();
    await closed;
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const logPath = join(import.meta.dirname, 'adapter-events.jsonl');
  let queue = Promise.resolve();
  const log = entry => {
    queue = queue.then(async () => {
      if ((await stat(logPath).catch(() => ({ size: 0 }))).size > 5 * 1024 * 1024) await rename(logPath, `${logPath}.previous`).catch(() => {});
      await appendFile(logPath, JSON.stringify(entry) + '\n');
    }).catch(() => {});
  };
  try {
    await codexCredentials(join(homedir(), '.codex', 'auth.json'));
    const server = createAdapter({ proxyKey: process.env.COPILOT_PROXY_KEY, log });
    server.on('error', e => { log({ time: new Date().toISOString(), event: 'startup_error', code: e.code || 'startup_failed' }); process.exitCode = 1; });
    server.listen(4142, '127.0.0.1', () => log({ time: new Date().toISOString(), event: 'listening', port: 4142, pid: process.pid }));
  } catch { console.error('Adapter startup failed. Check local Codex sign-in and COPILOT_PROXY_KEY.'); process.exitCode = 1; }
}
