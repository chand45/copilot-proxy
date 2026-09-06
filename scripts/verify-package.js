import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run test:package.');
const temporary = await mkdtemp(join(tmpdir(), 'copilot-proxy-package-'));
let server;

async function npm(args) {
  return execute(process.execPath, [npmCli, ...args], {
    cwd: project, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
}

try {
  console.log('Packing copilot-proxy...');
  const report = JSON.parse((await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary])).stdout);
  // npm 12 returns a map keyed by package name; earlier versions return an array.
  const [packed] = Object.values(report);
  assert.equal(packed.name, 'copilot-proxy');
  for (const file of packed.files) {
    assert.match(file.path, /^(package\.json|README\.md|src\/[^/]+\.js)$/, `Unexpected package file: ${file.path}`);
  }
  const prefix = join(temporary, 'install');
  const cwd = join(temporary, 'consumer');
  await mkdir(cwd);
  console.log('Installing the tarball into a temporary global prefix...');
  await npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)]);
  const packageRoot = process.platform === 'win32'
    ? join(prefix, 'node_modules', 'copilot-proxy')
    : join(prefix, 'lib', 'node_modules', 'copilot-proxy');
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.bin['copilot-proxy'], 'src/cli.js');

  // Use npm's actual command shim on PATH, from outside the source checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^COPILOT_PROXY_|^PATH$/i.test(key)));
  env.PATH = [process.platform === 'win32' ? prefix : join(prefix, 'bin'), process.env.PATH || process.env.Path].join(delimiter);
  env.COPILOT_PROXY_AUTH_FILE = join(temporary, 'not-logged-in.json');
  function command(args) {
    // All arguments here are fixed test values. No shell quoting of user input.
    assert.ok(args.every(arg => /^[a-zA-Z0-9=-]+$/.test(arg)));
    return process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['copilot-proxy', ...args].join(' ')]]
      : ['copilot-proxy', args];
  }
  async function cli(args) {
    const [file, argv] = command(args);
    return execute(file, argv, { cwd, env, windowsHide: true, timeout: 15000 });
  }

  console.log('Checking installed help, version, env, login, and start commands...');
  assert.equal((await cli(['--version'])).stdout.trim(), packed.version);
  assert.match((await cli(['--help'])).stdout, /copilot-proxy start/);
  assert.match((await cli(['start', '--help'])).stdout, /copilot-proxy start/);
  assert.match((await cli(['login', '--help'])).stdout, /copilot-proxy login/);
  assert.match((await cli(['env', '--port', '43210', '--shell', 'bash'])).stdout, /127\.0\.0\.1:43210\/v1/);
  await assert.rejects(cli(['login']), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /copilot-proxy login --accept-model-policy-changes/);
    assert.doesNotMatch(error.stdout, /device code/i);
    return true;
  });

  const [file, argv] = command(['start', '--port', '0']);
  server = spawn(file, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  let spawnError;
  server.on('error', error => { spawnError = error; });
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { errors += data; });
  const deadline = Date.now() + 15000;
  let url;
  while (!url && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(server.exitCode, null, `Installed CLI exited: ${errors}`);
    url = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (!url) await delay(50);
  }
  assert.ok(url, `Installed CLI did not start: ${errors}`);
  assert.notEqual(new URL(url).port, '0');
  assert.equal((await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
  const models = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
  assert.equal(models.status, 401);
  const error = (await models.json()).error;
  assert.equal(error.code, 'login_required');
  assert.match(error.message, /copilot-proxy login/);
  console.log(`Package smoke test passed: ${packed.name}@${packed.version} (${packed.files.length} files).`);
} finally {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    if (process.platform === 'win32') {
      // npm's .cmd shim owns a child Node process; stop only this test's process tree.
      await execute('taskkill.exe', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true });
    } else {
      server.kill('SIGTERM');
    }
    await exited;
  }
  // This absolute directory was created by mkdtemp above and belongs to this check.
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(basename(temporary).startsWith('copilot-proxy-package-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
