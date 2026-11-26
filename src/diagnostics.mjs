import { mkdirSync, appendFileSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EVENTS = new Set([
  'plugin_started',
  'plugin_stopped',
  'credential_read',
  'credential_saved',
  'logout',
  'oauth_started',
  'oauth_waiting',
  'oauth_retry',
  'oauth_failed',
  'api_response',
  'api_failure',
]);

const CATEGORIES = new Set(['account', 'search', 'repository', 'upload', 'authorization']);

const REASONS = new Set([
  'ok',
  'missing',
  'read_failed',
  'decrypt_failed',
  'keychain_unavailable',
  'invalid_local',
  'invalid_credentials',
  'forbidden',
  'rate_limited',
  'server_error',
  'tls_error',
  'dns_error',
  'connection_error',
  'network_error',
  'timeout',
  'authorization_failed',
  'access_denied',
  'expired_token',
  'device_flow_disabled',
  'incorrect_client_credentials',
  'incorrect_device_code',
  'unsupported_grant_type',
  'oauth_error',
  'local_disconnect',
]);

/** Allowlisted metadata only. Never log messages, URLs, queries, or tokens. */
export function createDiagnostics(root, { now = Date.now } = {}) {
  const file = path.join(root, 'diagnostics.jsonl');
  const last = new Map();
  return (event, fields = {}) => {
    if (!EVENTS.has(event)) return;
    const data = {};
    if (CATEGORIES.has(fields.category)) data.category = fields.category;
    if (REASONS.has(fields.reason)) data.reason = fields.reason;
    if (Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599) {
      data.status = fields.status;
    }
    if (typeof fields.hasCredential === 'boolean') data.hasCredential = fields.hasCredential;

    const key = event + ':' + (data.category ?? '');
    const value = JSON.stringify(data);
    const previous = last.get(key);
    const time = now();
    if (previous?.value === value && time - previous.time < 60000) return;
    last.set(key, { value, time });

    try {
      mkdirSync(root, { recursive: true });
      try {
        if (statSync(file).size > 2 * 1024 * 1024) {
          const lines = readFileSync(file, 'utf8').split('\n');
          writeFileSync(file, lines.slice(-2000).join('\n') + '\n', { mode: 0o600 });
        }
      } catch {}
      appendFileSync(
        file,
        JSON.stringify({ time: new Date(time).toISOString(), pid: process.pid, event, ...data }) + '\n',
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostics failure must never interrupt authentication or API calls. */
    }
  };
}

export function requestCategory(route) {
  if (route === '/user') return 'account';
  if (route.startsWith('/search/')) return 'search';
  if (route.includes('/assets')) return 'upload';
  return 'repository';
}
