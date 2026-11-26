import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { browserSearch } from './browser-query.mjs';
import { repositoryNameError, repositoryNameHint } from './repository-name.mjs';

const OAUTH_REG_URL = 'https://github.com/settings/applications/new';
const OAUTH_HOMEPAGE = 'https://antigravity.google';

const KIND_LABEL = {
  create_repository: '创建仓库',
  commit_files: '提交文件',
  create_release: '发布版本',
  upload_asset: '上传程序附件',
};

const STATUS_LABEL = {
  pending: '待确认',
  checking: '检查账号中',
  running: '正在执行',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期',
};

const app = new App({ name: 'Antigravity GitHub Studio', version: '1.0.0' }, {});

const ui = {
  state: null,
  error: '',
  busy: '',
  tab: 'repos', // 'repos' | 'releases' | 'operations'
  highlightOpId: '',
  canSendMessage: false,
  oauthDetailsOpen: null,
  patDetailsOpen: false,
  clientIdDraft: null,
  patDraft: '',

  // Repositories & file browser
  repositories: [],
  page: 1,
  hasMore: false,
  selected: null,
  ref: '',
  folder: '',
  content: null,
  deleteConfirmOpen: false,

  // Create repository form
  createOpen: false,
  newRepoName: '',
  newRepoNameErr: '',
  newRepoDesc: '',
  newRepoPrivate: false,
  newRepoReadFiles: [],
  newRepoSavedAt: '',
  newRepoAgentPrompt: '',
  introPathInput: '',

  // Releases & ReleaseEditor (with fixed autosave!)
  releases: [],
  relTag: '',
  relBranch: '',
  relTitle: '',
  relBody: '',
  relDraft: false,
  relPrerelease: false,
  relPreviewMd: false,
  relSavedAt: '',
  relAgentPrompt: '',
  releasePathInput: '',

  // Browser search
  searchType: 'repositories',
  searchQuery: '',
  searchFilters: {
    language: '',
    minStars: '',
    license: '',
    pushed: '',
    owner: '',
    ownerType: 'user',
    repo: '',
    path: '',
    symbol: '',
    visibility: '',
    sort: '',
  },
  searchError: '',
};

let pollTimer = null;
let pollInFlight = false;
let repoDraftTimer = null;
let releaseDraftTimer = null;
let toastTimer = null;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sizeLabel(n) {
  const num = Number(n) || 0;
  if (num >= 1024 ** 2) return (num / 1024 ** 2).toFixed(1) + ' MB';
  if (num >= 1024) return (num / 1024).toFixed(1) + ' KB';
  return num + ' B';
}

function showToast(msg) {
  const el = document.getElementById('gh-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}

function renderSimpleMarkdown(md) {
  const src = String(md || '').trim();
  if (!src) return '<p class="gh-muted">暂无内容</p>';
  const blocks = [];
  const fenced = src.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre class="gh-code" data-lang="${esc(lang)}"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  const lines = fenced.split(/\r?\n/);
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  const inlineFmt = (s) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\(&lt;(https:\/\/[^&\s]+)&gt;\)/g, '<img src="$2" alt="$1" loading="lazy" />')
      .replace(/!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
      .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext-url="$2">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const mBlock = line.match(/^\x00CODEBLOCK_(\d+)\x00$/);
    if (mBlock) {
      closeList();
      html.push(blocks[Number(mBlock[1])]);
      continue;
    }
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith('### ')) {
      closeList();
      html.push(`<h3>${inlineFmt(line.slice(4))}</h3>`);
    } else if (line.startsWith('## ')) {
      closeList();
      html.push(`<h3>${inlineFmt(line.slice(3))}</h3>`);
    } else if (line.startsWith('# ')) {
      closeList();
      html.push(`<h2>${inlineFmt(line.slice(2))}</h2>`);
    } else if (line.startsWith('> ')) {
      closeList();
      html.push(`<blockquote>${inlineFmt(line.slice(2))}</blockquote>`);
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inlineFmt(line.replace(/^[-*]\s+/, ''))}</li>`);
    } else {
      closeList();
      html.push(`<p>${inlineFmt(line)}</p>`);
    }
  }
  closeList();
  return html.join('\n');
}

async function rpc(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  const payload = res?.structuredContent;
  if (res?.isError || payload?.error) {
    throw Error(payload?.error || '操作请求失败');
  }
  return payload || {};
}

async function openExternal(url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  try {
    await app.openLink({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function copyText(text, label = '内容') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}已复制`);
    return;
  } catch {}
  try {
    await rpc('studio_copy_text', { text });
    showToast(`${label}已复制`);
  } catch (e) {
    showToast(e.message || '复制失败，请手动选中复制');
  }
}

function mergeServerState(next) {
  if (!next || typeof next !== 'object') return;
  const prevLogged = Boolean(ui.state?.user?.id);
  const transient = next.hasCredential && next.errorKind && next.errorKind !== 'auth';
  ui.state = transient && ui.state?.user ? { ...next, user: ui.state.user } : next;
  if (next.initialTab && ['repos', 'releases', 'operations'].includes(next.initialTab)) {
    ui.tab = next.initialTab;
  }
  if (next.highlightOpId) {
    ui.highlightOpId = next.highlightOpId;
  }
  const nowLogged = Boolean(ui.state?.user?.id);
  if (!prevLogged && nowLogged) {
    void loadRepos(1);
    void loadRepoDraft();
  } else if (prevLogged && !nowLogged) {
    ui.repositories = [];
    ui.selected = null;
    ui.content = null;
    ui.releases = [];
  }
}

async function act(label, fn, { renderWorkspace = true } = {}) {
  ui.busy = label;
  ui.error = '';
  renderHeaderZone();
  try {
    await fn();
  } catch (e) {
    ui.error = e.message || String(e);
  } finally {
    ui.busy = '';
    renderHeaderZone();
    if (renderWorkspace) renderTabZone();
  }
}

async function loadRepos(page = 1) {
  const res = await rpc('studio_repos', { page });
  ui.repositories = page === 1 ? res.repositories || [] : [...ui.repositories, ...(res.repositories || [])];
  ui.page = page;
  ui.hasMore = Boolean(res.hasMore);
  renderTabZone();
}

async function openRepository(repo) {
  ui.selected = repo;
  ui.ref = repo.default_branch || 'main';
  ui.folder = '';
  ui.content = null;
  ui.releases = [];
  ui.relBranch = repo.default_branch || 'main';
  renderTabZone();
  await readRepoPath(repo, '', ui.ref);
}

async function readRepoPath(repo, p = '', branch = ui.ref) {
  const data = await rpc('studio_contents', {
    owner: repo.owner,
    repo: repo.name,
    path: p,
    ref: branch || repo.default_branch || 'HEAD',
  });
  if (ui.selected?.full_name === repo.full_name) {
    ui.folder = p;
    ui.content = data;
    renderTabZone();
  }
}

async function loadReleasesForSelected(repo = ui.selected) {
  if (!repo) return;
  const res = await rpc('studio_releases', { owner: repo.owner, repo: repo.name });
  if (ui.selected?.full_name === repo.full_name) {
    ui.releases = res.releases || [];
    renderTabZone();
  }
}

async function loadRepoDraft() {
  try {
    const res = await rpc('studio_draft', { action: 'get', kind: 'repository' });
    if (res?.draft?.description && !ui.newRepoDesc) {
      ui.newRepoDesc = res.draft.description;
      ui.newRepoSavedAt = res.draft.updatedAt || '';
      if (ui.createOpen) renderTabZone();
    }
  } catch {}
}

async function loadReleaseDraft(repo) {
  if (!repo) return;
  try {
    const res = await rpc('studio_draft', {
      action: 'get',
      kind: 'release',
      owner: repo.owner,
      repo: repo.name,
    });
    ui.relTitle = res?.draft?.title || '';
    ui.relBody = res?.draft?.body || '';
    ui.relSavedAt = res?.draft?.updatedAt || '';
    renderTabZone();
  } catch {}
}

function scheduleRepoDraftSave() {
  clearTimeout(repoDraftTimer);
  repoDraftTimer = setTimeout(async () => {
    try {
      const res = await rpc('studio_draft', {
        action: 'save',
        kind: 'repository',
        description: ui.newRepoDesc,
      });
      ui.newRepoSavedAt = res.savedAt || '';
      const badge = document.getElementById('gh-repo-draft-status');
      if (badge && ui.newRepoSavedAt) {
        badge.textContent =
          '介绍草稿已自动保存 · ' + new Date(ui.newRepoSavedAt).toLocaleTimeString('zh-CN', { hour12: false });
      }
    } catch {}
  }, 700);
}

function scheduleReleaseDraftSave() {
  if (!ui.selected) return;
  const { owner, name: repo } = ui.selected;
  clearTimeout(releaseDraftTimer);
  releaseDraftTimer = setTimeout(async () => {
    try {
      const res = await rpc('studio_draft', {
        action: 'save',
        kind: 'release',
        owner,
        repo,
        title: ui.relTitle,
        body: ui.relBody,
      });
      ui.relSavedAt = res.savedAt || '';
      const badge = document.getElementById('gh-rel-draft-status');
      if (badge && ui.relSavedAt) {
        badge.textContent =
          '发布文案草稿已自动保存 · ' + new Date(ui.relSavedAt).toLocaleTimeString('zh-CN', { hour12: false });
      }
    } catch {}
  }, 700);
}

function githubIconSvg(size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.09c-3.13.68-3.79-1.33-3.79-1.33-.51-1.29-1.25-1.63-1.25-1.63-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.54 0-1.22.44-2.22 1.16-3-.12-.28-.5-1.42.11-2.95 0 0 .95-.3 3.08 1.15a10.7 10.7 0 0 1 5.61 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.53.23 2.67.11 2.95.73.78 1.16 1.78 1.16 3 0 4.3-2.63 5.25-5.14 5.53.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z"/></svg>`;
}

function ensureShellMounted() {
  const root = document.getElementById('app-root');
  if (!root || document.getElementById('gh-hdr-zone')) return;
  root.innerHTML = `
    <div id="gh-hdr-zone"></div>
    <div id="gh-search-zone"></div>
    <div id="gh-nav-zone"></div>
    <div id="gh-tab-zone"></div>
    <div id="gh-modal-zone"></div>
    <footer class="gh-footer">
      写入与发布操作一律先生成待确认预览单，由你核对公开范围与文件内容后确认执行；删除入口仅跳转 GitHub 官网设置页。
    </footer>
  `;
  renderSearchZone();
}

function renderHeaderZone() {
  ensureShellMounted();
  const hdr = document.getElementById('gh-hdr-zone');
  const nav = document.getElementById('gh-nav-zone');
  if (!hdr || !nav) return;

  const st = ui.state;
  const login = st?.login || { state: 'idle' };
  const logged = Boolean(st?.user);
  const pendingCount = (st?.operations || []).filter((o) => o.status === 'pending').length;

  let authSection = '';
  if (!st) {
    authSection = `<p class="gh-muted">正在检查本机 GitHub 连接状态…</p>`;
  } else if (logged) {
    authSection = `
      <section class="gh-account">
        <img src="${esc(st.user.avatar_url)}" alt="" />
        <div>
          <strong>${esc(st.user.name || st.user.login)}</strong>
          <span>@${esc(st.user.login)} <i class="gh-dot-online"></i> 已连接（本机加密存储）</span>
        </div>
        <button type="button" data-action="logout" ${ui.busy ? 'disabled' : ''}>断开连接</button>
      </section>
    `;
  } else {
    const waitingBlock =
      login.state === 'waiting'
        ? `
          <div class="gh-device">
            <div>
              <span class="gh-muted">请在 GitHub 授权页输入设备码：</span>
              <div class="gh-device-code">${esc(login.code || '正在获取…')}</div>
            </div>
            <div class="gh-actions">
              <button type="button" data-action="copy-device-code" data-code="${esc(login.code || '')}">复制设备码</button>
              <button type="button" class="gh-primary" data-ext-url="${esc(login.url || 'https://github.com/login/device')}">打开 GitHub 授权页面 ↗</button>
              <button type="button" data-action="auth-cancel">取消登录</button>
            </div>
          </div>
        `
        : '';

    const oauthOpen = ui.oauthDetailsOpen !== null ? ui.oauthDetailsOpen : !st.clientId;
    const clientIdVal = ui.clientIdDraft !== null ? ui.clientIdDraft : st.clientId || '';
    const inlineLoginMsg = login.message && login.message !== ui.error ? login.message : '';
    const inlineStateErr =
      st.error && st.error !== ui.error && !['preparing', 'waiting'].includes(login.state) ? st.error : '';

    authSection = `
      <section class="gh-connect">
        <div class="gh-row">
          <div>
            <strong>连接你的 GitHub 账号</strong>
            <p>支持官方 OAuth 设备码登录（免 Client Secret）或个人访问令牌加密直连，Windows 下使用系统 DPAPI 保护。</p>
          </div>
          <button type="button" class="gh-primary" data-action="auth-start" ${ui.busy || ['preparing', 'waiting'].includes(login.state) ? 'disabled' : ''}>
            ${login.state === 'preparing' ? '正在请求设备码…' : login.state === 'waiting' ? '等待网页授权…' : '设备码登录 GitHub'}
          </button>
        </div>
        ${waitingBlock}
        ${inlineLoginMsg ? `<p class="gh-error">${esc(inlineLoginMsg)}</p>` : ''}
        ${inlineStateErr ? `<p class="gh-error">${esc(inlineStateErr)}</p>` : ''}
        ${st.hasCredential ? `<div style="margin-top:8px"><button type="button" data-action="logout" ${ui.busy ? 'disabled' : ''}>清除失效的本地凭据</button></div>` : ''}

        <details data-details="oauth" style="margin-top:12px" ${oauthOpen ? 'open' : ''}>
          <summary>${st.clientId ? '方式一：GitHub OAuth App 设备流配置（已配置 Client ID）' : '方式一：配置 GitHub OAuth App Client ID（推荐长期使用）'}</summary>
          <ol class="gh-oauth-steps">
            <li>点击 <button type="button" class="gh-link-btn" data-ext-url="${OAUTH_REG_URL}">打开 GitHub OAuth App 注册页 ↗</button></li>
            <li>应用名称可填 <code>Antigravity GitHub Studio</code>；主页 URL 与回调 URI 均可填 <code>${OAUTH_HOMEPAGE}</code>
              <span class="gh-oauth-value"><button type="button" data-action="copy-url" data-url="${OAUTH_HOMEPAGE}">复制地址</button></span>，并勾选 <strong>Enable Device Flow</strong>。
            </li>
            <li>将生成的 <strong>Client ID</strong> 粘贴到下方保存（无需 Client Secret），再点右上角「设备码登录 GitHub」。</li>
          </ol>
          <form data-form="oauth-config" class="gh-path-row">
            <input id="gh-oauth-clientid-input" name="clientId" data-bind="clientIdDraft" value="${esc(clientIdVal)}" maxlength="120" placeholder="粘贴你的 OAuth App Client ID（如 Ov23li...）" required />
            <button type="submit" ${ui.busy ? 'disabled' : ''}>保存配置</button>
          </form>
        </details>

        <details data-details="pat" style="margin-top:10px" ${ui.patDetailsOpen ? 'open' : ''}>
          <summary>方式二：使用 Personal Access Token 令牌快速连接（免注册 OAuth App）</summary>
          <p>粘贴具有 <code>repo</code> 权限的 <code>ghp_...</code> 或 <code>github_pat_...</code> 令牌，验证通过后将直接加密存入本机凭据库。</p>
          <form data-form="pat-connect" class="gh-path-row">
            <input id="gh-pat-input" name="token" data-bind="patDraft" value="${esc(ui.patDraft)}" type="password" autocomplete="off" placeholder="ghp_... 或 github_pat_..." required />
            <button type="submit" class="gh-primary" ${ui.busy ? 'disabled' : ''}>验证并加密保存</button>
          </form>
        </details>
      </section>
    `;
  }

  hdr.innerHTML = `
    <header class="gh-header">
      <div class="gh-title">${githubIconSvg(24)}<h2>GitHub Studio</h2></div>
      ${ui.busy ? `<span class="gh-muted">⏳ ${esc(ui.busy)}…</span>` : ''}
    </header>
    <p class="gh-intro">在反重力中直接浏览 GitHub 仓库、辅助撰写项目介绍与更新说明、安全预览代码提交与上传 Release 安装包。</p>
    ${ui.error ? `<div role="alert" class="gh-errorbox"><span>${esc(ui.error)}</span><button type="button" data-action="clear-error" aria-label="关闭提示">×</button></div>` : ''}
    ${st?.user && st.errorKind && st.errorKind !== 'auth' ? `<p class="gh-muted">GitHub 网络波动（${esc(st.error)}），已保留当前界面状态并后台自动重试。</p>` : ''}
    ${authSection}
  `;

  nav.innerHTML = `
    ${pendingCount > 0 && ui.tab !== 'operations' ? `<button type="button" class="gh-pending" data-action="switch-tab" data-tab="operations">🔔 有 ${pendingCount} 项写入/发布操作等待你预览确认，点击前往处理 →</button>` : ''}
    <nav class="gh-tabs" aria-label="GitHub Studio 功能">
      <button type="button" class="gh-tab-btn" data-action="switch-tab" data-tab="repos" ${ui.tab === 'repos' ? 'aria-current="page"' : ''}>仓库浏览与新建</button>
      <button type="button" class="gh-tab-btn" data-action="switch-tab" data-tab="releases" ${ui.tab === 'releases' ? 'aria-current="page"' : ''}>Release 发布</button>
      <button type="button" class="gh-tab-btn" data-action="switch-tab" data-tab="operations" ${ui.tab === 'operations' ? 'aria-current="page"' : ''}>操作确认记录${pendingCount ? ` (${pendingCount})` : ''}</button>
      <button type="button" class="gh-refresh-repos" data-action="refresh-repos" ${!logged || ui.busy ? 'disabled' : ''}>刷新仓库</button>
    </nav>
  `;
}

function renderSearchZone() {
  const zone = document.getElementById('gh-search-zone');
  if (!zone) return;
  const f = ui.searchFilters;
  let previewQuery = '';
  try {
    previewQuery = browserSearch({ query: ui.searchQuery, type: ui.searchType, ...f }).query;
  } catch {}

  zone.innerHTML = `
    <form class="gh-browser-search" data-form="browser-search">
      <div class="gh-search-row">
        <select data-bind="searchType" aria-label="搜索类型">
          <option value="repositories" ${ui.searchType === 'repositories' ? 'selected' : ''}>搜仓库</option>
          <option value="code" ${ui.searchType === 'code' ? 'selected' : ''}>搜代码</option>
        </select>
        <input data-bind="searchQuery" value="${esc(ui.searchQuery)}" maxlength="2000" placeholder="${ui.searchType === 'code' ? '输入代码关键词或 GitHub 搜索语法' : '搜索 GitHub 开源项目或条件'}" />
        <button type="submit" class="gh-primary">官网搜索 ↗</button>
      </div>
      <details class="gh-search-advanced" style="margin-top:6px">
        <summary class="gh-muted" style="cursor:pointer">高级搜索筛选条件</summary>
        <div class="gh-search-fields">
          <label class="gh-field"><span>编程语言</span><input data-filter="language" value="${esc(f.language)}" placeholder="如 TypeScript / Python / Rust" /></label>
          <label class="gh-field"><span>搜索范围</span>
            <select data-filter="visibility">
              <option value="" ${f.visibility === '' ? 'selected' : ''}>默认全部可见</option>
              <option value="public" ${f.visibility === 'public' ? 'selected' : ''}>仅公开仓库</option>
              <option value="private" ${f.visibility === 'private' ? 'selected' : ''}>仅私有仓库</option>
            </select>
          </label>
          <label class="gh-field"><span>限定作者/组织</span><input data-filter="owner" value="${esc(f.owner)}" placeholder="GitHub 用户名或组织名" /></label>
          <label class="gh-field"><span>账号类型</span>
            <select data-filter="ownerType">
              <option value="user" ${f.ownerType === 'user' ? 'selected' : ''}>个人作者 (user)</option>
              <option value="org" ${f.ownerType === 'org' ? 'selected' : ''}>组织 (org)</option>
            </select>
          </label>
          ${
            ui.searchType === 'repositories'
              ? `
                <label class="gh-field"><span>最低 Star 数</span><input type="number" min="0" data-filter="minStars" value="${esc(f.minStars)}" placeholder="不限" /></label>
                <label class="gh-field"><span>排序方式</span>
                  <select data-filter="sort">
                    <option value="" ${f.sort === '' ? 'selected' : ''}>最佳匹配</option>
                    <option value="stars" ${f.sort === 'stars' ? 'selected' : ''}>Star 最多</option>
                    <option value="updated" ${f.sort === 'updated' ? 'selected' : ''}>最近更新</option>
                    <option value="forks" ${f.sort === 'forks' ? 'selected' : ''}>Fork 最多</option>
                  </select>
                </label>
              `
              : `
                <label class="gh-field"><span>限定仓库 (owner/repo)</span><input data-filter="repo" value="${esc(f.repo)}" placeholder="例如 facebook/react" /></label>
                <label class="gh-field"><span>文件路径或符号 (symbol)</span><input data-filter="path" value="${esc(f.path)}" placeholder="例如 src/index.ts" /></label>
              `
          }
        </div>
        ${previewQuery ? `<p class="gh-muted">组合语句：<code>${esc(previewQuery)}</code></p>` : ''}
      </details>
      ${ui.searchError ? `<p class="gh-error">${esc(ui.searchError)}</p>` : ''}
    </form>
  `;
}

function renderReposTab() {
  const st = ui.state;
  if (!st?.user) {
    return `<div class="gh-empty">${githubIconSvg(32)}<strong>请先连接 GitHub 账号</strong><p>登录后可浏览公开与私有仓库、读取代码、新建仓库并自动撰写项目介绍。</p></div>`;
  }

  const introFiles = st.introAttachments || [];
  const createFormHtml = ui.createOpen
    ? `
      <form class="gh-form" data-form="create-repo">
        <div class="gh-field">
          <div class="gh-ai-label">
            <label for="gh-new-repo-name">新仓库名称</label>
            <div class="gh-ai-actions">
              <button type="button" data-action="pick-intro-files" ${ui.busy ? 'disabled' : ''}>📂 选择本地源码 / ZIP</button>
            </div>
          </div>
          <input id="gh-new-repo-name" data-bind="newRepoName" value="${esc(ui.newRepoName)}" maxlength="100" placeholder="my-awesome-project" required />
          <small class="gh-muted">${esc(repositoryNameHint)}</small>
          ${ui.newRepoNameErr ? `<small class="gh-error">${esc(ui.newRepoNameErr)}</small>` : ''}
        </div>

        <details class="gh-muted">
          <summary style="cursor:pointer">或直接输入本机源码/ZIP 路径导入</summary>
          <div class="gh-path-row">
            <input data-bind="introPathInput" value="${esc(ui.introPathInput)}" placeholder="例如 D:\\projects\\my-app\\README.md 或源码 .zip 路径" />
            <button type="button" data-action="stage-intro-path" ${ui.busy ? 'disabled' : ''}>添加文件</button>
          </div>
        </details>

        ${
          introFiles.length
            ? `<div class="gh-imported-files">${introFiles
                .map(
                  (f) => `
                  <div class="gh-attachment">
                    <div><strong>${esc(f.name)}</strong><small>${sizeLabel(f.size)} · 仅用于本地提取介绍</small></div>
                    <button type="button" data-action="remove-asset" data-id="${esc(f.id)}" ${ui.busy ? 'disabled' : ''}>移除</button>
                  </div>`,
                )
                .join('')}</div>`
            : ''
        }

        <div class="gh-field">
          <div class="gh-ai-label">
            <label for="gh-new-repo-desc">仓库简介（最多 350 字符）</label>
            <div class="gh-ai-actions">
              <button type="button" data-action="ai-describe-program" ${!introFiles.length || ui.busy ? 'disabled' : ''} title="${introFiles.length ? '读取已选源码文件生成仓库简介' : '请先选择源码、README 或 ZIP'}">✨ 提取源码生成介绍</button>
              ${
                ui.canSendMessage && ui.newRepoAgentPrompt
                  ? `<button type="button" data-action="ask-agent-polish-repo">🤖 让当前对话模型深度润色</button>`
                  : ''
              }
            </div>
          </div>
          <textarea id="gh-new-repo-desc" data-bind="newRepoDesc" maxlength="350" rows="3" placeholder="简明描述这个项目的核心用途">${esc(ui.newRepoDesc)}</textarea>
          <small id="gh-repo-draft-status" class="gh-muted">${
            ui.newRepoSavedAt
              ? '介绍草稿已自动保存 · ' + new Date(ui.newRepoSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
              : '输入后自动保存本机草稿，切换不丢失'
          }</small>
        </div>

        ${
          ui.newRepoReadFiles.length
            ? `<details class="gh-muted"><summary>已提取 ${ui.newRepoReadFiles.length} 个源码/说明文件（只读，未执行二进制）</summary><ul>${ui.newRepoReadFiles.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>`
            : ''
        }

        <div class="gh-row">
          <label class="gh-check"><input type="checkbox" data-bind-check="newRepoPrivate" ${ui.newRepoPrivate ? 'checked' : ''} /> 创建为私有仓库（默认公开）</label>
          <button type="submit" class="gh-primary" ${ui.busy ? 'disabled' : ''}>生成创建预览单</button>
        </div>
      </form>
    `
    : '';

  let mainArea = '';
  if (ui.selected) {
    const r = ui.selected;
    const isOwner = r.owner.toLowerCase() === st.user.login.toLowerCase();
    let viewer = `<p class="gh-muted">正在读取仓库内容…</p>`;
    if (ui.content?.kind === 'directory') {
      const sorted = [...(ui.content.entries || [])].sort(
        (a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name),
      );
      viewer = `<div class="gh-files">${sorted
        .map(
          (f) => `
            <button type="button" data-action="open-entry" data-path="${esc(f.path)}">
              <span>${f.type === 'dir' ? '📁' : '📄'}</span>
              <span>${esc(f.name)}</span>
              <small>${f.type === 'dir' ? '目录' : sizeLabel(f.size)}</small>
            </button>`,
        )
        .join('')}</div>`;
    } else if (ui.content?.kind === 'file') {
      viewer = `
        <div class="gh-row" style="margin-top:8px">
          <small class="gh-muted">Commit SHA: <code>${esc(ui.content.commit_sha)}</code></small>
          <button type="button" data-action="copy-file-content">复制文件内容</button>
        </div>
        <pre class="gh-code">${esc(ui.content.content)}</pre>
      `;
    }

    mainArea = `
      <div style="margin-top:10px">
        <button type="button" data-action="back-repo-list">‹ 返回仓库列表</button>
        <div class="gh-repo-heading">
          <strong><button type="button" class="gh-link-btn" data-ext-url="${esc(r.html_url)}">${esc(r.full_name)} ↗</button></strong>
          <span class="gh-badge">${r.private ? '私有' : '公开'}</span>
          <button type="button" data-action="jump-release-repo" style="font-size:12px;padding:3px 9px">去发 Release</button>
          ${isOwner ? `<button type="button" class="gh-danger-btn" style="margin-left:auto;font-size:12px;padding:3px 9px" data-action="open-delete-modal">前往官网删除…</button>` : ''}
        </div>
        <form class="gh-branch" data-form="switch-branch">
          <span class="gh-muted">分支/Tag：</span>
          <input data-bind="ref" value="${esc(ui.ref)}" aria-label="分支或标签" />
          <button type="submit" ${ui.busy ? 'disabled' : ''}>切换</button>
        </form>
        <div class="gh-breadcrumb">
          <span>/${esc(ui.folder)}</span>
          ${ui.folder ? `<button type="button" data-action="up-folder">返回上一级</button>` : ''}
        </div>
        ${viewer}
      </div>
    `;
  } else {
    mainArea = ui.repositories.length
      ? `
        <div class="gh-repositories">
          ${ui.repositories
            .map(
              (r) => `
              <button type="button" class="gh-repo" data-action="select-repo" data-fullname="${esc(r.full_name)}">
                <div class="gh-row">
                  <strong>${esc(r.full_name)}</strong>
                  <span class="gh-badge">${r.private ? '私有' : '公开'}</span>
                </div>
                ${r.description ? `<p>${esc(r.description)}</p>` : ''}
                <small class="gh-muted">默认分支：${esc(r.default_branch)}</small>
              </button>`,
            )
            .join('')}
          ${ui.hasMore ? `<button type="button" data-action="load-more-repos" ${ui.busy ? 'disabled' : ''}>加载更多仓库…</button>` : ''}
        </div>
      `
      : `<div class="gh-empty"><strong>暂无仓库列表</strong><p>点击右上角「刷新仓库」或新建一个 GitHub 仓库。</p></div>`;
  }

  return `
    <div class="gh-row" style="margin-top:12px">
      <h3>${ui.selected ? '仓库文件浏览' : '我的仓库'}</h3>
      <button type="button" class="${ui.createOpen ? '' : 'gh-primary'}" data-action="toggle-create-repo">${ui.createOpen ? '收起新建表单' : '+ 新建仓库'}</button>
    </div>
    ${createFormHtml}
    ${mainArea}
  `;
}

function renderReleasesTab() {
  const st = ui.state;
  if (!st?.user) {
    return `<div class="gh-empty">${githubIconSvg(32)}<strong>登录后管理 Release 发布</strong><p>支持创建版本标签、自动保存更新说明草稿、上传最大 2 GiB 安装包附件。</p></div>`;
  }

  const ownedRepos = ui.repositories.filter((r) => r.owner.toLowerCase() === st.user.login.toLowerCase());
  const releaseAssets = st.attachments || [];

  const editorArea = ui.selected
    ? `
      <form class="gh-form" data-form="create-release">
        <div class="gh-grid">
          <label class="gh-field"><span>版本标签 (Tag)</span><input data-bind="relTag" value="${esc(ui.relTag)}" placeholder="例如 v1.0.0" required /></label>
          <label class="gh-field"><span>目标分支</span><input data-bind="relBranch" value="${esc(ui.relBranch || ui.selected.default_branch)}" required /></label>
        </div>

        <div class="gh-field">
          <div class="gh-ai-label">
            <label for="gh-release-title">版本标题</label>
            <div class="gh-ai-actions">
              <button type="button" data-action="ai-release-title" ${ui.busy ? 'disabled' : ''}>✨ 根据提交记录生成标题</button>
            </div>
          </div>
          <input id="gh-release-title" data-bind="relTitle" value="${esc(ui.relTitle)}" placeholder="例如 v1.0.0 — 首个正式版" />
        </div>

        <div class="gh-field">
          <div class="gh-ai-label">
            <label for="gh-release-body">更新说明 (GitHub Markdown)</label>
            <div class="gh-ai-actions">
              <button type="button" data-action="ai-release-body" ${ui.busy ? 'disabled' : ''}>✨ 根据近期 Commit 汇总更新说明</button>
              ${
                ui.canSendMessage && ui.relAgentPrompt
                  ? `<button type="button" data-action="ask-agent-polish-release">🤖 让当前对话模型润色</button>`
                  : ''
              }
            </div>
          </div>
          <div class="gh-markdown-toolbar">
            <button type="button" data-action="insert-md-code">插入代码块</button>
            <button type="button" data-action="toggle-md-preview">${ui.relPreviewMd ? '返回编辑' : '预览 Markdown'}</button>
          </div>
          ${
            ui.relPreviewMd
              ? `<div class="gh-markdown-preview">${renderSimpleMarkdown(ui.relBody)}</div>`
              : `<textarea id="gh-release-body" data-bind="relBody" rows="7" placeholder="介绍本版本的新增特性、修复问题与升级说明…">${esc(ui.relBody)}</textarea>`
          }
          <small id="gh-rel-draft-status" class="gh-muted">${
            ui.relSavedAt
              ? '发布文案草稿已自动保存 · ' + new Date(ui.relSavedAt).toLocaleTimeString('zh-CN', { hour12: false })
              : '按仓库自动保存标题与更新说明草稿，随时恢复'
          }</small>
        </div>

        <div class="gh-row">
          <div class="gh-actions">
            <label class="gh-check"><input type="checkbox" data-bind-check="relDraft" ${ui.relDraft ? 'checked' : ''} /> 保存为草稿 (Draft)</label>
            <label class="gh-check"><input type="checkbox" data-bind-check="relPrerelease" ${ui.relPrerelease ? 'checked' : ''} /> 预发布 (Pre-release)</label>
          </div>
          <button type="submit" class="gh-primary" ${ui.busy ? 'disabled' : ''}>生成发布预览单</button>
        </div>
      </form>

      <div class="gh-row" style="margin-top:12px">
        <h3>${esc(ui.selected.full_name)} 已有 Releases</h3>
        <button type="button" data-action="refresh-releases" ${ui.busy ? 'disabled' : ''}>刷新版本列表</button>
      </div>
      ${
        ui.releases.length
          ? ui.releases
              .map(
                (rel) => `
                <div class="gh-release">
                  <div class="gh-row">
                    <strong><button type="button" class="gh-link-btn" data-ext-url="${esc(rel.html_url)}">${esc(rel.name || rel.tag_name)} ↗</button></strong>
                    <span class="gh-badge">${esc(rel.tag_name)}${rel.draft ? ' · 草稿' : ''}${rel.prerelease ? ' · 预发布' : ''}</span>
                  </div>
                  ${(rel.assets || [])
                    .map(
                      (a) => `
                      <div class="gh-row" style="font-size:12.5px">
                        <button type="button" class="gh-link-btn" data-ext-url="${esc(a.browser_download_url)}">⬇ ${esc(a.name)}</button>
                        <small class="gh-muted">${sizeLabel(a.size)}</small>
                      </div>`,
                    )
                    .join('')}
                  ${
                    releaseAssets.length
                      ? `
                        <form class="gh-asset-publish" data-form="upload-asset" data-release-id="${rel.id}">
                          <select name="assetId" aria-label="选择已暂存的安装包">
                            ${releaseAssets.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}（${sizeLabel(a.size)}）</option>`).join('')}
                          </select>
                          <button type="submit" ${ui.busy ? 'disabled' : ''}>预览上传到此版本</button>
                        </form>
                      `
                      : ''
                  }
                </div>`,
              )
              .join('')
          : `<p class="gh-muted">该仓库暂无 Release 版本。</p>`
      }
    `
    : `<p class="gh-muted">请先在上方下拉框选择一个你名下的仓库。</p>`;

  return `
    <div style="margin-top:12px">
      <div class="gh-row">
        <h3>选择发布目标仓库</h3>
        ${ui.hasMore ? `<button type="button" data-action="load-more-repos" style="font-size:12px">加载更多仓库</button>` : ''}
      </div>
      <select data-action="change-release-repo" aria-label="发布目标仓库">
        <option value="">-- 请选择个人仓库 --</option>
        ${ownedRepos
          .map(
            (r) =>
              `<option value="${esc(r.full_name)}" ${ui.selected?.full_name === r.full_name ? 'selected' : ''}>${esc(r.full_name)}</option>`,
          )
          .join('')}
      </select>
    </div>
    ${editorArea}

    <section style="margin-top:18px;padding-top:14px;border-top:1px solid var(--gh-line)">
      <div class="gh-row">
        <h3>本机待发布安装包暂存区</h3>
        <button type="button" class="gh-primary" data-action="pick-release-file" ${ui.busy ? 'disabled' : ''}>📦 选择本地安装包 / 压缩包</button>
      </div>
      <p class="gh-muted">支持 .exe、.msi、.dmg、.apk、.zip、.tar.gz 等（单文件最大 2 GiB），后台流式直传 GitHub Releases，不经过前端内存。</p>
      <details class="gh-muted">
        <summary style="cursor:pointer">或直接填写本机安装包路径暂存</summary>
        <div class="gh-path-row">
          <input data-bind="releasePathInput" value="${esc(ui.releasePathInput)}" placeholder="例如 D:\\projects\\dist\\setup-1.0.0.exe" />
          <button type="button" data-action="stage-release-path" ${ui.busy ? 'disabled' : ''}>暂存附件</button>
        </div>
      </details>
      ${
        releaseAssets.length
          ? releaseAssets
              .map(
                (a) => `
                <div class="gh-attachment">
                  <div><strong>${esc(a.name)}</strong><small>${sizeLabel(a.size)}</small></div>
                  <button type="button" data-action="remove-asset" data-id="${esc(a.id)}" ${ui.busy ? 'disabled' : ''}>移除</button>
                </div>`,
              )
              .join('')
          : `<p class="gh-muted">当前暂无已暂存的安装包附件。</p>`
      }
    </section>
  `;
}

function renderOperationsTab() {
  const ops = ui.state?.operations || [];
  const assets = ui.state?.attachments || [];
  if (!ops.length) {
    return `<div class="gh-empty">${githubIconSvg(32)}<strong>暂无待确认或历史操作</strong><p>无论是你在面板里发起，还是让 AI 在聊天里调用创建仓库 / 提交文件 / 创建 Release，都会先在这里生成安全预览单供你确认。</p></div>`;
  }

  return `
    <div style="margin-top:12px">
      ${ops
        .map((op) => {
          const a = op.args || {};
          const att = assets.find((x) => x.id === a.assetId);
          const badgeCls = op.status === 'completed' ? 'gh-success' : op.status === 'failed' ? 'gh-failed' : '';
          const hlCls = op.id === ui.highlightOpId && op.status === 'pending' ? 'gh-op-highlight' : '';

          let detail = '';
          if (op.kind === 'create_repository') {
            detail = `<p class="gh-muted">可见性：<strong>${a.private ? '🔒 私有仓库' : '🌐 公开仓库（所有人可见）'}</strong>${a.description ? `<br/>简介：${esc(a.description)}` : ''}</p>`;
          } else if (op.kind === 'commit_files') {
            detail = `
              <p class="gh-muted">目标分支：<code>${esc(a.branch)}</code> · 基准 SHA：<code>${esc(String(a.baseCommit || '').slice(0, 8))}</code><br/>提交说明：${esc(a.message)}</p>
              ${(a.files || [])
                .map(
                  (f) =>
                    `<details style="margin:6px 0"><summary style="cursor:pointer;font-size:12.5px">📄 ${esc(f.path)}（${sizeLabel(f.content?.length || 0)}）</summary><pre class="gh-code">${esc(f.content)}</pre></details>`,
                )
                .join('')}
            `;
          } else if (op.kind === 'create_release') {
            detail = `
              <p class="gh-muted">标题：${esc(a.name)} · 标签：<code>${esc(a.tag_name)}</code> · 分支：<code>${esc(a.target_commitish)}</code> · ${a.draft ? '草稿' : '正式发布'}${a.prerelease ? '（预发布）' : ''}</p>
              <details open><summary style="cursor:pointer;font-size:12.5px">更新说明预览</summary><pre class="gh-code">${esc(a.body || '（未填写）')}</pre></details>
            `;
          } else if (op.kind === 'upload_asset') {
            detail = `<p class="gh-muted">目标 Release ID：<code>${esc(a.releaseId)}</code><br/>安装包附件：<strong>${esc(att?.name || a.assetId)}</strong> ${att ? `（${sizeLabel(att.size)}）` : ''}</p>`;
          }

          return `
            <article class="gh-operation ${hlCls}">
              <div class="gh-row">
                <strong>${esc(KIND_LABEL[op.kind] || op.kind)}</strong>
                <span class="gh-badge ${badgeCls}">${esc(STATUS_LABEL[op.status] || op.status)}</span>
              </div>
              <div class="gh-target">${op.kind === 'create_repository' ? `${esc(op.account)}/${esc(a.name)}` : `${esc(a.owner)}/${esc(a.repo)}`}</div>
              ${detail}
              ${op.error ? `<p class="gh-error">${esc(op.error)}${op.message ? `<br/>${esc(op.message)}` : ''}</p>` : ''}
              ${op.result?.html_url ? `<p><button type="button" class="gh-link-btn" data-ext-url="${esc(op.result.html_url)}">在 GitHub 查看结果 ↗</button></p>` : ''}
              ${op.result?.browser_download_url ? `<p><button type="button" class="gh-link-btn" data-ext-url="${esc(op.result.browser_download_url)}">下载已发布的附件 ↗</button></p>` : ''}
              ${
                op.status === 'pending'
                  ? `<div class="gh-actions" style="margin-top:10px">
                      <button type="button" class="gh-primary" data-action="confirm-op" data-id="${esc(op.id)}" ${ui.busy ? 'disabled' : ''}>✅ 确认执行${esc(KIND_LABEL[op.kind] || '')}</button>
                      <button type="button" data-action="reject-op" data-id="${esc(op.id)}" ${ui.busy ? 'disabled' : ''}>取消操作</button>
                    </div>`
                  : ''
              }
            </article>
          `;
        })
        .join('')}
      <p class="gh-muted">安全策略：待确认操作有效期为 30 分钟；失败不盲目自动重试，防止重复创建或覆盖。</p>
    </div>
  `;
}

function renderModalZone() {
  const modal = document.getElementById('gh-modal-zone');
  if (!modal) return;
  if (!ui.deleteConfirmOpen || !ui.selected || !ui.state?.user) {
    modal.innerHTML = '';
    return;
  }
  const url = `https://github.com/${encodeURIComponent(ui.selected.owner)}/${encodeURIComponent(ui.selected.name)}/settings#danger-zone`;
  modal.innerHTML = `
    <div class="gh-modal-backdrop" data-action="close-delete-modal">
      <div class="gh-modal-card" onclick="event.stopPropagation()">
        <h3>前往 GitHub 官网删除仓库？</h3>
        <p style="font-weight:600;margin:8px 0">${esc(ui.selected.full_name)}</p>
        <p class="gh-muted">为保护你的代码资产安全，本插件绝不申请 <code>delete_repo</code> 删库权限。确认后将在系统浏览器打开该仓库的 Danger Zone（危险区域）设置页，由你在官网完成最终确认。</p>
        <div class="gh-actions" style="justify-content:flex-end;margin-top:16px">
          <button type="button" data-action="close-delete-modal">取消</button>
          <button type="button" class="gh-danger-solid" data-action="confirm-open-delete" data-url="${esc(url)}">前往官网设置页 ↗</button>
        </div>
      </div>
    </div>
  `;
}

function renderTabZone() {
  ensureShellMounted();
  const zone = document.getElementById('gh-tab-zone');
  if (!zone) return;
  if (ui.tab === 'repos') zone.innerHTML = renderReposTab();
  else if (ui.tab === 'releases') zone.innerHTML = renderReleasesTab();
  else zone.innerHTML = renderOperationsTab();
  renderModalZone();
}

function renderAll() {
  renderHeaderZone();
  renderSearchZone();
  renderTabZone();
}

// Event Delegation on #app-root
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (!t || !(t instanceof HTMLElement)) return;
  const bind = t.getAttribute('data-bind');
  if (bind) {
    ui[bind] = t.value;
    if (bind === 'newRepoName') {
      ui.newRepoNameErr = repositoryNameError(t.value);
      t.setCustomValidity(ui.newRepoNameErr);
    } else if (bind === 'newRepoDesc') {
      scheduleRepoDraftSave();
    } else if (bind === 'relTitle' || bind === 'relBody') {
      scheduleReleaseDraftSave();
    }
    return;
  }
  const filterKey = t.getAttribute('data-filter');
  if (filterKey) {
    ui.searchFilters[filterKey] = t.value;
    ui.searchError = '';
  }
});

document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (!t || !(t instanceof HTMLElement)) return;
  const checkKey = t.getAttribute('data-bind-check');
  if (checkKey && t instanceof HTMLInputElement) {
    ui[checkKey] = t.checked;
    return;
  }
  const bind = t.getAttribute('data-bind');
  if (bind === 'searchType' && t instanceof HTMLSelectElement) {
    ui.searchType = t.value;
    renderSearchZone();
    return;
  }
  const filterKey = t.getAttribute('data-filter');
  if (filterKey && t instanceof HTMLSelectElement) {
    ui.searchFilters[filterKey] = t.value;
    renderSearchZone();
    return;
  }
  if (t.getAttribute('data-action') === 'change-release-repo' && t instanceof HTMLSelectElement) {
    const repo = ui.repositories.find((r) => r.full_name === t.value) || null;
    ui.selected = repo;
    ui.relBranch = repo?.default_branch || 'main';
    ui.releases = [];
    ui.relTitle = '';
    ui.relBody = '';
    ui.relSavedAt = '';
    renderTabZone();
    if (repo) {
      void loadReleaseDraft(repo);
      void act('正在读取版本列表', () => loadReleasesForSelected(repo));
    }
  }
});

document.addEventListener('submit', (ev) => {
  const form = ev.target;
  if (!(form instanceof HTMLFormElement)) return;
  const kind = form.getAttribute('data-form');
  if (!kind) return;
  ev.preventDefault();

  if (kind === 'browser-search') {
    try {
      const res = browserSearch({ query: ui.searchQuery, type: ui.searchType, ...ui.searchFilters });
      ui.searchError = '';
      void openExternal(res.url);
    } catch (e) {
      ui.searchError = e.message;
      renderSearchZone();
    }
    return;
  }

  if (kind === 'oauth-config') {
    const fd = new FormData(form);
    const clientId = String(fd.get('clientId') || '').trim();
    void act('正在保存 OAuth 配置', async () => {
      const next = await rpc('studio_auth', { action: 'configure', clientId });
      ui.clientIdDraft = null;
      mergeServerState(next);
      showToast('OAuth App Client ID 已保存，现在可点击右上角设备码登录');
    });
    return;
  }

  if (kind === 'pat-connect') {
    const fd = new FormData(form);
    const token = String(fd.get('token') || '').trim();
    ui.patDraft = '';
    form.reset();
    void act('正在验证并加密保存令牌', async () => {
      const next = await rpc('studio_auth', { action: 'pat', token });
      mergeServerState(next);
      showToast('GitHub 账号连接成功');
    });
    return;
  }

  if (kind === 'switch-branch' && ui.selected) {
    void act('正在切换分支并读取文件', () => readRepoPath(ui.selected, '', ui.ref));
    return;
  }

  if (kind === 'create-repo') {
    const nameErr = repositoryNameError(ui.newRepoName);
    if (nameErr) {
      ui.newRepoNameErr = nameErr;
      renderTabZone();
      return;
    }
    clearTimeout(repoDraftTimer);
    void act('正在生成创建仓库预览单', async () => {
      const res = await rpc('studio_prepare', {
        kind: 'create_repository',
        args: {
          name: ui.newRepoName.trim(),
          description: ui.newRepoDesc,
          private: ui.newRepoPrivate,
        },
      });
      mergeServerState(res.state);
      ui.highlightOpId = res.operationId || '';
      ui.tab = 'operations';
      ui.newRepoName = '';
      ui.newRepoDesc = '';
      ui.newRepoSavedAt = '';
    });
    return;
  }

  if (kind === 'create-release' && ui.selected) {
    clearTimeout(releaseDraftTimer);
    const repo = ui.selected;
    void act('正在生成 Release 预览单', async () => {
      const res = await rpc('studio_prepare', {
        kind: 'create_release',
        args: {
          owner: repo.owner,
          repo: repo.name,
          tag_name: ui.relTag.trim(),
          name: (ui.relTitle || ui.relTag).trim(),
          body: ui.relBody,
          target_commitish: (ui.relBranch || repo.default_branch).trim(),
          draft: ui.relDraft,
          prerelease: ui.relPrerelease,
        },
      });
      mergeServerState(res.state);
      ui.highlightOpId = res.operationId || '';
      ui.tab = 'operations';
      ui.relSavedAt = '';
    });
    return;
  }

  if (kind === 'upload-asset' && ui.selected) {
    const releaseId = Number(form.getAttribute('data-release-id'));
    const fd = new FormData(form);
    const assetId = String(fd.get('assetId') || '');
    const repo = ui.selected;
    void act('正在生成附件上传预览单', async () => {
      const res = await rpc('studio_prepare', {
        kind: 'upload_asset',
        args: { owner: repo.owner, repo: repo.name, releaseId, assetId },
      });
      mergeServerState(res.state);
      ui.highlightOpId = res.operationId || '';
      ui.tab = 'operations';
    });
  }
});

document.addEventListener('click', (ev) => {
  const el = ev.target instanceof HTMLElement ? ev.target.closest('[data-ext-url], [data-action]') : null;
  if (!el) return;

  const extUrl = el.getAttribute('data-ext-url');
  if (extUrl) {
    ev.preventDefault();
    void openExternal(extUrl);
    return;
  }

  const action = el.getAttribute('data-action');
  if (!action) return;

  if (action === 'clear-error') {
    ui.error = '';
    renderHeaderZone();
  } else if (action === 'copy-url') {
    void copyText(el.getAttribute('data-url') || '', '地址');
  } else if (action === 'copy-device-code') {
    void copyText(el.getAttribute('data-code') || '', '设备码');
  } else if (action === 'auth-start') {
    if (!ui.state?.clientId) {
      ui.oauthDetailsOpen = true;
      renderHeaderZone();
      const input = document.getElementById('gh-oauth-clientid-input');
      if (input) input.focus();
      showToast('请先填写并保存 OAuth App Client ID，或使用下方令牌快速连接');
      return;
    }
    void act('正在启动 GitHub 设备授权', async () => {
      const next = await rpc('studio_auth', { action: 'start' });
      mergeServerState(next);
    });
  } else if (action === 'auth-cancel') {
    void act('正在取消登录', async () => {
      const next = await rpc('studio_auth', { action: 'cancel' });
      mergeServerState(next);
    });
  } else if (action === 'logout') {
    void act('正在断开连接', async () => {
      const next = await rpc('studio_auth', { action: 'logout' });
      mergeServerState(next);
      showToast('已断开本机 GitHub 连接');
    });
  } else if (action === 'switch-tab') {
    const nextTab = el.getAttribute('data-tab') || 'repos';
    ui.tab = nextTab;
    renderHeaderZone();
    renderTabZone();
    if (nextTab === 'releases' && ui.selected) {
      void loadReleaseDraft(ui.selected);
      void act('正在读取版本列表', () => loadReleasesForSelected(ui.selected));
    }
  } else if (action === 'refresh-repos') {
    void act('正在刷新仓库列表', () => loadRepos(1));
  } else if (action === 'load-more-repos') {
    void act('正在加载更多仓库', () => loadRepos(ui.page + 1));
  } else if (action === 'toggle-create-repo') {
    ui.createOpen = !ui.createOpen;
    if (ui.createOpen) void loadRepoDraft();
    renderTabZone();
  } else if (action === 'select-repo') {
    const fullName = el.getAttribute('data-fullname');
    const repo = ui.repositories.find((r) => r.full_name === fullName);
    if (repo) void act('正在读取仓库目录', () => openRepository(repo));
  } else if (action === 'back-repo-list') {
    ui.selected = null;
    ui.content = null;
    renderTabZone();
  } else if (action === 'open-entry' && ui.selected) {
    const p = el.getAttribute('data-path') || '';
    void act('正在读取内容', () => readRepoPath(ui.selected, p));
  } else if (action === 'up-folder' && ui.selected) {
    const parent = ui.folder.split('/').slice(0, -1).join('/');
    void act('正在返回上级目录', () => readRepoPath(ui.selected, parent));
  } else if (action === 'copy-file-content' && ui.content?.content) {
    void copyText(ui.content.content, '文件内容');
  } else if (action === 'jump-release-repo' && ui.selected) {
    ui.tab = 'releases';
    renderHeaderZone();
    renderTabZone();
    void loadReleaseDraft(ui.selected);
    void act('正在读取版本列表', () => loadReleasesForSelected(ui.selected));
  } else if (action === 'open-delete-modal') {
    ui.deleteConfirmOpen = true;
    renderModalZone();
  } else if (action === 'close-delete-modal') {
    ui.deleteConfirmOpen = false;
    renderModalZone();
  } else if (action === 'confirm-open-delete') {
    const url = el.getAttribute('data-url') || '';
    ui.deleteConfirmOpen = false;
    renderModalZone();
    void openExternal(url);
  } else if (action === 'pick-intro-files') {
    void act('等待选择源码或说明文件', async () => {
      const res = await rpc('studio_pick_files', { purpose: 'intro', multiple: true });
      mergeServerState(res.state);
      if (!res.cancelled) showToast(`已导入 ${res.staged?.length || 0} 个源码/说明文件`);
    });
  } else if (action === 'stage-intro-path') {
    if (!ui.introPathInput.trim()) return;
    void act('正在读取本地文件', async () => {
      const res = await rpc('studio_stage_path', { filePath: ui.introPathInput.trim(), purpose: 'intro' });
      mergeServerState(res.state);
      ui.introPathInput = '';
      showToast('源码文件已添加');
    });
  } else if (action === 'pick-release-file') {
    void act('等待选择待发布安装包', async () => {
      const res = await rpc('studio_pick_files', { purpose: 'release', multiple: false });
      mergeServerState(res.state);
      if (!res.cancelled) showToast('安装包已暂存到本机待发布区');
    });
  } else if (action === 'stage-release-path') {
    if (!ui.releasePathInput.trim()) return;
    void act('正在暂存本地安装包', async () => {
      const res = await rpc('studio_stage_path', { filePath: ui.releasePathInput.trim(), purpose: 'release' });
      mergeServerState(res.state);
      ui.releasePathInput = '';
      showToast('安装包已暂存');
    });
  } else if (action === 'remove-asset') {
    const id = el.getAttribute('data-id') || '';
    void act('正在移除暂存文件', async () => {
      const next = await rpc('studio_remove_attachment', { id });
      mergeServerState(next);
    });
  } else if (action === 'ai-describe-program') {
    const ids = (ui.state?.introAttachments || []).map((f) => f.id);
    void act('正在分析源码结构生成介绍', async () => {
      const res = await rpc('studio_ai_copy', {
        mode: 'program',
        assetIds: ids,
        repoName: ui.newRepoName,
        existingDescription: ui.newRepoDesc,
      });
      ui.newRepoDesc = res.text || '';
      ui.newRepoReadFiles = res.readFiles || [];
      ui.newRepoAgentPrompt = res.agentPrompt || '';
      ui.newRepoSavedAt = new Date().toISOString();
      showToast('已根据源码结构生成简介草稿');
    });
  } else if (action === 'ai-release-title' && ui.selected) {
    void act('正在分析近期提交生成版本标题', async () => {
      const res = await rpc('studio_ai_copy', {
        mode: 'release',
        owner: ui.selected.owner,
        repo: ui.selected.name,
        kind: 'title',
        tag: ui.relTag,
        branch: ui.relBranch || ui.selected.default_branch,
        title: ui.relTitle,
        body: ui.relBody,
      });
      ui.relTitle = res.text || '';
      ui.relAgentPrompt = res.agentPrompt || '';
      ui.relSavedAt = new Date().toISOString();
      showToast('版本标题已生成并保存草稿');
    });
  } else if (action === 'ai-release-body' && ui.selected) {
    void act('正在汇总仓库近期提交生成更新说明', async () => {
      const res = await rpc('studio_ai_copy', {
        mode: 'release',
        owner: ui.selected.owner,
        repo: ui.selected.name,
        kind: 'body',
        tag: ui.relTag,
        branch: ui.relBranch || ui.selected.default_branch,
        title: ui.relTitle,
        body: ui.relBody,
      });
      ui.relBody = res.text || '';
      ui.relAgentPrompt = res.agentPrompt || '';
      ui.relSavedAt = new Date().toISOString();
      showToast('Markdown 更新说明已生成并保存草稿');
    });
  } else if (action === 'ask-agent-polish-repo' && ui.newRepoAgentPrompt) {
    void (async () => {
      try {
        await app.sendMessage({ role: 'user', content: [{ type: 'text', text: ui.newRepoAgentPrompt }] });
        showToast('已发送到对话让当前模型撰写，完成后将自动同步回草稿箱');
      } catch (e) {
        showToast(e.message || '当前视图不支持直接发送会话消息');
      }
    })();
  } else if (action === 'ask-agent-polish-release' && ui.relAgentPrompt) {
    void (async () => {
      try {
        await app.sendMessage({ role: 'user', content: [{ type: 'text', text: ui.relAgentPrompt }] });
        showToast('已发送到对话让当前模型润色更新说明');
      } catch (e) {
        showToast(e.message || '当前视图不支持直接发送会话消息');
      }
    })();
  } else if (action === 'insert-md-code') {
    ui.relBody = (ui.relBody ? ui.relBody + '\n' : '') + '```bash\n# 在这里填写安装或运行命令\n```\n';
    ui.relPreviewMd = false;
    scheduleReleaseDraftSave();
    renderTabZone();
  } else if (action === 'toggle-md-preview') {
    ui.relPreviewMd = !ui.relPreviewMd;
    renderTabZone();
  } else if (action === 'refresh-releases' && ui.selected) {
    void act('正在刷新版本列表', () => loadReleasesForSelected(ui.selected));
  } else if (action === 'confirm-op') {
    const id = el.getAttribute('data-id') || '';
    void act('正在向 GitHub 执行确认操作', async () => {
      const res = await rpc('studio_confirm', { id });
      mergeServerState(res.state);
      const op = res.operation;
      if (op?.status === 'failed') throw Error(op.error || '执行失败');
      showToast('已在 GitHub 执行完成！');
      // Fix upstream Bug #5: auto-refresh affected repo/release/content views after confirmation!
      if (op?.kind === 'create_repository') {
        await loadRepos(1);
      } else if ((op?.kind === 'create_release' || op?.kind === 'upload_asset') && ui.selected) {
        await loadReleasesForSelected(ui.selected);
      } else if (op?.kind === 'commit_files' && ui.selected) {
        await readRepoPath(ui.selected, ui.folder, ui.ref);
      }
    });
  } else if (action === 'reject-op') {
    const id = el.getAttribute('data-id') || '';
    void act('正在取消待确认操作', async () => {
      const res = await rpc('studio_reject', { id });
      mergeServerState(res.state);
      showToast('已取消该待确认操作');
    });
  }
});

document.addEventListener(
  'toggle',
  (ev) => {
    const t = ev.target;
    if (t instanceof HTMLDetailsElement) {
      const key = t.getAttribute('data-details');
      if (key === 'oauth') ui.oauthDetailsOpen = t.open;
      else if (key === 'pat') ui.patDetailsOpen = t.open;
    }
  },
  true,
);

// MCP App Host Lifecycle & Background Polling (Non-Destructive to Active Form Inputs!)
function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
}

app.ontoolinput = ({ arguments: args }) => {
  if (args?.tab && ['repos', 'releases', 'operations'].includes(args.tab)) {
    ui.tab = args.tab;
  }
};

app.ontoolresult = (result) => {
  const payload = result?.structuredContent;
  if (payload && ('hasCredential' in payload || 'operations' in payload)) {
    mergeServerState(payload);
    renderAll();
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

async function pollStateSilently() {
  if (pollInFlight || ui.busy) return;
  pollInFlight = true;
  try {
    const prevOpsJson = JSON.stringify(ui.state?.operations || []);
    const prevLoginJson = JSON.stringify(ui.state?.login || {});
    const prevUserId = ui.state?.user?.id || null;
    const next = await rpc('studio_state');
    mergeServerState(next);
    const nextOpsJson = JSON.stringify(ui.state?.operations || []);
    const nextLoginJson = JSON.stringify(ui.state?.login || {});
    const nextUserId = ui.state?.user?.id || null;

    if (prevLoginJson !== nextLoginJson || prevUserId !== nextUserId || prevOpsJson !== nextOpsJson) {
      renderHeaderZone();
      if (ui.tab === 'operations' && prevOpsJson !== nextOpsJson) {
        renderTabZone();
      }
    }
  } catch {
    /* ignore background poll transient errors */
  } finally {
    pollInFlight = false;
  }
}

async function init() {
  try {
    await app.connect();
    applyHostContext(app.getHostContext());
    const caps = app.getHostCapabilities();
    ui.canSendMessage = Boolean(caps?.message);
  } catch (err) {
    console.error('[github-studio] connect error:', err);
  }

  setTimeout(async () => {
    if (!ui.state) {
      try {
        const initial = await rpc('studio_state');
        mergeServerState(initial);
        renderAll();
      } catch (e) {
        ui.error = e.message || String(e);
        renderAll();
      }
    }
  }, 120);

  pollTimer = setInterval(pollStateSilently, 3500);
}

void init();
