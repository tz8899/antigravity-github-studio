import { command } from './credential-store.mjs';

/**
 * Opens a native OS file-open dialog in the background MCP server process so the user can pick
 * arbitrary local files (including multi-hundred-MB or up to 2 GiB Release installers) without
 * passing megabytes through the sandboxed MCP App iframe postMessage channel.
 */
export async function pickLocalFiles({ multiple = false, purpose = 'release' } = {}) {
  const title =
    purpose === 'intro'
      ? '选择用于生成介绍的源码、README 或源码 ZIP'
      : '选择待上传到 GitHub Release 的安装包或压缩包';

  if (process.platform === 'win32') {
    const filter =
      purpose === 'intro'
        ? '源码与说明文件 (*.zip;*.md;*.txt;*.js;*.mjs;*.ts;*.tsx;*.jsx;*.py;*.go;*.rs;*.json)|*.zip;*.md;*.txt;*.js;*.mjs;*.ts;*.tsx;*.jsx;*.py;*.go;*.rs;*.json|所有文件 (*.*)|*.*'
        : '发布包与压缩包 (*.zip;*.exe;*.msi;*.7z;*.tar.gz;*.dmg;*.pkg;*.deb;*.rpm;*.apk;*.AppImage)|*.zip;*.exe;*.msi;*.7z;*.tar.gz;*.dmg;*.pkg;*.deb;*.rpm;*.apk;*.AppImage|所有文件 (*.*)|*.*';

    const psScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$owner.Opacity = 0
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = ${JSON.stringify(title)}
$dlg.Filter = ${JSON.stringify(filter)}
$dlg.Multiselect = $${multiple ? 'true' : 'false'}
$res = $dlg.ShowDialog($owner)
$owner.Dispose()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
  ConvertTo-Json -Compress @($dlg.FileNames)
} else {
  Write-Output '[]'
}
`;
    const r = await command(
      'powershell.exe',
      ['-NoProfile', '-Sta', '-Command', psScript],
      { timeout: 5 * 60 * 1000 },
    );
    if (r.code !== 0) throw Error('打开 Windows 文件选择框失败，可改用下方本地路径输入框直接添加。');
    const out = r.stdout.trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p.trim()) : [];
  }

  if (process.platform === 'darwin') {
    const multiClause = multiple ? ' with multiple selections allowed' : '';
    const osa = `
try
  set picked to choose file with prompt ${JSON.stringify(title)}${multiClause}
  if class of picked is list then
    set out to ""
    repeat with f in picked
      set out to out & POSIX path of f & linefeed
    end repeat
    return out
  else
    return POSIX path of picked
  end if
on error number -128
  return ""
end try
`;
    const r = await command('/usr/bin/osascript', ['-e', osa], { timeout: 5 * 60 * 1000 });
    if (r.code !== 0) throw Error('打开 macOS 文件选择框失败，可改用下方本地路径输入框直接添加。');
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Linux desktop fallback (zenity -> kdialog); on headless SSH Remote, guide to path input
  for (const [bin, args] of [
    ['zenity', ['--file-selection', `--title=${title}`, ...(multiple ? ['--multiple', '--separator=\n'] : [])]],
    ['kdialog', ['--getopenfilename', '.', '*', ...(multiple ? ['--multiple', '--separate-output'] : [])]],
  ]) {
    try {
      const r = await command(bin, args, { timeout: 5 * 60 * 1000 });
      if (r.code === 0) {
        return r.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (r.code === 1) return [];
    } catch {}
  }

  throw Error('当前无图形文件对话框（如 SSH 远程环境），请直接在下方「本地文件路径」输入框填入路径添加。');
}

export async function copyTextToSystemClipboard(text) {
  const val = String(text ?? '');
  if (!val || val.length > 64 * 1024) throw Error('剪贴板文本为空或过长。');
  if (process.platform === 'win32') {
    const r = await command(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
      { input: val, timeout: 8000 },
    );
    if (r.code === 0) return { ok: true };
  } else if (process.platform === 'darwin') {
    const r = await command('/usr/bin/pbcopy', [], { input: val, timeout: 8000 });
    if (r.code === 0) return { ok: true };
  } else {
    for (const [bin, args] of [
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
      ['wl-copy', []],
    ]) {
      try {
        const r = await command(bin, args, { input: val, timeout: 5000 });
        if (r.code === 0) return { ok: true };
      } catch {}
    }
  }
  throw Error('系统剪贴板调用失败，请手动选中复制。');
}
