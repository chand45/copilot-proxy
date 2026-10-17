import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { zstdCompressSync } from 'node:zlib';
import { createAdapter } from './adapter.mjs';

const TOKEN = 'test-codex-access-token', KEY = 'test-proxy-key';
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function fixture(t, handler, options = {}) {
  const seen = [], logs = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(req, res, seen.at(-1));
  });
  const upstreamPort = await listen(upstream);
  const adapter = createAdapter({ upstream: `http://127.0.0.1:${upstreamPort}`, proxyKey: KEY, credentials: async () => TOKEN, log: e => logs.push(e), ...options });
  const port = await listen(adapter);
  t.after(() => { adapter.closeAllConnections(); adapter.close(); upstream.closeAllConnections(); upstream.close(); });
  const request = (path = '/v1/responses', overrides = {}) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'chatgpt-account-id': 'must-not-forward', 'x-secret-test': 'must-not-forward' }, body: JSON.stringify({ model: 'gpt-6-astra', input: 'SECRET_PROMPT', stream: true }), ...overrides });
  return { request, port, seen, logs };
}
const sse = (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'); };
test('zstd request is decoded; only the proxy credential and allowlisted headers leave the adapter', async t => {
  const f = await fixture(t, sse);
  const payload = JSON.stringify({ model: 'gpt-6-astra', input: 'SECRET_PROMPT', stream: true });
  const response = await f.request(undefined, { headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-encoding': 'zstd', 'chatgpt-account-id': 'account', 'x-secret-test': 'secret' }, body: zstdCompressSync(payload) });
  assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
  assert.equal(f.seen[0].body, payload); assert.equal(f.seen[0].headers.authorization, `Bearer ${KEY}`);
  for (const h of ['chatgpt-account-id', 'x-secret-test', 'content-encoding']) assert.equal(f.seen[0].headers[h], undefined);
  assert.doesNotMatch(JSON.stringify(f.logs), /SECRET_PROMPT|test-codex-access-token|test-proxy-key/);
});
test('missing token, wrong token, hostile Host, browser Origin, unknown routes and methods are rejected', async t => {
  const f = await fixture(t, sse);
  for (const [headers, status] of [[{},401], [{ authorization:'Bearer invalid' },401], [{ authorization:`Bearer ${TOKEN}`, origin:'http://localhost' },403]]) {
    const r = await f.request(undefined, { headers }); assert.equal(r.status,status); await r.text();
  }
  const hostileStatus = await new Promise((resolve,reject) => {
    const req=http.request({host:'127.0.0.1',port:f.port,path:'/v1/models',headers:{host:'evil.test',authorization:`Bearer ${TOKEN}`}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(hostileStatus,403);
  let r = await f.request('/v1/other'); assert.equal(r.status,404); await r.text();
  r = await f.request('/v1/responses', { method:'GET', body:undefined }); assert.equal(r.status,405); await r.text();
  assert.equal(f.seen.length,0);
});
test('auth is reloaded for each request, allowing rotation and revoking the old token', async t => {
  let token = TOKEN;
  const f = await fixture(t, sse, { credentials:async () => token });
  let r = await f.request(); assert.equal(r.status,200); await r.text(); token = 'rotated-token';
  r = await f.request(); assert.equal(r.status,401); await r.text();
  r = await f.request(undefined, { headers:{authorization:'Bearer rotated-token','content-type':'application/json'} });
  assert.equal(r.status,200); await r.text(); assert.equal(f.seen.length,2);
});
async function upgrade(port, token) {
  const socket = net.connect(port, '127.0.0.1'); let result = ''; socket.setEncoding('utf8');
  socket.on('data', chunk => result += chunk); await once(socket,'connect');
  socket.write(`GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${token}\r\n\r\n`);
  await once(socket,'end'); socket.destroy(); return result;
}
test('only authenticated WebSocket upgrades receive the Codex HTTP-fallback status', async t => {
  const f = await fixture(t,sse);
  assert.match(await upgrade(f.port,TOKEN),/^HTTP\/1.1 426 /);
  assert.match(await upgrade(f.port,'invalid'),/^HTTP\/1.1 401 /); assert.equal(f.seen.length,0);
});
test('raw and expanded body limits, invalid compression and invalid JSON fail before forwarding', async t => {
  const f = await fixture(t,sse,{maxBodyBytes:200});
  const cases = [
    ['x'.repeat(201),'identity',413],
    [zstdCompressSync(JSON.stringify({input:'a'.repeat(5000)})),'zstd',413],
    ['invalid-zstd','zstd',400], ['bad-json','identity',400], ['[]','identity',400], ['{}','br',415]
  ];
  for (const [body,encoding,status] of cases) {
    const r = await f.request(undefined,{body,headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json','content-encoding':encoding}});
    assert.equal(r.status,status); await r.text();
  }
  assert.equal(f.seen.length,0);
});
test('upstream redirects cannot leak credentials and proxy failures preserve status', async t => {
  const f = await fixture(t,(req,res) => { res.writeHead(302,{location:'https://example.invalid'});res.end(); });
  let r = await f.request(); assert.equal(r.status,502); assert.match(await r.text(),/upstream_redirect_denied/);
  const g = await fixture(t,(req,res) => { res.writeHead(429,{'content-type':'application/json','retry-after':'2'});res.end('{"error":{"message":"rate limited"}}'); });
  r = await g.request(); assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'2');await r.text();
});
test('model catalog uses the Codex envelope without inventing instructions', async t => {
  const f = await fixture(t,(req,res) => {res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[{"id":"gpt-6-astra"}]}');});
  const r = await f.request('/v1/models?client_version=0.163.0',{method:'GET',body:undefined});
  assert.deepEqual(await r.json(),{models:[]});assert.equal(f.seen[0].url,'/v1/models');
});
test('SSE is delivered before completion and disconnect cancels upstream', async t => {
  let cancelled;const cancelledPromise=new Promise(resolve=>cancelled=resolve);
  const f = await fixture(t,(req,res) => {res.on('close',cancelled);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.created"}\n\n');});
  const controller=new AbortController();const r=await f.request(undefined,{signal:controller.signal});
  const reader=r.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/response.created/);
  controller.abort();await Promise.race([cancelledPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream was not cancelled')),1500))]);
});
test('timeouts bound stalled requests', async t => {
  const f = await fixture(t,()=>{},{timeoutMs:80});const r=await f.request();
  assert.equal(r.status,504);assert.match(await r.text(),/proxy_timeout/);
});
test('tool results, previous_response_id and multi-turn input survive unchanged', async t => {
  const f=await fixture(t,sse);
  for (const body of [
    {model:'gpt-6-astra',input:[{role:'user',content:'turn one'}],stream:true},
    {model:'gpt-6-astra',previous_response_id:'resp_one',input:[{type:'function_call_output',call_id:'call_one',output:'42'}],stream:true},
    {model:'gpt-6-astra',input:[{role:'user',content:'turn one'},{role:'assistant',content:'answer one'},{role:'user',content:'turn two'}],stream:true}
  ]) { const r=await f.request(undefined,{body:JSON.stringify(body)});await r.text();assert.deepEqual(JSON.parse(f.seen.at(-1).body),body); }
});
