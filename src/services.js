import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAdapter, codexCredentials } from '../codex-copilot-adapter/adapter.mjs';
import { endpoint } from './config.js';
import { ProxyError } from './errors.js';
import { createProxyServer, listen } from './server.js';

export async function startServices(config, { upstream, env = process.env, log = console.error }) {
  const servers = [];
  let closing;
  const shutdown = () => closing ??= Promise.all(servers.map(server => server.shutdown()));
  const proxy = createProxyServer(config, { upstream, log });
  const port = await listen(proxy, config);
  servers.push(proxy);
  try {
    let adapterPort;
    if (config.adapterEnabled) {
      const authPath = join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
      const adapter = createAdapter({
        upstream: endpoint(config.host, port),
        proxyKey: config.apiKey || 'copilot-proxy',
        credentials: () => codexCredentials(authPath),
        maxBodyBytes: config.maxBodyBytes,
        timeoutMs: config.timeoutMs,
        log: entry => log(JSON.stringify(entry)),
      });
      try {
        adapterPort = await listen(adapter, { host: '127.0.0.1', port: config.adapterPort });
      } catch (error) {
        const reason = error.code === 'EADDRINUSE' ? 'Port is already in use.' : 'Could not bind the port.';
        throw new ProxyError(503, 'adapter_start_failed',
          `Codex Remote adapter on 127.0.0.1:${config.adapterPort}: ${reason} Stop its owner, choose --adapter-port, or use --no-adapter.`);
      }
      servers.push(adapter);
    }
    return { port, adapterPort, shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
