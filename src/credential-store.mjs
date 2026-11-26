import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function command(executable, args, { input = '', timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(Error('凭据操作超时。'));
      else resolve({ code, stdout });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function windowsSeal(action, value) {
  if (process.platform !== 'win32') throw Error('DPAPI 仅在 Windows 上可用。');
  const operation = action === 'protect' ? 'Protect' : 'Unprotect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))`;
  const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: action === 'protect' ? Buffer.from(value, 'utf8').toString('base64') : value,
  });
  if (result.code !== 0) throw Error('Windows DPAPI 凭据保护操作失败。');
  return action === 'protect'
    ? result.stdout.trim()
    : Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
}

export function fileCredentialStore(root, seal = windowsSeal) {
  const filename = path.join(root, 'credential.dpapi');
  return {
    async exists() {
      try {
        return (await stat(filename)).isFile();
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    async read() {
      let encrypted;
      try {
        encrypted = await readFile(filename, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      try {
        return await seal('unprotect', encrypted);
      } catch {
        throw Object.assign(Error('本机 GitHub 凭据无法解密，请重新连接。'), {
          status: 401,
          reason: 'decrypt_failed',
          hasCredential: true,
        });
      }
    },
    async write(plain, beforeCommit = () => {}) {
      const encrypted = await seal('protect', plain);
      await mkdir(root, { recursive: true });
      const temp = path.join(root, 'credential-' + randomUUID() + '.tmp');
      try {
        await writeFile(temp, encrypted, { mode: 0o600, flag: 'wx' });
        beforeCommit();
        await rename(temp, filename);
      } finally {
        await unlink(temp).catch(() => {});
      }
    },
    async remove() {
      try {
        await unlink(filename);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}

const ITEM_NOT_FOUND = 44;
const keychainError = () =>
  Object.assign(
    Error('无法访问 macOS 钥匙串。请确认登录钥匙串已解锁，并允许访问 Antigravity GitHub Studio 凭据。'),
    { status: 503, reason: 'keychain_unavailable' },
  );

export function macCredentialStore(root, { run = command, keychain } = {}) {
  const service = 'Antigravity GitHub Studio';
  const account = createHash('sha256').update(path.resolve(root)).digest('hex');
  const identity = ['-s', service, '-a', account];
  const keychains = keychain ? [keychain] : [];

  async function security(args, options) {
    try {
      return await run('/usr/bin/security', args, options);
    } catch {
      throw keychainError();
    }
  }

  async function find(passwordOnly) {
    const flags = passwordOnly ? ['-w'] : [];
    const result = await security(['find-generic-password', ...flags, ...identity, ...keychains]);
    if (result.code === ITEM_NOT_FOUND) return null;
    if (result.code !== 0) throw keychainError();
    return result.stdout;
  }

  return {
    async exists() {
      return (await find(false)) !== null;
    },
    async read() {
      const result = await find(true);
      if (result === null) return null;
      const encoded = result.trim();
      if (!/^v1\.[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw Object.assign(Error('钥匙串中的 GitHub 凭据格式无效，请重新登录。'), {
          status: 401,
          reason: 'invalid_local',
          hasCredential: true,
        });
      }
      return Buffer.from(encoded.slice(3), 'base64').toString('utf8');
    },
    async write(plain, beforeCommit = () => {}) {
      const encoded = 'v1.' + Buffer.from(plain, 'utf8').toString('base64');
      const args = [...identity, '-U', '-w', encoded, ...keychains];
      if (args.some((arg) => /[\r\n\0]/.test(arg))) throw keychainError();
      const quoted = args.map((arg) => '"' + arg.replace(/["\\]/g, '\\$&') + '"');
      const input = 'add-generic-password ' + quoted.join(' ') + '\n';
      if (Buffer.byteLength(input) >= 4095) throw Error('GitHub 凭据过长，无法保存到 macOS 钥匙串。');
      beforeCommit();
      const result = await security(['-q', '-i'], { input });
      if (result.code !== 0) throw keychainError();
    },
    async remove() {
      const result = await security(['delete-generic-password', ...identity, ...keychains]);
      if (result.code !== 0 && result.code !== ITEM_NOT_FOUND) throw keychainError();
    },
  };
}

/**
 * Fix for Linux / SSH Remote hosts: 0600 AES-256-GCM local vault bound to per-user plugin data dir.
 */
export function linuxVaultCredentialStore(root) {
  const keyFile = path.join(root, '.vault.key');
  const vaultFile = path.join(root, 'credential.enc');

  async function ensureKey() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const raw = (await readFile(keyFile, 'utf8')).trim();
      const buf = Buffer.from(raw, 'hex');
      if (buf.length === 32) return buf;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const generated = randomBytes(32);
    const tmp = keyFile + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tmp, generated.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
      await rename(tmp, keyFile);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    return generated;
  }

  return fileCredentialStore(root, async (action, value) => {
    const key = await ensureKey();
    if (action === 'protect') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
    }
    const parts = String(value).trim().split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw Error('Invalid encrypted vault format');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const enc = Buffer.from(parts[3], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  });
}

export function credentialStore(root, seal) {
  if (seal || process.platform === 'win32') return fileCredentialStore(root, seal);
  if (process.platform === 'darwin') return macCredentialStore(root);
  return linuxVaultCredentialStore(root);
}
