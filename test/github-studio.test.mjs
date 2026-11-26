import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { encodeRefSegments, GitHub, Operations } from '../src/core.mjs';
import { linuxVaultCredentialStore, fileCredentialStore } from '../src/credential-store.mjs';
import { GhAuth } from '../src/gh.mjs';
import { extractZipTexts, inspectProgram } from '../src/program-inspect.mjs';
import { Drafts } from '../src/drafts.mjs';
import { browserSearch } from '../src/browser-query.mjs';
import { StudioCopyService } from '../src/ai-copy.mjs';

function buildTestZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const rawBuf = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.deflate ? 8 : 0;
    const compBuf = method === 8 ? deflateRawSync(rawBuf) : rawBuf;

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(e.encrypted ? 1 : 0, 6);
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt32LE(compBuf.length, 18);
    localHdr.writeUInt32LE(rawBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);

    localParts.push(localHdr, nameBuf, compBuf);

    const cdHdr = Buffer.alloc(46);
    cdHdr.writeUInt32LE(0x02014b50, 0);
    cdHdr.writeUInt16LE(20, 4);
    cdHdr.writeUInt16LE(20, 6);
    cdHdr.writeUInt16LE(e.encrypted ? 1 : 0, 8);
    cdHdr.writeUInt16LE(method, 10);
    cdHdr.writeUInt32LE(compBuf.length, 20);
    cdHdr.writeUInt32LE(rawBuf.length, 24);
    cdHdr.writeUInt16LE(nameBuf.length, 28);
    cdHdr.writeUInt32LE(offset, 42);

    cdParts.push(cdHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test('encodeRefSegments preserves valid slashed branches and rejects unsafe refs (Fix #3)', () => {
  assert.equal(encodeRefSegments('main'), 'main');
  assert.equal(encodeRefSegments('feat/native-context-menu'), 'feat/native-context-menu');
  assert.equal(encodeRefSegments('release/v1.2.0/rc-1'), 'release/v1.2.0/rc-1');

  for (const bad of ['', '/main', 'feat/', 'feat//bar', 'a/../b', 'branch.lock', 'feat\\win', 'feat space']) {
    assert.throws(() => encodeRefSegments(bad), /格式|不能为空/);
  }
});

test('linuxVaultCredentialStore & fileCredentialStore encrypt, read, and detect tampering (Fix #4)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-studio-cred-'));
  try {
    const store = linuxVaultCredentialStore(tmp);
    assert.equal(await store.exists(), false);
    await store.write(JSON.stringify({ access_token: 'test_tok_123' }));
    assert.equal(await store.exists(), true);
    const readBack = JSON.parse(await store.read());
    assert.equal(readBack.access_token, 'test_tok_123');

    // Tamper ciphertext -> should throw 401 decrypt_failed
    const dpapiPath = path.join(tmp, 'credential.dpapi');
    fs.writeFileSync(dpapiPath, 'v1:bad:bad:bad', 'utf8');
    await assert.rejects(() => store.read(), (err) => err.status === 401 && err.reason === 'decrypt_failed');

    await store.remove();
    assert.equal(await store.exists(), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GhAuth uses clean repo scope for Device Flow and supports PAT quick-connect (Fix #2)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-studio-auth-'));
  try {
    const memSeal = async (act, val) => (act === 'protect' ? Buffer.from(val).toString('hex') : Buffer.from(val, 'hex').toString('utf8'));
    const store = fileCredentialStore(tmp, memSeal);
    const calls = [];
    const fakeFetch = async (url, opts) => {
      const bodyStr = opts.body?.toString() || '';
      calls.push({ url, bodyStr });
      if (url.endsWith('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev_123',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            interval: 1,
            expires_in: 60,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ access_token: 'gho_valid_oauth_token_1234567890' }), { status: 200 });
    };

    const auth = new GhAuth(tmp, {
      credentialStore: store,
      fetchImpl: fakeFetch,
      sleep: async () => {},
    });

    await auth.configure('Ov23liTestClientId123');
    const loginState = await auth.start();
    await auth.task;
    assert.ok(calls[0].bodyStr.includes('scope=repo'));
    assert.ok(!calls[0].bodyStr.includes('offline_access'), 'Must not request invalid OIDC offline_access on GitHub OAuth App');
    assert.equal(await auth.token(), 'gho_valid_oauth_token_1234567890');
    assert.equal(loginState !== null, true);

    // PAT validation
    const dummyClassicPat = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    await assert.rejects(() => auth.savePersonalToken('invalid-short'), /令牌格式无效/);
    await auth.savePersonalToken(dummyClassicPat);
    assert.equal(await auth.token(), dummyClassicPat);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('extractZipTexts & inspectProgram read Stored/Deflate ZIPs, reject zip-slip, and strip secrets', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-studio-zip-'));
  try {
    const slipZip = buildTestZip([{ name: '../evil.js', data: 'alert(1)' }]);
    assert.throws(() => extractZipTexts(slipZip), /不安全的文件路径/);

    const validZip = buildTestZip([
      { name: 'package.json', data: JSON.stringify({ name: 'demo-tool', description: '轻量级命令行日志分析工具' }), deflate: true },
      { name: 'README.md', data: '# Demo Tool\n\n支持按时间窗口快速聚合 Nginx 与系统日志。', deflate: true },
      { name: 'src/index.mjs', data: 'export function parseLog(line) { return line.trim(); }\n', deflate: false },
      { name: '.env', data: 'SECRET=123', deflate: false },
      { name: 'src/leaked.js', data: `const t = "${'github_pat_' + '11ABCDEF12345678901234567890'}";`, deflate: true },
    ]);

    const parsed = extractZipTexts(validZip);
    assert.deepEqual(
      parsed.files.map((f) => f.path),
      ['package.json', 'README.md', 'src/index.mjs'],
    );

    const zipPath = path.join(tmp, 'source.zip');
    fs.writeFileSync(zipPath, validZip);

    const ops = new Operations({}, { root: tmp });
    await ops.init();
    const staged = await ops.addAssetFromSourcePath(zipPath, 'intro');
    const copySvc = new StudioCopyService({ api: {}, root: tmp, ops, drafts: new Drafts({ root: tmp }) });
    const descRes = await copySvc.describeProgram({ assetIds: [staged.id], repoName: 'demo-tool' });
    assert.ok(descRes.text.includes('轻量级命令行日志分析工具'));
    assert.ok(descRes.text.includes('Nginx'));
    assert.equal(descRes.readFiles.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Operations & GitHub.commitFiles handle slashed branches, block leaked github_pat_, and manage drafts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-studio-ops-'));
  try {
    const routesCalled = [];
    const fakeAuth = { token: async () => 'tok_test' };
    const fakeFetch = async (url, opts = {}) => {
      const route = url.replace('https://api.github.com', '');
      routesCalled.push(`${opts.method || 'GET'} ${route}`);
      if (route === '/user') {
        return new Response(JSON.stringify({ id: 42, login: 'alice', name: 'Alice', avatar_url: 'https://avatars.githubusercontent.com/u/42' }), { status: 200 });
      }
      if (route === '/repos/alice/my-repo/git/ref/heads/feat/slashed-branch') {
        return new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } }), { status: 200 });
      }
      if (route === `/repos/alice/my-repo/git/commits/${'a'.repeat(40)}`) {
        return new Response(JSON.stringify({ tree: { sha: 'b'.repeat(40) } }), { status: 200 });
      }
      if (route === `/repos/alice/my-repo/git/trees/${'b'.repeat(40)}`) {
        return new Response(JSON.stringify({ tree: [] }), { status: 200 });
      }
      if (route === '/repos/alice/my-repo/git/trees' && opts.method === 'POST') {
        return new Response(JSON.stringify({ sha: 'c'.repeat(40) }), { status: 201 });
      }
      if (route === '/repos/alice/my-repo/git/commits' && opts.method === 'POST') {
        return new Response(JSON.stringify({ sha: 'd'.repeat(40) }), { status: 201 });
      }
      if (route === '/repos/alice/my-repo/git/refs/heads/feat/slashed-branch' && opts.method === 'PATCH') {
        return new Response(JSON.stringify({ ref: 'refs/heads/feat/slashed-branch' }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'unexpected ' + route }), { status: 404 });
    };

    const api = new GitHub({ auth: fakeAuth, fetchImpl: fakeFetch });
    const ops = new Operations(api, { root: tmp });
    await ops.init();

    // Must block leaked fine-grained github_pat_ token
    const dummyFinePat = 'github_pat_' + '11ABCDEF12345678901234567890';
    await assert.rejects(
      () =>
        ops.prepare('commit_files', {
          owner: 'alice',
          repo: 'my-repo',
          branch: 'feat/slashed-branch',
          baseCommit: 'a'.repeat(40),
          message: 'bad commit',
          files: [{ path: 'config.js', content: `const k = "${dummyFinePat}";` }],
        }),
      /疑似私钥或访问令牌/,
    );

    // Valid commit on slashed branch
    const prep = await ops.prepare('commit_files', {
      owner: 'alice',
      repo: 'my-repo',
      branch: 'feat/slashed-branch',
      baseCommit: 'a'.repeat(40),
      message: 'feat: add clean module',
      files: [{ path: 'src/clean.js', content: 'export const x = 1;\n' }],
    });
    assert.equal(prep.status, 'pending');

    const confirmed = await ops.confirm(prep.operationId);
    assert.equal(confirmed.status, 'completed');
    assert.equal(confirmed.result.sha, 'd'.repeat(40));
    assert.ok(routesCalled.includes('GET /repos/alice/my-repo/git/ref/heads/feat/slashed-branch'));
    assert.ok(routesCalled.includes('PATCH /repos/alice/my-repo/git/refs/heads/feat/slashed-branch'));

    // Drafts roundtrip for release (Fix #1 backend + UI contract)
    const drafts = new Drafts({ root: tmp });
    await drafts.save({ kind: 'release', owner: 'alice', repo: 'my-repo', title: 'v1.0.0 正式版', body: '### 新增\n- 初始版本' });
    const loaded = await drafts.load({ kind: 'release', owner: 'alice', repo: 'my-repo' });
    assert.equal(loaded.title, 'v1.0.0 正式版');
    assert.equal(loaded.body, '### 新增\n- 初始版本');

    // Browser search builder
    const bs = browserSearch({ query: 'mcp app', type: 'repositories', language: 'TypeScript', minStars: '50', sort: 'stars' });
    assert.ok(bs.url.startsWith('https://github.com/search?'));
    assert.ok(bs.query.includes('language:TypeScript'));
    assert.ok(bs.query.includes('stars:>=50'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
