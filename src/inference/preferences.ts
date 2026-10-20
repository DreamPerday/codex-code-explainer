import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ReaderError } from '../shared/contracts.js';

export function validateModel(model: string | null) {
  if (model !== null && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@+\-]{0,199}$/.test(model))) throw new ReaderError('INVALID_MODEL', '模型名应为 1–200 个字母、数字或 . _ / : @ + -，不能包含空格。');
  return model;
}
export class ModelPreferences {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file = path.join(process.env.CODE_EXPLAINER_STATE_DIR || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'code-explainer'), 'model.json')) {}
  async read(): Promise<string | null> {
    try { return validateModel(JSON.parse(await readFile(this.file, 'utf8')).model ?? null); } catch { return null; }
  }
  async save(model: string | null) {
    validateModel(model);
    const next = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ model }), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writes = next;
    try { await next; } catch { throw new ReaderError('MODEL_SAVE_FAILED', '无法保存模型设置，请检查本地配置目录的写入权限。'); }
  }
}
