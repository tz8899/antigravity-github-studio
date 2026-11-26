import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { createDiagnostics } from './src/diagnostics.mjs';
import { createTransport } from './src/network.mjs';
import { GhAuth } from './src/gh.mjs';
import { GitHub, Operations } from './src/core.mjs';
import { searchGitHub } from './src/search.mjs';
import { Drafts } from './src/drafts.mjs';
import { StudioCopyService } from './src/ai-copy.mjs';
import { pickLocalFiles, copyTextToSystemClipboard } from './src/file-picker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://github-studio/studio.html';
const DEFAULT_HTML_PATH = path.join(__dirname, 'dist', 'studio.html');

const DATA_ROOT =
  process.env.PLUGIN_DATA ||
  process.env.AGY_GITHUB_STUDIO_DATA ||
  path.join(os.homedir(), '.gemini', 'antigravity', 'plugin-data', 'github-studio');

function readStudioHtml() {
  const htmlPath = process.env.GITHUB_STUDIO_APP_HTML || DEFAULT_HTML_PATH;
  return fs.readFileSync(htmlPath, 'utf8');
}

const diagnostics = createDiagnostics(DATA_ROOT);
diagnostics('plugin_started');

const transport = createTransport();
const auth = new GhAuth(DATA_ROOT, { diagnostics, fetchImpl: transport.fetch });
const api = new GitHub({ auth, diagnostics, fetchImpl: transport.fetch });
const ops = new Operations(api, { root: DATA_ROOT });
await ops.init();
const drafts = new Drafts({ root: DATA_ROOT });
const copyService = new StudioCopyService({ api, root: DATA_ROOT, ops, drafts });

async function collectStudioState({ initialTab, highlightOpId } = {}) {
  let user = null;
  let error = null;
  let errorKind = null;
  const hasCred = await auth.hasCredential();
  if (hasCred && !['preparing', 'waiting'].includes(auth.login.state)) {
    try {
      user = await api.me();
    } catch (e) {
      error = e.message;
      errorKind = !e.status
        ? 'network'
        : e.status === 401
          ? 'auth'
          : e.status === 403 || e.status === 429
            ? 'rate-limit'
            : e.status >= 500
              ? 'server'
              : 'other';
    }
  }
  return {
    user,
    error,
    errorKind,
    clientId: await auth.clientId(),
    hasCredential: hasCred,
    login: auth.login,
    operations: ops.list(),
    attachments: ops.assetList('release'),
    introAttachments: ops.assetList('intro'),
    ...(initialTab ? { initialTab } : {}),
    ...(highlightOpId ? { highlightOpId } : {}),
  };
}

function jsonToolResponse(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { data: payload },
  };
}

function errorToolResponse(err) {
  const msg = err?.message || String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
    structuredContent: { error: msg },
  };
}

const server = new McpServer(
  {
    name: 'github-studio',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

registerAppResource(
  server,
  'GitHub Studio',
  APP_URI,
  {
    description: 'Antigravity GitHub Studio：账号设备流/令牌连接、仓库浏览、源码 AI 介绍、草稿自动保存与 Release 安全确认发布台。',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: false,
        csp: {
          resourceDomains: [
            'https://avatars.githubusercontent.com',
            'https://*.githubusercontent.com',
            'https://github.com',
          ],
        },
      },
    },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readStudioHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: {
              resourceDomains: [
                'https://avatars.githubusercontent.com',
                'https://*.githubusercontent.com',
                'https://github.com',
              ],
            },
          },
        },
      },
    ],
  }),
);

// 1. Primary Studio UI Launcher (Sidebar Global + Side-Pane Aux Entrypoint)
registerAppTool(
  server,
  'open_github_studio',
  {
    title: 'GitHub Studio',
    description:
      '打开 GitHub Studio 可视化工作台：连接 GitHub 账号、浏览仓库代码、新建仓库、管理 Release 发布包，以及预览并确认待执行的写入操作。',
    inputSchema: {
      tab: z.enum(['repos', 'releases', 'operations']).optional().describe('打开时默认展示的标签页'),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'GitHub Studio' },
          { type: 'global', title: 'GitHub Studio' },
        ],
      },
    },
  },
  async (args) => {
    const state = await collectStudioState({ initialTab: args?.tab });
    const summary = state.user
      ? `GitHub Studio 已打开（当前已连接 @${state.user.login}，待确认操作 ${state.operations.filter((o) => o.status === 'pending').length} 项）。`
      : 'GitHub Studio 已打开（当前尚未连接 GitHub 账号，可在面板中通过 OAuth 设备码或个人令牌登录）。';
    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: state,
    };
  },
);

// 2. Model-Visible GitHub Read & Search Tools
server.tool(
  'github_account',
  '查看当前已连接的 GitHub 账号信息。若未登录，可调用 open_github_studio 引导用户在面板中完成登录。',
  {},
  async () => {
    try {
      return jsonToolResponse(await api.me());
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_list_repositories',
  '列出当前已连接 GitHub 账号可访问的仓库列表，支持按页码翻页（每页 30 个）。',
  {
    page: z.number().int().min(1).optional().describe('页码，默认为 1'),
  },
  async (args) => {
    try {
      return jsonToolResponse(await api.repos(args?.page ?? 1));
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_search_repositories',
  '全站搜索 GitHub 公开仓库。支持关键词及 language:、topic:、stars:、user:、org:、license: 等条件，可按 stars/forks/updated 排序。拿到 owner/repo 后可用 github_read 读取 README 与代码。',
  {
    query: z.string().describe('搜索关键词与条件，例如 pdf language:Python stars:>100 license:mit'),
    page: z.number().int().min(1).optional(),
    perPage: z.number().int().min(1).max(30).optional(),
    sort: z.enum(['stars', 'forks', 'updated', 'help-wanted-issues']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  },
  async (args) => {
    try {
      return jsonToolResponse(await searchGitHub(api, 'repositories', args));
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_search_code',
  '搜索 GitHub 公开仓库中的代码或文件；支持关键词、repo:作者/仓库、language:、filename:、extension:、path:。每分钟最多 10 次请求，拿到匹配路径后请用 github_read 阅读完整文件。',
  {
    query: z.string().describe('代码搜索语句，例如 addClass repo:jquery/jquery filename:jquery.js'),
    page: z.number().int().min(1).optional(),
    perPage: z.number().int().min(1).max(30).optional(),
  },
  async (args) => {
    try {
      return jsonToolResponse(await searchGitHub(api, 'code', args));
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_read',
  '读取 GitHub 仓库的目录列表或文本文件内容（同时返回当前分支最新 commit_sha，供后续准备提交时作为 baseCommit）。',
  {
    owner: z.string().describe('GitHub 账号或组织名'),
    repo: z.string().describe('仓库名'),
    path: z.string().optional().describe('仓库内文件或目录路径，省略则读取根目录'),
    ref: z.string().optional().describe('分支、标签或提交 SHA，省略则为 HEAD'),
  },
  async (args) => {
    try {
      return jsonToolResponse(await api.contents(args));
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_list_releases',
  '列出指定仓库的 GitHub Releases 版本及附件下载链接。',
  {
    owner: z.string().describe('GitHub 账号名'),
    repo: z.string().describe('仓库名'),
  },
  async (args) => {
    try {
      return jsonToolResponse({ releases: await api.releaseList(args) });
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_list_attachments',
  '列出用户在 GitHub Studio 面板中已选择暂存的待发布安装包附件（返回附件 ID、文件名和大小）。',
  {},
  async () => {
    try {
      return jsonToolResponse({ attachments: ops.assetList('release') });
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_operation_status',
  '查询待确认或已执行操作的真实状态。仅当 status === "completed" 时才代表已在 GitHub 执行成功；"pending" 表示仍在等待用户点击确认。',
  {
    operationId: z.string().describe('准备写入工具返回的 operationId'),
  },
  async (args) => {
    try {
      return jsonToolResponse(ops.status(args.operationId));
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

server.tool(
  'github_save_draft',
  '将撰写或润色好的新建仓库介绍（kind="repository"）或 Release 版本标题与更新说明（kind="release"）保存到 GitHub Studio 本地自动恢复草稿箱。',
  {
    kind: z.enum(['repository', 'release']).describe('草稿类型'),
    description: z.string().max(350).optional().describe('当 kind="repository" 时填写的仓库中文简介（不超过 350 字符）'),
    owner: z.string().optional().describe('当 kind="release" 时的仓库所有者'),
    repo: z.string().optional().describe('当 kind="release" 时的仓库名'),
    title: z.string().max(200).optional().describe('当 kind="release" 时的版本标题'),
    body: z.string().max(50000).optional().describe('当 kind="release" 时的 Markdown 更新说明'),
  },
  async (args) => {
    try {
      let merged = { ...args };
      if (args.kind === 'release') {
        const prev = (await drafts.load({ kind: 'release', owner: args.owner, repo: args.repo })) || {};
        merged = {
          kind: 'release',
          owner: args.owner,
          repo: args.repo,
          title: args.title !== undefined ? args.title : prev.title || '',
          body: args.body !== undefined ? args.body : prev.body || '',
        };
      }
      return jsonToolResponse(await drafts.save(merged));
    } catch (e) {
      return errorToolResponse(e);
    }
  },
);

// 3. Write-Preview Tools — Render Interactive Studio Confirmation Card directly!
const INLINE_CONFIRM_META = {
  ui: {
    resourceUri: APP_URI,
  },
};

async function prepareAndBuildUiResult(kind, args) {
  try {
    const prep = await ops.prepare(kind, args);
    if (kind === 'create_repository') await drafts.clear({ kind: 'repository' });
    if (kind === 'create_release') await drafts.clear({ kind: 'release', owner: args.owner, repo: args.repo });
    const state = await collectStudioState({ initialTab: 'operations', highlightOpId: prep.operationId });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            operationId: prep.operationId,
            status: prep.status,
            message: prep.message,
          }),
        },
      ],
      structuredContent: state,
    };
  } catch (e) {
    return errorToolResponse(e);
  }
}

registerAppTool(
  server,
  'github_create_repository',
  {
    title: '预览创建 GitHub 仓库',
    description: '准备在当前个人账号下创建新仓库（生成待确认预览卡片，需用户在面板中点击确认后才会真正创建）。',
    inputSchema: {
      name: z.string().describe('仓库名称（仅限英文字母、数字、-、_、.）'),
      description: z.string().optional().describe('仓库简介（最多 350 字符）'),
      private: z.boolean().optional().describe('是否创建为私有仓库，默认 false（公开）'),
    },
    _meta: INLINE_CONFIRM_META,
  },
  async (args) => prepareAndBuildUiResult('create_repository', args),
);

registerAppTool(
  server,
  'github_commit_files',
  {
    title: '预览提交文件到 GitHub',
    description:
      '准备将完整文本文件提交到个人仓库的已有分支（需先通过 github_read 获取最新 commit_sha 作为 baseCommit；生成预览单需用户确认，切勿在确认前声称已提交成功）。',
    inputSchema: {
      owner: z.string().describe('GitHub 账号名'),
      repo: z.string().describe('仓库名'),
      branch: z.string().describe('已有目标分支名（支持含斜杠分支如 feat/xxx）'),
      baseCommit: z.string().describe('最近 github_read 返回的 40 位 commit_sha'),
      message: z.string().describe('Git 提交说明'),
      files: z
        .array(
          z.object({
            path: z.string().describe('仓库内相对路径'),
            content: z.string().describe('文件完整文本内容'),
          }),
        )
        .min(1)
        .max(100),
    },
    _meta: INLINE_CONFIRM_META,
  },
  async (args) => prepareAndBuildUiResult('commit_files', args),
);

registerAppTool(
  server,
  'github_create_release',
  {
    title: '预览发布 GitHub Release',
    description: '准备在个人仓库创建 Release 版本与标签（生成待确认预览卡片，需用户在面板中点击确认）。',
    inputSchema: {
      owner: z.string().describe('GitHub 账号名'),
      repo: z.string().describe('仓库名'),
      tag_name: z.string().describe('版本标签，例如 v1.0.0'),
      name: z.string().optional().describe('版本标题'),
      body: z.string().optional().describe('Markdown 更新说明'),
      target_commitish: z.string().optional().describe('目标分支，省略则默认使用仓库默认分支'),
      draft: z.boolean().optional().describe('是否保存为草稿 Release'),
      prerelease: z.boolean().optional().describe('是否标记为预发布版本'),
    },
    _meta: INLINE_CONFIRM_META,
  },
  async (args) => prepareAndBuildUiResult('create_release', args),
);

registerAppTool(
  server,
  'github_upload_release_asset',
  {
    title: '预览上传 Release 安装包附件',
    description: '准备将用户在面板中已暂存的安装包附件上传到指定 Release（生成待确认预览卡片，需用户点击确认）。',
    inputSchema: {
      owner: z.string().describe('GitHub 账号名'),
      repo: z.string().describe('仓库名'),
      releaseId: z.number().int().min(1).describe('github_list_releases 返回的数字 Release ID'),
      assetId: z.string().describe('github_list_attachments 返回的暂存附件 ID'),
    },
    _meta: INLINE_CONFIRM_META,
  },
  async (args) => prepareAndBuildUiResult('upload_asset', args),
);

// 4. App-Only Backend RPC Tools for the GitHub Studio Interactive UI
const APP_ONLY_META = {
  ui: {
    visibility: ['app'],
  },
};

function registerStudioRpc(name, schema, handler) {
  registerAppTool(
    server,
    name,
    {
      title: name,
      description: `GitHub Studio internal UI RPC: ${name}`,
      inputSchema: schema,
      _meta: APP_ONLY_META,
    },
    async (args) => {
      try {
        const res = await handler(args || {});
        return {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: res && typeof res === 'object' && !Array.isArray(res) ? res : { items: res },
        };
      } catch (e) {
        return errorToolResponse(e);
      }
    },
  );
}

registerStudioRpc('studio_state', {}, async () => collectStudioState());

registerStudioRpc('studio_repos', { page: z.number().int().min(1).optional() }, async (a) => api.repos(a.page ?? 1));

registerStudioRpc(
  'studio_contents',
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string().optional(),
    ref: z.string().optional(),
  },
  async (a) => api.contents(a),
);

registerStudioRpc(
  'studio_releases',
  {
    owner: z.string(),
    repo: z.string(),
  },
  async (a) => ({ releases: await api.releaseList(a) }),
);

registerStudioRpc(
  'studio_auth',
  {
    action: z.enum(['configure', 'start', 'cancel', 'logout', 'pat']),
    clientId: z.string().optional(),
    token: z.string().optional(),
  },
  async (a) => {
    if (a.action === 'configure') {
      await auth.configure(a.clientId);
    } else if (a.action === 'start') {
      await auth.start();
    } else if (a.action === 'cancel') {
      auth.cancel();
    } else if (a.action === 'logout') {
      await auth.logout();
      ops.clearPending();
    } else if (a.action === 'pat') {
      await auth.savePersonalToken(a.token);
      // Validate token immediately; roll back if invalid
      try {
        await api.me();
      } catch (e) {
        await auth.logout();
        throw e;
      }
    }
    return collectStudioState();
  },
);

registerStudioRpc(
  'studio_prepare',
  {
    kind: z.enum(['create_repository', 'commit_files', 'create_release', 'upload_asset']),
    args: z.record(z.any()),
  },
  async (a) => {
    const res = await ops.prepare(a.kind, a.args);
    if (a.kind === 'create_repository') await drafts.clear({ kind: 'repository' });
    if (a.kind === 'create_release') {
      await drafts.clear({ kind: 'release', owner: a.args.owner, repo: a.args.repo });
    }
    return { ...res, state: await collectStudioState() };
  },
);

registerStudioRpc('studio_confirm', { id: z.string() }, async (a) => {
  const op = await ops.confirm(a.id);
  return { operation: op, state: await collectStudioState() };
});

registerStudioRpc('studio_reject', { id: z.string() }, async (a) => {
  const op = ops.reject(a.id);
  return { operation: op, state: await collectStudioState() };
});

registerStudioRpc(
  'studio_pick_files',
  {
    purpose: z.enum(['release', 'intro']).optional(),
    multiple: z.boolean().optional(),
  },
  async (a) => {
    const purpose = a.purpose ?? 'release';
    const picked = await pickLocalFiles({ multiple: Boolean(a.multiple), purpose });
    const staged = [];
    for (const filePath of picked.slice(0, 10)) {
      staged.push(await ops.addAssetFromSourcePath(filePath, purpose));
    }
    return { staged, cancelled: picked.length === 0, state: await collectStudioState() };
  },
);

registerStudioRpc(
  'studio_stage_path',
  {
    filePath: z.string(),
    purpose: z.enum(['release', 'intro']).optional(),
  },
  async (a) => {
    const item = await ops.addAssetFromSourcePath(a.filePath, a.purpose ?? 'release');
    return { staged: [item], state: await collectStudioState() };
  },
);

registerStudioRpc('studio_remove_attachment', { id: z.string() }, async (a) => {
  await ops.removeAsset(a.id);
  return collectStudioState();
});

registerStudioRpc(
  'studio_draft',
  {
    action: z.enum(['get', 'save', 'clear']),
    kind: z.enum(['repository', 'release']),
    owner: z.string().optional(),
    repo: z.string().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
  },
  async (a) => {
    if (a.action === 'get') return { draft: await drafts.load(a) };
    if (a.action === 'save') return await drafts.save(a);
    return await drafts.clear(a);
  },
);

registerStudioRpc(
  'studio_ai_copy',
  {
    mode: z.enum(['program', 'release']),
    assetIds: z.array(z.string()).optional(),
    repoName: z.string().optional(),
    existingDescription: z.string().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    kind: z.enum(['title', 'body']).optional(),
    tag: z.string().optional(),
    branch: z.string().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
  },
  async (a) => {
    if (a.mode === 'program') {
      return await copyService.describeProgram(a);
    }
    return await copyService.createReleaseCopy(a);
  },
);

registerStudioRpc('studio_copy_text', { text: z.string() }, async (a) => copyTextToSystemClipboard(a.text));

const shutdown = () => {
  diagnostics('plugin_stopped');
  auth.dispose();
  transport.close().catch(() => {});
  ops.clearPending();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  const mcpTransport = new StdioServerTransport();
  await server.connect(mcpTransport);
}

main().catch((err) => {
  console.error('[github-studio] Fatal server error:', err);
  process.exit(1);
});
