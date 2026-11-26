import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inspectProgram } from './program-inspect.mjs';
import { enc, encodeRefSegments } from './core.mjs';

const safeSeg = (s) =>
  String(s ?? '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80) || 'draft';

function extractStructuredHints(files) {
  let pkgDesc = '';
  let readmeLead = '';
  const langs = new Set();

  for (const f of files) {
    const low = f.path.toLowerCase();
    if (/\.(ts|tsx)$/.test(low)) langs.add('TypeScript');
    else if (/\.(js|mjs|cjs|jsx)$/.test(low)) langs.add('JavaScript / Node.js');
    else if (/\.py$/.test(low)) langs.add('Python');
    else if (/\.go$/.test(low)) langs.add('Go');
    else if (/\.rs$/.test(low)) langs.add('Rust');
    else if (/\.(java|kt)$/.test(low)) langs.add('JVM');
    else if (/\.(c|cpp|h|hpp)$/.test(low)) langs.add('C/C++');
    else if (/\.cs$/.test(low)) langs.add('C#');

    if ((low === 'package.json' || low.endsWith('/package.json')) && !pkgDesc) {
      try {
        const pkg = JSON.parse(f.text);
        if (typeof pkg.description === 'string' && pkg.description.trim()) {
          pkgDesc = pkg.description.trim();
        }
      } catch {}
    }
    if ((low.endsWith('readme.md') || low.endsWith('readme.txt') || low === 'readme') && !readmeLead) {
      const lines = f.text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(
          (l) =>
            l &&
            !l.startsWith('#') &&
            !l.startsWith('![') &&
            !l.startsWith('[!') &&
            !l.startsWith('<img') &&
            !l.startsWith('```') &&
            !l.startsWith('> [!'),
        );
      if (lines.length > 0) {
        readmeLead = lines
          .slice(0, 2)
          .join(' ')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/[*_`]+/g, '')
          .trim();
      }
    }
  }

  return { pkgDesc, readmeLead, langs: [...langs] };
}

export class StudioCopyService {
  constructor({ api, root, ops, drafts }) {
    this.api = api;
    this.root = root;
    this.ops = ops;
    this.drafts = drafts;
  }

  async describeProgram({ assetIds, repoName = '', existingDescription = '' } = {}) {
    const evidence = await inspectProgram(this.ops, assetIds);
    const wsDir = path.join(this.root, 'workspace', 'program-analysis', `${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(wsDir, { recursive: true });

    const evidenceFile = path.join(wsDir, 'evidence.json');
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          repositoryName: String(repoName ?? '').slice(0, 100),
          existingDescription: String(existingDescription ?? '').slice(0, 350),
          ...evidence,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const { pkgDesc, readmeLead, langs } = extractStructuredHints(evidence.files);
    const techTag = langs.length ? `基于 ${langs.slice(0, 3).join('、')} 构建` : '';
    const fileSample = evidence.readFiles
      .slice(0, 4)
      .map((p) => path.posix.basename(p))
      .join('、');

    let summary = '';
    if (pkgDesc && readmeLead && pkgDesc !== readmeLead) {
      summary = `${pkgDesc.replace(/[。.]$/, '')}。${readmeLead}`;
    } else if (readmeLead) {
      summary = readmeLead;
    } else if (pkgDesc) {
      summary = `${pkgDesc.replace(/[。.]$/, '')}${techTag ? `（${techTag}）` : ''}。`;
    } else {
      const targetName = String(repoName || '').trim() || '该项目';
      summary = `${targetName}${techTag ? `（${techTag}）` : ''}，包含 ${fileSample} 等 ${evidence.readFiles.length} 个源码模块。`;
    }

    summary = summary.replace(/\s+/g, ' ').trim().slice(0, 340);
    const draftPath = path.join(wsDir, 'program-introduction.md');
    await writeFile(draftPath, summary + '\n', { mode: 0o600 });

    if (this.drafts) {
      await this.drafts.save({ kind: 'repository', description: summary });
    }

    const agentPrompt = `请读取源码证据文件 ${evidenceFile}，只依据其中真实读取到的代码与说明文件（严禁编造未验证功能），为 GitHub 仓库${repoName ? `「${repoName}」` : ''}撰写一段 80～180 字的自然中文纯文本简介（不超过 340 字符，不要标题和 Markdown），然后调用 github_save_draft 工具（kind="repository"）写回草稿箱。`;

    return {
      text: summary,
      draftPath,
      evidenceFile,
      workspacePath: wsDir,
      readFiles: evidence.readFiles,
      model: '源码结构提取（可点右侧呼叫当前模型精修）',
      agentPrompt,
    };
  }

  async createReleaseCopy({ owner, repo, kind, tag = '', branch = '', title = '', body = '' } = {}) {
    if (!['title', 'body'].includes(kind)) throw Error('生成类型无效。');
    if (typeof owner !== 'string' || !owner.trim() || typeof repo !== 'string' || !repo.trim()) {
      throw Error('缺少目标仓库信息。');
    }

    const base = `/repos/${enc(owner.trim())}/${enc(repo.trim())}`;
    const metadata = await this.api.request(base);
    const targetBranch = (branch && branch.trim()) || metadata.default_branch;
    const encodedRef = encodeRefSegments(targetBranch, '目标分支');

    let readme = '';
    let readmeAvailable = false;
    try {
      const r = await this.api.request(`${base}/readme?ref=${enc(targetBranch)}`);
      if (r.encoding === 'base64') {
        readme = Buffer.from(r.content, 'base64').toString('utf8').slice(0, 10000);
        readmeAvailable = true;
      }
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    const commits = await this.api.request(`${base}/commits?sha=${encodedRef}&per_page=15`);
    const commitItems = (Array.isArray(commits) ? commits : []).map((c) => ({
      sha: String(c.sha ?? '').slice(0, 7),
      subject: String(c.commit?.message ?? '')
        .split(/\r?\n/)[0]
        .trim()
        .slice(0, 200),
      fullMessage: String(c.commit?.message ?? '').slice(0, 700),
    }));

    const wsDir = path.join(this.root, 'workspace', 'releases', safeSeg(owner), safeSeg(repo), safeSeg(tag || 'next'));
    await mkdir(wsDir, { recursive: true });
    const evidenceFile = path.join(wsDir, 'release-evidence.json');
    await writeFile(
      evidenceFile,
      JSON.stringify(
        {
          repository: metadata.full_name ?? `${owner}/${repo}`,
          description: metadata.description,
          license: metadata.license?.spdx_id ?? null,
          branch: targetBranch,
          tag: tag || '未指定',
          readmeAvailable,
          readme,
          commits: commitItems,
          existingTitle: title,
          existingBody: body,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    let generated = '';
    const verLabel = tag && tag.trim() ? tag.trim() : '新版本';
    if (kind === 'title') {
      const topFeat = commitItems.find((c) => /^feat(\([^)]+\))?:/i.test(c.subject));
      const topFix = commitItems.find((c) => /^fix(\([^)]+\))?:/i.test(c.subject));
      const highlight = topFeat
        ? topFeat.subject.replace(/^feat(\([^)]+\))?:\s*/i, '')
        : topFix
          ? topFix.subject.replace(/^fix(\([^)]+\))?:\s*/i, '')
          : metadata.description || commitItems[0]?.subject || `${repo} 版本发布`;
      generated = `${verLabel} — ${highlight}`.slice(0, 120);
    } else {
      const feats = [];
      const fixes = [];
      const others = [];
      for (const c of commitItems) {
        if (!c.subject || /^chore\(release\)|^merge pull request/i.test(c.subject)) continue;
        const line = `- ${c.subject} (\`${c.sha}\`)`;
        if (/^feat(\([^)]+\))?:/i.test(c.subject)) feats.push(line);
        else if (/^fix(\([^)]+\))?:/i.test(c.subject)) fixes.push(line);
        else others.push(line);
      }
      const sections = [];
      if (metadata.description) {
        sections.push(`> ${metadata.description.trim()}`);
      }
      if (feats.length) sections.push(`### 新增功能\n${feats.join('\n')}`);
      if (fixes.length) sections.push(`### 问题修复\n${fixes.join('\n')}`);
      if (others.length) sections.push(`### 其他改进与维护\n${others.join('\n')}`);
      if (!feats.length && !fixes.length && !others.length && readme) {
        const intro = readme
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !l.startsWith('!['))
          .slice(0, 4)
          .map((l) => `- ${l}`)
          .join('\n');
        if (intro) sections.push(`### 版本概述\n${intro}`);
      }
      generated = sections.join('\n\n').trim() || `### ${verLabel} 更新说明\n- 初始版本整理发布`;
    }

    const nextTitle = kind === 'title' ? generated : title;
    const nextBody = kind === 'body' ? generated : body;
    const draftJsonFile = path.join(wsDir, 'release-draft.json');
    const draftPayload = {
      owner,
      repo,
      tag,
      branch: targetBranch,
      title: nextTitle,
      body: nextBody,
      updatedAt: new Date().toISOString(),
    };
    const tmp = draftJsonFile + '.tmp';
    await writeFile(tmp, JSON.stringify(draftPayload, null, 2), { mode: 0o600 });
    await rename(tmp, draftJsonFile);
    const mdFile = path.join(wsDir, 'release-draft.md');
    await writeFile(mdFile, `# ${nextTitle || verLabel}\n\n${nextBody}\n`, { mode: 0o600 });

    if (this.drafts) {
      await this.drafts.save({ kind: 'release', owner, repo, title: nextTitle, body: nextBody });
    }

    const agentPrompt = `请读取发布证据文件 ${evidenceFile}，严格依据其中的仓库 README 和真实提交记录（不编造未验证功能），为仓库 ${owner}/${repo}（标签 ${verLabel}，分支 ${targetBranch}）撰写中文 Release 版本标题与 GitHub Markdown 更新说明，并调用 github_save_draft 工具（kind="release", owner="${owner}", repo="${repo}"）保存回草稿箱。`;

    return {
      kind,
      text: generated,
      draftPath: mdFile,
      evidenceFile,
      workspacePath: wsDir,
      agentPrompt,
    };
  }
}
