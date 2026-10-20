import { realpath, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ReaderError, type FileSnapshot, type ProjectInfo } from '../shared/contracts.js';

const execFileAsync = promisify(execFile);
const ignoredDirs = new Set(['.git', '.codegraph', '.venv', 'venv', 'node_modules', '__pycache__', '.next', '.nuxt', 'dist', 'build', '.pytest_cache', '.ruff_cache', '.idea', '.vscode', '.codex', '.agents']);
const codeExtensions = new Set(['.py', '.pyi', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json', '.md', '.mdx', '.toml', '.yaml', '.yml', '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.sql', '.rs', '.go', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs', '.fs', '.rb', '.php', '.sh', '.ps1', '.bat', '.cmd', '.xml', '.dart', '.lua', '.r', '.txt', '.ini', '.cfg', '.proto', '.graphql', '.gql', '.prisma']);
const namedFiles = new Set(['Dockerfile', 'Makefile', 'Justfile', 'CMakeLists.txt']);
const MAX_FILES = 12000;
const MAX_FILE_BYTES = 1024 * 1024;

export function browsable(file: string): boolean {
  const parts = file.replaceAll('\\', '/').split('/');
  const name = parts.at(-1) ?? '';
  return !parts.some(p => ignoredDirs.has(p)) && !/^\.env(?:\.|$)/i.test(name)
    && !/^(?:credentials|secrets|auth)\.(?:json|toml|ya?ml)$/i.test(name)
    && !name.endsWith('.lock') && (codeExtensions.has(path.extname(name).toLowerCase()) || namedFiles.has(name));
}

export class Repository {
  private inventoryCache?: { at: number; value: ProjectInfo };
  private constructor(readonly root: string) {}
  static async open(root: string) {
    if (!path.isAbsolute(root)) throw new ReaderError('INVALID_ROOT', '请输入项目文件夹的绝对路径。');
    let canonical: string;
    try { canonical = await realpath(root); }
    catch { throw new ReaderError('ROOT_MISSING', '找不到这个项目文件夹，请检查路径。'); }
    if (!(await stat(canonical)).isDirectory()) throw new ReaderError('INVALID_ROOT', '项目路径必须是文件夹。');
    return new Repository(canonical);
  }

  async resolve(file: string) {
    if (!file || path.isAbsolute(file) || file.includes('\0') || file.includes(':')) throw new ReaderError('INVALID_PATH', '请使用项目内的相对文件路径。');
    const candidate = path.resolve(this.root, file);
    let canonical: string;
    try { canonical = await realpath(candidate); }
    catch { throw new ReaderError('FILE_MISSING', '文件不存在，可能已被移动或删除。'); }
    const relative = path.relative(this.root, canonical);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new ReaderError('OUTSIDE_PROJECT', '只能读取当前项目文件夹内的文件。');
    }
    if (!browsable(relative)) throw new ReaderError('UNSUPPORTED_FILE', '这个文件未纳入代码阅读范围。');
    return { absolute: canonical, relative: relative.replaceAll('\\', '/') };
  }

  async read(file: string): Promise<FileSnapshot> {
    const target = await this.resolve(file);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new ReaderError('NOT_FILE', '请选择一个代码文件。');
    if (info.size > MAX_FILE_BYTES) throw new ReaderError('FILE_TOO_LARGE', '文件超过 1 MB，请选择较小的源码文件。');
    const bytes = await readFile(target.absolute);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ReaderError('FILE_TOO_LARGE', '文件超过 1 MB。');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ReaderError('ENCODING', '暂时只支持 UTF-8 源码，请先转换文件编码。'); }
    if (text.includes('\0')) throw new ReaderError('BINARY_FILE', '不能把二进制文件作为代码打开。');
    // Match CodeMirror's normalized document and UTF-16 offsets exactly.
    text = text.replace(/\r\n?/g, '\n');
    return { path: target.relative, text, version: createHash('sha256').update(text).digest('hex'), lineCount: text.split('\n').length };
  }

  async inventory(): Promise<ProjectInfo> {
    if (this.inventoryCache && Date.now() - this.inventoryCache.at < 2000) return this.inventoryCache.value;
    let files: string[] = [];
    let truncated = false;
    try {
      const result = await execFileAsync('git', ['-C', this.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      files = [...new Set(result.stdout.split('\0').filter(Boolean).filter(browsable))];
    } catch {
      let visited = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 24 || files.length >= MAX_FILES || visited >= 50000) { truncated = true; return; }
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          visited++;
          if (files.length >= MAX_FILES || visited >= 50000) { truncated = true; return; }
          if (entry.isSymbolicLink()) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && !ignoredDirs.has(entry.name) && !entry.name.startsWith('.')) await walk(full, depth + 1);
          else if (entry.isFile()) {
            const rel = path.relative(this.root, full).replaceAll('\\', '/');
            if (browsable(rel)) files.push(rel);
          }
        }
      };
      await walk(this.root, 0);
    }
    truncated ||= files.length > MAX_FILES;
    const value = { root: this.root, name: path.basename(this.root), files: files.sort().slice(0, MAX_FILES), truncated };
    this.inventoryCache = { at: Date.now(), value };
    return value;
  }

  async overview() {
    const project = await this.inventory();
    const docs: { path: string; text: string; version: string; truncated: boolean }[] = [];
    for (const name of ['README.md', 'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']) {
      if (!project.files.includes(name)) continue;
      try {
        const file = await this.read(name);
        docs.push({ path: name, text: file.text.slice(0, 1800), version: file.version, truncated: file.text.length > 1800 });
      } catch { /* A missing overview file does not prevent inspecting source. */ }
    }
    return { ...project, files: project.files.slice(0, 400), totalFiles: project.files.length, docs };
  }

  async related(file: FileSnapshot, selection: string) {
    const { files } = await this.inventory();
    const candidates = new Set<string>();
    const imports = [...file.text.slice(0, 18000).matchAll(/(?:from\s+["']([^"']+)["']|import\s+["']([^"']+)["']|from\s+([.\w]+)\s+import|^import\s+([\w.]+))/gm)];
    for (const match of imports) {
      const module = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (module.startsWith('.')) {
        const relative = module.includes('/') ? module : module.replace(/^\./, './').replace(/(?<=\w)\./g, '/');
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), relative)).replace(/\.(js|mjs)$/, '');
        for (const p of files) if ([base, ...['.ts', '.tsx', '.js', '.py', '/index.ts', '/__init__.py'].map(e => base + e)].includes(p)) candidates.add(p);
      } else {
        const base = module.replaceAll('.', '/');
        for (const p of files) if (p === base + '.py' || p === base + '/__init__.py') candidates.add(p);
      }
    }
    // A bounded caller scan adds evidence without sending the entire project.
    const symbol = selection.match(/(?:function|def|class)\s+(\w+)/)?.[1];
    const scanned = symbol ? files.filter(p => p !== file.path && !candidates.has(p)).sort((a, b) => Number(!a.startsWith(path.posix.dirname(file.path))) - Number(!b.startsWith(path.posix.dirname(file.path)))).slice(0, 48) : [];
    const callers = await Promise.all(scanned.map(async p => {
      try { const source = await this.read(p); return source.text.includes(symbol!) ? p : null; } catch { return null; }
    }));
    for (const p of callers) if (p) candidates.add(p);
    const related = [];
    for (const p of [...candidates].filter(p => p !== file.path).slice(0, 4)) {
      try {
        const source = await this.read(p);
        const lines = source.text.split('\n');
        const occurrence = symbol ? Math.max(0, lines.findIndex(l => l.includes(symbol))) : 0;
        const first = Math.max(0, occurrence - 12);
        const chosen: string[] = []; let size = 0;
        for (let n = first; n < Math.min(first + 70, lines.length); n++) {
          if (size + lines[n].length > 3200) break;
          chosen.push(`${n + 1}: ${lines[n]}`); size += lines[n].length;
        }
        related.push({ path: p, version: source.version, firstLine: first + 1, lastLine: first + chosen.length, text: chosen.join('\n'), truncated: first > 0 || first + chosen.length < lines.length });
      } catch { /* Report only actually read sources. */ }
    }
    return { sources: related, callerScanFiles: scanned.length, candidateLimit: 4 };
  }

  async search(query: string, limit = 35) {
    const project = await this.inventory();
    const results: { path: string; line: number; text: string }[] = [];
    let scannedFiles = 0;
    for (const file of project.files) {
      if (scannedFiles >= 1500 || results.length >= limit) break;
      scannedFiles++;
      try {
        const source = await this.read(file);
        const lines = source.text.split('\n');
        for (let i = 0; i < lines.length && results.length < limit; i++) {
          if (lines[i].includes(query)) results.push({ path: file, line: i + 1, text: lines[i].slice(0, 600) });
        }
      } catch { /* Unreadable / large files are excluded, coverage is reported. */ }
    }
    return { results, scannedFiles, totalFiles: project.files.length, truncated: scannedFiles < project.files.length || results.length >= limit };
  }
}
