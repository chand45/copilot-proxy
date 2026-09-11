import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// OpenAI documents up to 512 MB total image payload per request. Decimal MB
// also keeps ASCII JSON below Node's single-string ceiling (just under 512 MiB).
export const MAX_BODY_BYTES = 512_000_000;
export const DEFAULT_MAX_BODY_BYTES = MAX_BODY_BYTES;

const options = new Map([
  ['host', 'COPILOT_PROXY_HOST'],
  ['port', 'COPILOT_PROXY_PORT'],
  ['model', 'COPILOT_PROXY_MODEL'],
  ['api-key', 'COPILOT_PROXY_API_KEY'],
  ['auth-file', 'COPILOT_PROXY_AUTH_FILE'],
  ['max-body-bytes', 'COPILOT_PROXY_MAX_BODY_BYTES'],
  ['timeout-ms', 'COPILOT_PROXY_TIMEOUT_MS'],
  ['shell', null],
]);

function integer(name, value, min, max) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return result;
}

export function defaultAuthFile(env = process.env) {
  const root = process.platform === 'win32'
    ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(root, 'copilot-proxy', 'auth.json');
}

export function parseArgs(argv, env = process.env, cwd = process.cwd()) {
  const values = {};
  let command;
  let acceptModelPolicyChanges = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { command: 'help' };
    if (arg === '--version') return { command: 'version' };
    if (arg === '--accept-model-policy-changes') {
      acceptModelPolicyChanges = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      if (command) throw new Error(`Unexpected argument: ${arg}`);
      command = arg;
      continue;
    }
    const separator = arg.indexOf('=');
    const name = arg.slice(2, separator === -1 ? undefined : separator);
    if (!options.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = separator === -1 ? argv[++i] : arg.slice(separator + 1);
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value.`);
    values[name] = value;
  }
  command ??= 'start';
  if (!['start', 'login', 'env'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (acceptModelPolicyChanges && command !== 'login') throw new Error('--accept-model-policy-changes is only available for login.');
  const get = (name, fallback) => values[name] ?? env[options.get(name)] ?? fallback;
  const host = get('host', '127.0.0.1');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Only loopback hosts 127.0.0.1, ::1, and localhost are allowed.');
  }
  const apiKey = get('api-key', '');
  if (apiKey && /[\s\x00-\x1f\x7f]/.test(apiKey)) throw new Error('The local API key must not contain whitespace or control characters.');
  const model = get('model', '');
  if (model && (model.length > 200 || /[\x00-\x1f\x7f]/.test(model))) throw new Error('The default model is invalid.');
  const authOverride = get('auth-file');
  const authFile = resolve(cwd, authOverride ?? defaultAuthFile(env));
  const localPath = relative(resolve(cwd), authFile);
  // The OS default is safe when a globally installed CLI is run from the user's home.
  if (authOverride !== undefined && (!localPath || (localPath !== '..' && !localPath.startsWith(`..${sep}`) && !isAbsolute(localPath)))) {
    throw new Error('The credential file must be outside the project directory.');
  }
  const port = integer('Port', get('port', '4141'), 0, 65535);
  if (command === 'env' && port === 0) throw new Error('env requires the actual port; port 0 is only available when starting the server.');
  const shell = get('shell', 'both');
  if (!['both', 'bash', 'powershell'].includes(shell)) throw new Error('--shell must be bash, powershell, or both.');
  return {
    command,
    acceptModelPolicyChanges,
    host: host === 'localhost' ? '127.0.0.1' : host,
    port,
    model,
    apiKey,
    authFile,
    maxBodyBytes: integer('Maximum body bytes', get('max-body-bytes', DEFAULT_MAX_BODY_BYTES), 1, MAX_BODY_BYTES),
    timeoutMs: integer('Request timeout', get('timeout-ms', '300000'), 1, 3600000),
    shell,
  };
}

export function endpoint(host, port) {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function environmentSetup(config, port = config.port) {
  const url = `${endpoint(config.host, port)}/v1`;
  const key = config.apiKey ? '<your-local-api-key>' : 'copilot-proxy';
  const parts = [];
  if (config.apiKey) parts.push('# Replace <your-local-api-key> with the configured COPILOT_PROXY_API_KEY.');
  if (config.shell !== 'bash') {
    parts.push('# PowerShell', `$env:OPENAI_BASE_URL = '${url}'`, `$env:OPENAI_API_BASE = '${url}'`, `$env:OPENAI_API_KEY = '${key}'`);
  }
  if (config.shell !== 'powershell') {
    parts.push('# bash', `export OPENAI_BASE_URL='${url}'`, `export OPENAI_API_BASE='${url}'`, `export OPENAI_API_KEY='${key}'`);
  }
  return parts.join('\n');
}
