import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { ProxyError } from './errors.js';

const execute = promisify(execFile);

async function restrictFile(path) {
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
    return;
  }
  const { stdout } = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!sid) throw new Error('Could not determine current Windows user.');
  // The new, empty file has inherited entries only. Remove them before writing secrets.
  await execute('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:F`], { windowsHide: true });
}

function validCredentials(credentials) {
  return credentials && typeof credentials === 'object' && !Array.isArray(credentials)
    && credentials.type === 'oauth'
    && typeof credentials.access === 'string' && credentials.access.length > 0
    && typeof credentials.refresh === 'string' && credentials.refresh.length > 0
    && Number.isFinite(credentials.expires);
}

export function createCredentialStore(path) {
  return {
    async load() {
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new ProxyError(401, 'login_required', 'No proxy login found. Run copilot-proxy login --accept-model-policy-changes.', 'authentication_error');
        }
        throw new ProxyError(500, 'credential_read_failed', 'Cannot read the proxy credential file. Check file permissions.', 'server_error');
      }
      if (!metadata.isFile() || metadata.size > 65536) {
        throw new ProxyError(500, 'invalid_credentials', 'The proxy credential file is invalid. Run copilot-proxy login --accept-model-policy-changes.', 'server_error');
      }
      if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
        throw new ProxyError(500, 'insecure_credentials', 'The proxy credential file must have mode 0600. Fix its permissions or log in again.', 'server_error');
      }
      let data;
      try {
        data = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        throw new ProxyError(500, 'invalid_credentials', 'The proxy credential file cannot be parsed. Run copilot-proxy login --accept-model-policy-changes.', 'server_error');
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.version !== 1 || data.provider !== 'github-copilot' || !validCredentials(data.credentials)) {
        throw new ProxyError(500, 'invalid_credentials', 'The proxy credential file has an unsupported format. Run copilot-proxy login --accept-model-policy-changes.', 'server_error');
      }
      return data.credentials;
    },
    async save(credentials) {
      if (!validCredentials(credentials)) throw new Error('OAuth provider returned invalid credentials.');
      const temporary = `${path}.${randomUUID()}.tmp`;
      let file;
      let created = false;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        file = await open(temporary, 'wx', 0o600);
        created = true;
        await restrictFile(temporary);
        await file.writeFile(JSON.stringify({ version: 1, provider: 'github-copilot', credentials }));
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, path);
        created = false;
      } catch {
        throw new ProxyError(500, 'credential_write_failed', 'Cannot privately save proxy credentials. Check the credential directory and file permissions.', 'server_error');
      } finally {
        await file?.close();
        if (created) await unlink(temporary);
      }
    },
  };
}
