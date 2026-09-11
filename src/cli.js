#!/usr/bin/env node
import packageJson from '../package.json' with { type: 'json' };
import { DEFAULT_MAX_BODY_BYTES, parseArgs, endpoint, environmentSetup } from './config.js';
import { createProxyServer, listen } from './server.js';
import { createAuthManager } from './auth.js';
import { createCredentialStore } from './credentials.js';
import { createCopilotUpstream } from './upstream.js';
import { ProxyError } from './errors.js';

const help = `copilot-proxy ${packageJson.version}
Local OpenAI-compatible HTTP endpoint for GitHub Copilot.

Usage:
  copilot-proxy login --accept-model-policy-changes
  copilot-proxy start [options]
  copilot-proxy env [--shell powershell|bash|both]
  copilot-proxy --help

Commands:
  start    Start the loopback server. This is the default command.
  login    Explicit GitHub.com device login using Pi OAuth.
  env      Print client environment commands. Does not change your shell.

Options:
  --host HOST              127.0.0.1, localhost, or ::1. Default: 127.0.0.1
  --port PORT              Listen port, 0 chooses a free port. Default: 4141
  --model ID               Default model when a request omits model
  --api-key KEY            Optional local bearer key; prefer the environment
  --auth-file PATH         Private proxy credentials, outside this project
  --max-body-bytes BYTES   Request body limit. Default/max: ${DEFAULT_MAX_BODY_BYTES} (512 MB)
  --timeout-ms MS          Total request deadline. Default: 300000
  --shell SHELL            env/start output: powershell, bash, or both
  --accept-model-policy-changes
                          Required for login: Pi may enable unconfigured
                          known Copilot models, never explicitly disabled ones.
  -h, --help               Show this help without loading credentials
  --version                Print the version

Environment:
  COPILOT_PROXY_HOST, COPILOT_PROXY_PORT, COPILOT_PROXY_MODEL,
  COPILOT_PROXY_API_KEY, COPILOT_PROXY_AUTH_FILE,
  COPILOT_PROXY_MAX_BODY_BYTES, COPILOT_PROXY_TIMEOUT_MS
  CLI options override environment values.

Routes:
  GET /health              Liveness only, does not verify login
  GET /v1/models           Authenticated Copilot model catalog
  POST /v1/chat/completions   JSON or OpenAI SSE
  POST /v1/responses          JSON or Responses SSE, supported models only

Credentials default to %LOCALAPPDATA%\\copilot-proxy\\auth.json on Windows
or $XDG_CONFIG_HOME/copilot-proxy/auth.json (~/.config when unset) elsewhere.
No Pi or GitHub CLI credentials are discovered or imported.`;

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (config.command === 'help') return console.log(help);
  if (config.command === 'version') return console.log(packageJson.version);
  if (config.command === 'env') return console.log(environmentSetup(config));
  if (config.command === 'login' && !config.acceptModelPolicyChanges) {
    console.error('Pi login may enable currently unconfigured known Copilot models, but never explicitly disabled models.');
    console.error('To acknowledge this and start device login, run: copilot-proxy login --accept-model-policy-changes');
    process.exitCode = 1;
    return;
  }
  const { createPiIntegration } = await import('./pi.js');
  const integration = await createPiIntegration();
  const auth = createAuthManager({
    store: createCredentialStore(config.authFile),
    provider: integration.oauth,
  });
  if (config.command === 'login') {
    console.log('Pi may enable unconfigured known Copilot models during login. Explicitly disabled models stay disabled.');
    console.log('Only GitHub.com accounts are supported. No existing credentials will be imported.');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      await auth.login({
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]),
        prompt: async () => '',
        notify: event => {
          if (event.type === 'device_code') {
            console.log(`Open ${event.verificationUri}`);
            console.log(`Enter device code: ${event.userCode}`);
          }
        },
      });
      console.log('Login saved to the private proxy credential store.');
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
    return;
  }
  const upstream = createCopilotUpstream({ auth, headersForRequest: integration.headersForRequest });
  const server = createProxyServer(config, { upstream });
  const port = await listen(server, config);
  console.log(`Copilot proxy listening at ${endpoint(config.host, port)}`);
  console.log(`Request body limit: ${config.maxBodyBytes} bytes (override with --max-body-bytes).`);
  console.log('Login is checked on API requests. /health reports liveness only.');
  console.log(config.apiKey ? 'API routes require your local bearer key.' : 'No local bearer key configured. Only loopback clients can connect.');
  console.log(environmentSetup(config, port));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.shutdown();
    } catch {
      console.error('Could not shut down the local HTTP server cleanly.');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {
  if (error instanceof ProxyError) {
    console.error(`${error.code}: ${error.message}`);
  } else if (error.code === 'EADDRINUSE') {
    console.error('The configured port is already in use. Stop its owner or choose a different --port.');
  } else if (error.code === 'EACCES') {
    console.error('Permission denied while binding the local server. Choose another --port.');
  } else if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('A required package is missing. Reinstall copilot-proxy from the same package source, then retry.');
  } else {
    console.error('Copilot proxy could not start. Check the Node version, installation, and configuration.');
  }
  process.exitCode = 1;
});
