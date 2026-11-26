import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'ui.js')],
    bundle: true,
    write: false,
    format: 'esm',
    target: ['es2022'],
    minify: true,
    platform: 'browser',
  });

  const jsCode = result.outputFiles[0].text;
  const cssCode = fs.readFileSync(path.join(root, 'src', 'ui.css'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'src', 'ui-template.html'), 'utf8');

  const safeJs = jsCode.replace(/<\/script/gi, '<\\/script');
  const html = template
    .replace('/* __INLINE_CSS__ */', () => cssCode)
    .replace('/* __INLINE_JS__ */', () => safeJs);

  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, 'studio.html');
  fs.writeFileSync(outPath, html, 'utf8');

  const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`Built single-file GitHub Studio MCP App UI: ${outPath} (${sizeKb} KB)`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
