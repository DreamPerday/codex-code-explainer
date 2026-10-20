import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const plugin = path.join(dist, 'plugin');
await mkdir(path.join(plugin, 'dist'), { recursive: true });
await cp(path.join(root, 'plugin'), plugin, { recursive: true });
const css = spawnSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/ui/styles.css', '-o', 'dist/reader.css', '--minify'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (css.status !== 0) throw new Error(css.stderr || 'CSS build failed');
const uiBuild = await build({ metafile: true, entryPoints: [path.join(root, 'src/ui/main.tsx')], outfile: path.join(dist, 'reader.js'), bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['chrome120'], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
const pluginBuild = await build({ metafile: true, entryPoints: [path.join(root, 'src/server.ts')], outfile: path.join(plugin, 'dist/server.mjs'), bundle: true, minify: false, format: 'esm', platform: 'node', target: ['node20'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __pathDirname } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);" }, logLevel: 'warning' });
const js = (await readFile(path.join(dist, 'reader.js'), 'utf8')).replace(/<\/script/gi, '<\\/script');
const styles = await readFile(path.join(dist, 'reader.css'), 'utf8');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>代码随读</title><style>${styles}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
await writeFile(path.join(plugin, 'dist/reader.html'), html);
const web = path.join(dist, 'web');
await mkdir(web, { recursive: true });
const webBuild = await build({ metafile: true, entryPoints: [path.join(root, 'src/web/server.ts')], outfile: path.join(web, 'server.mjs'), bundle: true, minify: false, format: 'esm', platform: 'node', target: ['node20'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __pathDirname } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);" }, logLevel: 'warning' });
await writeFile(path.join(web, 'reader.html'), html);
await cp(path.join(root, 'web/README.md'), path.join(web, 'README.md'));
await cp(path.join(root, 'web/启动网页版.cmd'), path.join(web, '启动网页版.cmd'));
const notices = await thirdPartyNotices(root, [uiBuild, pluginBuild, webBuild]);
for (const destination of [plugin, web]) {
  await cp(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
  await writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), notices);
}
process.stdout.write(`Built self-contained plugin: ${plugin}\n`);
process.stdout.write(`Built standalone website: ${web}\n`);
