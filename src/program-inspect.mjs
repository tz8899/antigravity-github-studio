import { inflateRawSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_SOURCES = 24;
const MAX_TOTAL = 512 * 1024;
const MAX_ENTRY = 200 * 1024;
const MAX_ZIP = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;

const TEXT_TYPES =
  /\.(md|markdown|txt|py|js|mjs|cjs|ts|tsx|jsx|java|kt|kts|go|rs|c|h|cpp|hpp|cs|swift|rb|php|sh|bash|bat|cmd|ps1|html|htm|css|scss|json|ya?ml|toml|xml|gradle|properties|ini|cfg|conf|vue|svelte|sql|lua|dart|r|pl)$/i;
const BLOCKED_DIR =
  /(^|\/)(node_modules|\.git|\.svn|vendor|build|dist|out|target|\.venv|venv|__pycache__|\.next|coverage)\//i;
const BLOCKED_FILE =
  /(^|\/)(\.env[^/]*|id_rsa|id_ed25519|credentials[^/]*|\.npmrc|\.netrc|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const SECRET_RE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16})/;

const clean = (n) => String(n ?? '').replace(/\\/g, '/').replace(/^\/+/, '');

export function isUnsafeZipEntryName(rawName) {
  const s = String(rawName ?? '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || /[\x00-\x1f]/.test(s)) return true;
  return s.split('/').some((seg) => seg === '..');
}

const safeName = (n) =>
  clean(n)
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')
    .slice(0, 300);

const readable = (n) => {
  const p = safeName(n);
  return !!p && TEXT_TYPES.test(p) && !BLOCKED_DIR.test(p.toLowerCase()) && !BLOCKED_FILE.test(p.toLowerCase());
};

const decodeText = (b) => {
  if (b.includes(0)) return null;
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(b);
      return SECRET_RE.test(text) ? null : text;
    } catch {}
  }
  return null;
};

/**
 * Pure Node.js Central-Directory ZIP reader with zip-slip, encrypted-entry, and zip-bomb protection.
 */
export function extractZipTexts(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw Error('ZIP 无法读取或已损坏，请重新打包为标准 ZIP。');
  }
  const minSearch = Math.max(0, buffer.length - 65557);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minSearch; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw Error('ZIP 无法读取或已损坏，请重新打包为标准 ZIP。');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocdOffset) {
    throw Error('不支持 ZIP64 或损坏的压缩目录，请提供精简源码 ZIP。');
  }

  const files = [];
  const names = [];
  let totalBytes = 0;
  let count = 0;
  let ptr = cdOffset;
  const cdEnd = cdOffset + cdSize;

  while (ptr + 46 <= cdEnd && count < totalEntries) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw Error('ZIP 目录结构损坏，读取失败。');
    }
    count++;
    if (count > MAX_ENTRIES) break;

    const flags = buffer.readUInt16LE(ptr + 8);
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const uncompSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHdrOffset = buffer.readUInt32LE(ptr + 42);

    const nameEnd = ptr + 46 + nameLen;
    if (nameEnd > cdEnd) throw Error('ZIP 条目头越界，读取失败。');
    const rawEntryName = buffer.subarray(ptr + 46, nameEnd).toString('utf8');
    ptr = nameEnd + extraLen + commentLen;

    if (rawEntryName.endsWith('/')) continue;
    if (isUnsafeZipEntryName(rawEntryName)) {
      throw Error('ZIP 内含不安全的文件路径，已拒绝读取。');
    }

    const name = safeName(rawEntryName);
    if (name && names.length < 120) names.push(name);
    if (files.length >= MAX_SOURCES || totalBytes >= MAX_TOTAL) break;

    // Skip encrypted entries, unsupported compression methods, or oversized entries
    if (
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      !readable(name) ||
      uncompSize > MAX_ENTRY ||
      totalBytes + uncompSize > MAX_TOTAL
    ) {
      continue;
    }

    if (localHdrOffset + 30 > buffer.length || buffer.readUInt32LE(localHdrOffset) !== 0x04034b50) {
      throw Error('ZIP 本地文件头损坏，读取失败。');
    }
    const localNameLen = buffer.readUInt16LE(localHdrOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHdrOffset + 28);
    const dataStart = localHdrOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) {
      throw Error('ZIP 条目内容截断，读取失败。');
    }

    const slice = buffer.subarray(dataStart, dataEnd);
    let rawContent;
    try {
      rawContent =
        method === 0
          ? slice
          : inflateRawSync(slice, {
              maxOutputLength: Math.min(MAX_ENTRY, MAX_TOTAL - totalBytes),
            });
    } catch (err) {
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw Error('ZIP 条目解压后超出安全读取上限，请提供精简源码。');
      }
      throw Error('ZIP 文本解压读取失败。');
    }

    if (rawContent.length > MAX_ENTRY || totalBytes + rawContent.length > MAX_TOTAL) {
      throw Error('ZIP 条目超出读取上限，请提供精简源码。');
    }
    totalBytes += rawContent.length;
    const decoded = decodeText(rawContent);
    if (decoded?.trim()) {
      files.push({ path: name, text: decoded });
    }
  }

  return { files, names };
}

export async function inspectProgram(ops, assetIds) {
  if (
    !Array.isArray(assetIds) ||
    assetIds.length < 1 ||
    assetIds.length > 10 ||
    assetIds.some((x) => typeof x !== 'string')
  ) {
    throw Error('请先传入 1～10 个程序或源码文件。');
  }
  const uploadedFiles = [];
  const sources = [];
  let bytes = 0;

  for (const id of new Set(assetIds)) {
    const asset = ops.assets.get(id);
    if (!asset) throw Error('传入文件已不存在，请重新选择传入。');
    const info = await stat(asset.diskPath);
    if (info.size !== asset.size) throw Error('暂存文件已变化，请重新传入。');
    uploadedFiles.push({ name: asset.name, size: asset.size });

    if (/\.zip$/i.test(asset.name)) {
      if (asset.size > MAX_ZIP) {
        throw Error('用于 AI 读取的 ZIP 不能超过 32 MiB，请提供精简源码或 README。');
      }
      const parsed = extractZipTexts(await readFile(asset.diskPath));
      for (const file of parsed.files) {
        const size = Buffer.byteLength(file.text);
        if (sources.length >= MAX_SOURCES || bytes + size > MAX_TOTAL) break;
        sources.push({ path: asset.name + '/' + file.path, text: file.text });
        bytes += size;
      }
    } else if (readable(asset.name) && asset.size <= MAX_ENTRY) {
      const text = decodeText(await readFile(asset.diskPath));
      if (text?.trim() && sources.length < MAX_SOURCES && bytes + Buffer.byteLength(text) <= MAX_TOTAL) {
        sources.push({ path: safeName(asset.name), text });
        bytes += Buffer.byteLength(text);
      }
    }
  }

  if (!sources.length) {
    throw Error(
      '没有可供阅读的源码或说明文件。仅凭 exe、msi、apk 等二进制安装包无法可靠判断功能，请补充源码 ZIP、代码文件或 README。',
    );
  }

  let remaining = 28000;
  const files = sources
    .map((f) => {
      const text = f.text.slice(0, Math.min(6000, remaining));
      remaining -= text.length;
      return { path: f.path, text };
    })
    .filter((f) => f.text);

  return {
    uploadedFiles,
    files,
    readFiles: files.map((f) => f.path),
    notice: '仅读取了列出的文本源码与说明，未运行任何可执行文件；请勿根据文件名凭空编造未验证的功能。',
  };
}
