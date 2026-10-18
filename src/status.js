import { get } from 'node:http';
import { endpoint } from './config.js';

function healthStatus(url, service) {
  return new Promise(resolve => {
    // A fresh socket avoids stale pooled connections after a service restarts.
    const request = get(`${url}/health`, { agent: false, signal: AbortSignal.timeout(2000) }, response => {
      if (response.statusCode !== 200) {
        resolve(`HTTP ${response.statusCode}`);
        response.destroy();
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          resolve(health?.service !== service ? 'Other service' : health.status === 'ok' ? 'Running' : 'Unhealthy');
        } catch { resolve('Unexpected response'); }
      });
      response.on('error', () => resolve('Unreachable'));
    });
    request.on('error', error => resolve(error.code === 'ECONNREFUSED' ? 'Stopped' : 'Unreachable'));
  });
}

export async function getStatus(config) {
  return Promise.all([
    ['Model serving', endpoint(config.host, config.port), 'copilot-proxy'],
    ['Codex Remote adapter', endpoint('127.0.0.1', config.adapterPort), 'codex-copilot-adapter'],
  ].map(async ([label, url, service]) => ({ label, url, state: await healthStatus(url, service) })));
}

export function formatStatus(rows) {
  return [
    `${'Service'.padEnd(22)} ${'Endpoint'.padEnd(28)} Status`,
    ...rows.map(row => `${row.label.padEnd(22)} ${row.url.padEnd(28)} ${row.state}`),
    'Local health only; login and model inference are not checked.',
  ].join('\n');
}
