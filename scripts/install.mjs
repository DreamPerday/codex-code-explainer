import { cp, mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userRoot = os.homedir();
const source = path.join(root, 'dist/plugin');
const destination = path.join(userRoot, 'plugins/code-explainer');
const manifestPath = path.join(destination, '.codex-plugin/plugin.json');
const marketplacePath = path.join(userRoot, '.agents/plugins/marketplace.json');
await access(path.join(source, 'dist/server.mjs'));
await access(path.join(source, 'dist/reader.html'));
try {
  const existing = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (existing.name !== 'code-explainer') throw new Error('安装目标不是代码随读插件，停止安装。');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let marketplace = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
try {
  const original = await readFile(marketplacePath, 'utf8');
  marketplace = JSON.parse(original);
  if (!Array.isArray(marketplace.plugins)) throw new Error('个人插件目录格式不正确，停止安装。');
  const backup = `${marketplacePath}.code-explainer-backup-${Date.now()}`;
  await writeFile(backup, original, { flag: 'wx' });
  process.stdout.write(`Marketplace backup: ${backup}\n`);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
// Resolve local paths explicitly so the host's working-directory conventions cannot break launch.
const mcpPath = path.join(destination, '.mcp.json');
const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
mcp.mcpServers['code-explainer'].command = process.execPath;
mcp.mcpServers['code-explainer'].args = [path.join(destination, 'dist/server.mjs'), '--stdio'];
mcp.mcpServers['code-explainer'].cwd = destination;
// The desktop-bundled CLI may use a newer auth store than a globally installed CLI.
const codexPath = process.env.CODE_EXPLAINER_CODEX_PATH || process.env.CODEX_CLI_PATH;
if (codexPath && path.isAbsolute(codexPath)) {
  await access(codexPath);
  mcp.mcpServers['code-explainer'].env = { ...(mcp.mcpServers['code-explainer'].env ?? {}), CODE_EXPLAINER_CODEX_PATH: codexPath };
}
await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
const entry = { name: 'code-explainer', source: { source: 'local', path: './plugins/code-explainer' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' };
const index = marketplace.plugins.findIndex(item => item.name === entry.name);
if (index < 0) marketplace.plugins.push(entry); else marketplace.plugins[index] = entry;
await mkdir(path.dirname(marketplacePath), { recursive: true });
const temp = `${marketplacePath}.code-explainer-${Date.now()}.tmp`;
await writeFile(temp, JSON.stringify(marketplace, null, 2) + '\n', { flag: 'wx' });
await rename(temp, marketplacePath);
process.stdout.write(`Plugin copied: ${destination}\nEnable with: codex plugin add code-explainer@${marketplace.name}\n`);
