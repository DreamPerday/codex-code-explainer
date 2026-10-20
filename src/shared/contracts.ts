import { z } from 'zod';

export const citationSchema = z.object({
  path: z.string().min(1).max(500),
  line: z.number().int().positive(),
  description: z.string().min(1).max(1000),
});
export const explanationSchema = z.object({
  summary: z.string().min(1).max(2000).describe('用中文说明这段代码的业务作用。'),
  steps: z.array(z.string().min(1).max(1500)).max(12).describe('按执行顺序解释关键逻辑，可包含具体输入输出示例。'),
  inputs: z.array(z.string().max(1000)).max(8),
  outputs: z.array(z.string().max(1000)).max(8),
  citations: z.array(citationSchema).max(15).describe('实际阅读过的相关源码位置，路径相对项目根目录。'),
  cautions: z.array(z.object({
    kind: z.enum(['confirmed', 'verify']),
    text: z.string().min(1).max(1500),
  })).max(10),
  coverage: z.string().min(1).max(2000).describe('实际检查过的文件和调用关系，以及尚未验证的部分。'),
});
export type Explanation = z.infer<typeof explanationSchema>;
export type FileSnapshot = { path: string; text: string; version: string; lineCount: number };
export type FilePurpose = { text: string; basis: 'source' | 'structure' | 'ai'; version: string };
export type ProjectInfo = { root: string; name: string; files: string[]; truncated: boolean };
export type SessionSeed = { sessionId: string; project: ProjectInfo | null; initialFile?: string; context?: string; model?: string | null };
export type Selection = { from: number; to: number; startLine: number; endLine: number };
export type JobView = {
  id: string;
  status: 'pending' | 'complete' | 'cancelled' | 'stale' | 'failed';
  path: string;
  startLine: number;
  endLine: number;
  explanation?: Explanation;
  error?: string;
  preview?: string;
  elapsedMs?: number;
  cached?: boolean;
};

export class ReaderError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'ReaderError'; }
}
