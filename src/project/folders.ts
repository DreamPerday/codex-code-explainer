import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { ReaderError } from '../shared/contracts.js';
import type { FolderListing, FolderLocation, FolderLocations } from '../shared/folders.js';

// Paths are passed as environment data, never interpolated into PowerShell code.
const nativeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object Windows.Forms.Form
$owner.Text = '代码随读 — 选择项目文件夹'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$dialog = New-Object Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择要阅读的项目文件夹'
$dialog.ShowNewFolderButton = $false
$dialog.RootFolder = [Environment+SpecialFolder]::MyComputer
if ($env:CODE_EXPLAINER_FOLDER_START) { $dialog.SelectedPath = $env:CODE_EXPLAINER_FOLDER_START }
try {
  $owner.Show()
  $owner.Activate()
  $selected = $null
  if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) { $selected = $dialog.SelectedPath }
  @{ path = $selected } | ConvertTo-Json -Compress
} finally { $dialog.Dispose(); $owner.Dispose() }
`;

export class FolderBrowser {
  private history: FolderLocation[] = [];
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private dialogs = new Map<string, AbortController>();
  private readonly stateFile: string;
  constructor(stateFile?: string) {
    this.stateFile = stateFile ?? path.join(process.env.CODE_EXPLAINER_STATE_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'code-explainer'), 'recent-projects.json');
  }
  private load() {
    return this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.stateFile, 'utf8'));
        if (Array.isArray(raw)) this.history = raw.filter(item => item && typeof item.path === 'string' && item.path.length <= 1000 && path.isAbsolute(item.path) && typeof item.openedAt === 'number').slice(0, 12)
          .map(item => ({ name: path.basename(item.path) || item.path, path: item.path, kind: 'recent', openedAt: item.openedAt }));
      } catch { /* Missing or damaged history does not prevent browsing. */ }
    })();
  }
  async directory(input: string) {
    const value = input.trim().replace(/^"(.*)"$/, '$1');
    if (!value || value.includes('\0') || !path.isAbsolute(value)) throw new ReaderError('INVALID_FOLDER', '请选择文件夹，或粘贴完整的绝对路径。');
    try {
      const canonical = await realpath(value);
      if (!(await stat(canonical)).isDirectory()) throw new ReaderError('NOT_DIRECTORY', '这个路径是文件，请选择它所在的文件夹。');
      return canonical;
    } catch (error) {
      if (error instanceof ReaderError) throw error;
      throw new ReaderError('FOLDER_UNAVAILABLE', '无法访问这个文件夹，可能已移动或没有访问权限。');
    }
  }
  async locations(): Promise<FolderLocations> {
    await this.load();
    const home = os.homedir();
    const candidates: FolderLocation[] = [
      { name: '用户目录', path: home, kind: 'home' },
      ...[['桌面', 'Desktop'], ['文档', 'Documents'], ['下载', 'Downloads']].map(([name, folder]) => ({ name, path: path.join(home, folder), kind: 'common' as const })),
    ];
    if (process.env.OneDrive) for (const [name, folder] of [['桌面', 'Desktop'], ['文档', 'Documents']]) candidates.push({ name: `${name} · OneDrive`, path: path.join(process.env.OneDrive, folder), kind: 'common' });
    if (process.platform === 'win32') for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`; candidates.push({ name: `本地磁盘 ${drive.slice(0, 2)}`, path: drive, kind: 'drive' });
    } else candidates.push({ name: '文件系统', path: '/', kind: 'drive' });
    const checked = await Promise.all(candidates.map(async item => { try { return (await stat(item.path)).isDirectory() ? item : null; } catch { return null; } }));
    return { shortcuts: checked.filter((item): item is FolderLocation => item !== null), recents: [...this.history], nativeAvailable: process.platform === 'win32' };
  }
  async list(input?: string, query = '', showHidden = false): Promise<FolderListing> {
    const root = await this.directory(input || os.homedir());
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { throw new ReaderError('FOLDER_UNAVAILABLE', '无法列出这个文件夹，请返回上级或选择其他位置。'); }
    const term = query.toLocaleLowerCase();
    const directories = (await Promise.all(entries.map(async entry => {
      if (entry.isDirectory()) return entry;
      if (entry.isSymbolicLink()) { try { if ((await stat(path.join(root, entry.name))).isDirectory()) return entry; } catch {} }
      return null;
    }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const folders = directories.filter(entry => (showHidden || !/^[.$]/.test(entry.name)) && entry.name.toLocaleLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map(entry => ({ name: entry.name, path: path.join(root, entry.name) }));
    const anchor = path.parse(root).root; const parts = path.relative(anchor, root).split(path.sep).filter(Boolean);
    const breadcrumbs = [{ name: anchor, path: anchor }];
    for (let i = 0; i < parts.length; i++) breadcrumbs.push({ name: parts[i], path: path.join(anchor, ...parts.slice(0, i + 1)) });
    return { path: root, parent: path.dirname(root) === root ? null : path.dirname(root), breadcrumbs, folders: folders.slice(0, 400), total: folders.length, truncated: folders.length > 400 };
  }
  async remember(input: string) {
    const root = await this.directory(input); await this.load();
    const key = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    this.history = [{ name: path.basename(root) || root, path: root, kind: 'recent' as const, openedAt: Date.now() }, ...this.history.filter(item => key(item.path) !== key(root))].slice(0, 12);
    const snapshot = JSON.stringify(this.history, null, 2);
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const temp = `${this.stateFile}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.stateFile);
    }).catch(() => { /* Keep in-memory recents if preferences cannot be saved. */ });
    await this.writes;
  }
  async pick(key: string, initialPath?: string): Promise<{ path: string | null }> {
    if (process.platform !== 'win32') throw new ReaderError('PICKER_UNAVAILABLE', '当前系统请使用面板内的文件夹浏览。');
    if (this.dialogs.has(key)) throw new ReaderError('PICKER_BUSY', '文件夹选择窗口已经打开。');
    const abort = new AbortController(); this.dialogs.set(key, abort);
    try {
    const initial = initialPath ? await this.directory(initialPath) : os.homedir();
    if (abort.signal.aborted) return { path: null };
    const selected = await new Promise<string | null>((resolve, reject) => {
      let done = false, output = '';
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(nativeScript, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODE_EXPLAINER_FOLDER_START: initial },
      });
      const finish = (value: string | null, error?: Error) => {
        if (done) return; done = true; clearTimeout(timer); abort.signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => { child.kill(); finish(null); };
      const timer = setTimeout(() => abort.abort(), 300000);
      abort.signal.addEventListener('abort', cancel, { once: true });
      if (abort.signal.aborted) cancel();
      child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; if (output.length > 32000) { child.kill(); finish(null, new ReaderError('PICKER_FAILED', '系统选择窗口未返回有效路径，请使用面板浏览。')); } });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(null, new ReaderError('PICKER_FAILED', '系统选择窗口未能打开，请使用面板内的文件夹浏览。')));
      child.on('close', code => {
        if (done) return;
        try { const value = JSON.parse(output.replace(/^\uFEFF/, '').trim()); if (code !== 0 || value.path !== null && typeof value.path !== 'string') throw new Error(); finish(value.path); }
        catch { finish(null, new ReaderError('PICKER_FAILED', '系统选择窗口未能完成，请使用面板内的文件夹浏览。')); }
      });
    });
    return { path: selected ? await this.directory(selected) : null };
    } finally { if (this.dialogs.get(key) === abort) this.dialogs.delete(key); }
  }
  cancel(key: string) { this.dialogs.get(key)?.abort(); }
  close() { for (const abort of this.dialogs.values()) abort.abort(); }
}
