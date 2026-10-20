import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'dist', `release-${version}`);
await mkdir(path.join(stage, 'dist'), { recursive: true });
await mkdir(path.join(stage, 'scripts'), { recursive: true });
await cp(path.join(root, 'dist/plugin'), path.join(stage, 'dist/plugin'), { recursive: true });
await cp(path.join(root, 'scripts/install.mjs'), path.join(stage, 'scripts/install.mjs'));
await cp(path.join(root, 'README.md'), path.join(stage, 'README.md'));
await cp(path.join(root, 'dist/plugin/LICENSE'), path.join(stage, 'LICENSE'));
await cp(path.join(root, 'dist/plugin/THIRD_PARTY_NOTICES.txt'), path.join(stage, 'THIRD_PARTY_NOTICES.txt'));
await writeFile(path.join(stage, '安装说明.txt'), '需要 Node.js 20+。解压后在此目录运行：\nnode scripts/install.mjs\ncodex plugin add code-explainer@personal\n然后重新加载 Codex。后台优先复用桌面端 Codex 登录；无桌面路径时需可用的 CLI 登录。\n', 'utf8');
const archive = path.join(root, 'dist', `code-explainer-${version}.zip`);
if (process.platform !== 'win32') throw new Error('This release packager currently requires Windows PowerShell.');
// Paths are single-quoted with PowerShell's literal quote escaping.
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path ${quote(stage + path.sep + '*')} -DestinationPath ${quote(archive)} -Force`], { windowsHide: true, encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'Packaging failed');
process.stdout.write(`Packaged ${archive}\n`);
