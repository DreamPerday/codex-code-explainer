import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { ReaderError } from '../shared/contracts.js';
import { validateModel } from '../inference/preferences.js';
import type { ProviderState, ProviderDraft } from '../shared/web.js';

export const providerDraftSchema = z.object({ mode: z.enum(['api', 'codex']), baseUrl: z.string().max(2000), model: z.string().max(200), stream: z.boolean(), apiKey: z.string().max(8192).optional(), clearKey: z.boolean().optional(), rememberKey: z.boolean() });
export type ProviderConfig = Omit<ProviderState, 'keySet' | 'revision'> & { apiKey: string };
export const webStateDirectory = () => process.env.CODE_EXPLAINER_WEB_STATE_DIR || path.join(os.homedir(), '.codex', 'code-explainer-web');
export function apiBaseUrl(input: string) {
  try {
    const url = new URL(input.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new ReaderError('INVALID_API_URL', '请填写 HTTP 或 HTTPS API 基础地址，例如 https://api.openai.com/v1，不要附带密钥或查询参数。'); }
}
async function protectSecret(value: string, decrypt = false): Promise<string> {
  if (process.platform !== 'win32') return value;
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); ${decrypt ? '$bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($bytes))' : '$bytes=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($bytes))'}`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' });
    let result = ''; let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(); }, 10000);
    const finish = (ok = false) => { if (settled) return; settled = true; clearTimeout(timer); if (ok) resolve(result); else reject(new ReaderError('KEY_STORAGE', '无法访问本机密钥保护功能。可取消“记住密钥”后重试。')); };
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { result += data; if (result.length > 40000) { child.kill(); finish(); } });
    child.stderr.on('data', () => {}); child.stdin.on('error', () => finish()); child.on('error', () => finish()); child.on('close', code => finish(code === 0));
    child.stdin.end(value, 'utf8');
  });
}
export class ProviderConfigStore {
  private value: ProviderConfig = { mode: 'api', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', stream: true, rememberKey: false };
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private revision = randomUUID();
  constructor(private directory = webStateDirectory()) {}
  async load() {
    return this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(path.join(this.directory, 'provider.json'), 'utf8'));
        const draft = providerDraftSchema.parse({ ...raw, apiKey: undefined });
        const apiKey = draft.rememberKey && typeof raw.secret === 'string' ? await protectSecret(raw.secret, true) : '';
        this.value = this.validate({ ...draft, apiKey });
      } catch { /* A missing or invalid preference file leaves the reader usable without AI. */ }
    })();
  }
  private validate(value: ProviderConfig): ProviderConfig {
    if (value.model) validateModel(value.model);
    if (/[\r\n\0]/.test(value.apiKey)) throw new ReaderError('INVALID_API_KEY', 'API Key 不能包含换行。');
    return { mode: value.mode, baseUrl: apiBaseUrl(value.baseUrl), model: value.model, apiKey: value.apiKey, stream: value.stream, rememberKey: value.rememberKey };
  }
  async current() { await this.load(); return { ...this.value }; }
  async state(): Promise<ProviderState> {
    const { apiKey, ...value } = await this.current(); return { ...value, keySet: !!apiKey, revision: this.revision };
  }
  async resolve(input: ProviderDraft) {
    const draft = providerDraftSchema.parse(input); const current = await this.current();
    const baseUrl = apiBaseUrl(draft.baseUrl);
    const sameOrigin = new URL(baseUrl).origin === new URL(current.baseUrl).origin;
    const apiKey = draft.clearKey ? '' : draft.apiKey?.trim() ?? (sameOrigin ? current.apiKey : '');
    return this.validate({ ...draft, baseUrl, apiKey });
  }
  async save(input: ProviderDraft) {
    const next = this.writes.catch(() => {}).then(async () => {
      const value = await this.resolve(input);
      const secret = value.rememberKey && value.apiKey ? await protectSecret(value.apiKey) : '';
      const { apiKey: _key, ...publicValue } = value;
      await mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, 'provider.json'), temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ ...publicValue, secret }, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, target);
      this.value = value; this.revision = randomUUID(); return this.state();
    });
    this.writes = next.then(() => {}, () => {});
    try { return await next; } catch (e) { if (e instanceof ReaderError || e instanceof z.ZodError) throw e; throw new ReaderError('SETTINGS_SAVE', '无法保存网页设置，请检查本机偏好目录的写入权限。'); }
  }
}
