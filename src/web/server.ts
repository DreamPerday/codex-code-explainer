import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReaderServer } from '../server.js';
import { ReaderStore } from '../explanations/store.js';
import { ModelPreferences } from '../inference/preferences.js';
import { FolderBrowser } from '../project/folders.js';
import { ReaderError } from '../shared/contracts.js';
import { ProviderConfigStore, providerDraftSchema, webStateDirectory } from './config.js';
import { generateApi, listApiModels, WebInference } from './api-inference.js';
import type { Inference } from '../inference/codex.js';

type WebOptions = { htmlPath?: string; stateDirectory?: string; root?: string; codex?: Inference };
const toolSchema = z.object({ name: z.string().max(100), arguments: z.record(z.string(), z.unknown()).default({}) });
export async function createWebServer(options: WebOptions = {}) {
  const directory = options.stateDirectory || webStateDirectory();
  const htmlPath = options.htmlPath || path.join(path.dirname(fileURLToPath(import.meta.url)), 'reader.html');
  const html = await readFile(htmlPath);
  const settings = new ProviderConfigStore(directory); await settings.load();
  const inference = new WebInference(settings, options.codex);
  const store = new ReaderStore(inference, new ModelPreferences(path.join(directory, 'model.json')));
  const mcp = createReaderServer(htmlPath, store, new FolderBrowser(path.join(directory, 'recent-projects.json')));
  const client = new Client({ name: 'code-explainer-web', version: '0.5.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport); await client.connect(clientTransport);
  const allowed = new Set((await client.listTools()).tools.filter(tool => (tool._meta?.ui as any)?.visibility?.includes('app')).map(tool => tool.name));
  const token = randomBytes(32).toString('hex');
  const active = new Set<AbortController>();
  let transition: Promise<unknown> = Promise.resolve();
  let closing = false;
  const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  async function body(req: http.IncomingMessage) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new ReaderError('CONTENT_TYPE', '请求必须使用 JSON。');
    if (Number(req.headers['content-length'] || 0) > 100000) throw new ReaderError('BODY_LIMIT', '请求内容过长。');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100000) throw new ReaderError('BODY_LIMIT', '请求内容过长。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ReaderError('INVALID_JSON', '请求不是有效的 JSON。'); }
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Request-Id', requestId);
    const address = server.address(); const port = typeof address === 'object' ? address?.port : undefined;
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && req.headers.origin !== origin) { json(res, 403, { error: '仅允许本机页面访问。' }); return; }
    if (closing) { json(res, 503, { error: '服务正在关闭。' }); return; }
    const controller = new AbortController(); active.add(controller);
    res.on('close', () => { controller.abort(); active.delete(controller); });
    try {
      const url = new URL(req.url || '/', origin);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (req.method === 'GET' && ['/health', '/ready'].includes(url.pathname)) { json(res, 200, { status: 'ok', version: '0.5.0' }); return; }
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        await transition;
        const resume = url.searchParams.get('session');
        if (resume && z.string().uuid().safeParse(resume).success) {
          try { const seed = await store.seed(resume); json(res, 200, { token, seed, settings: await settings.state() }); return; } catch { /* Expired page sessions start a new reader. */ }
        }
        const result = await client.callTool({ name: 'open_reader', arguments: options.root ? { root: options.root } : {} });
        if (result.isError) throw new ReaderError('PROJECT_OPEN', '无法打开启动时指定的项目，请移除 --root 或检查项目路径。');
        json(res, 200, { token, seed: result.structuredContent, settings: await settings.state() }); return;
      }
      if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: '页面不存在。' }); return; }
      if (req.headers['x-reader-token'] !== token) { json(res, 403, { error: '连接已失效，请刷新页面。' }); return; }
      await transition.catch(() => {});
      if (req.method === 'GET' && url.pathname === '/api/provider') { json(res, 200, await settings.state()); return; }
      if (req.method !== 'POST') { json(res, 405, { error: '请求方法不支持。' }); return; }
      const input = await body(req);
      if (url.pathname === '/api/tools') {
        const tool = toolSchema.parse(input);
        if (!allowed.has(tool.name)) { json(res, 403, { error: '网页不可调用此工具。' }); return; }
        json(res, 200, await client.callTool(tool, undefined, { timeout: 310000 })); return;
      }
      if (url.pathname === '/api/provider') {
        const draft = providerDraftSchema.parse(input);
        const operation = transition.catch(() => {}).then(async () => { await store.invalidateInference(); return settings.save(draft); });
        transition = operation.catch(() => {}); json(res, 200, await operation); return;
      }
      if (url.pathname === '/api/provider/models' || url.pathname === '/api/provider/test') {
        const draft = providerDraftSchema.parse(input); const config = await settings.resolve(draft);
        if (url.pathname.endsWith('/models')) {
          const models = config.mode === 'api' ? await listApiModels(config, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])) : (await inference.codexModels()).models;
          json(res, 200, { models }); return;
        }
        const start = Date.now();
        const request = { prompt: '请只返回 {"ok":true}，这是用户点击测试按钮发起的连接测试。', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, model: config.model || undefined, signal: controller.signal };
        // Use a short-lived configured route for tests; never save a draft implicitly.
        let answer: string;
        if (config.mode === 'api') answer = await generateApi(config, request);
        else { const { CodexInference } = await import('../inference/codex.js'); const backend = options.codex || new CodexInference(); try { answer = await backend.generate(request); } finally { if (!options.codex) backend.close(); } }
        if (JSON.parse(answer).ok !== true) throw new ReaderError('TEST_FORMAT', '接口已连接，但模型没有返回预期测试结果。');
        json(res, 200, { ok: true, elapsedMs: Date.now() - start }); return;
      }
      json(res, 404, { error: '接口不存在。' });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const message = error instanceof ReaderError ? error.message : error instanceof z.ZodError ? '设置或请求参数不符合要求。' : '后台请求失败，请检查设置后重试。';
      process.stderr.write(JSON.stringify({ level: 'error', requestId, code: error instanceof ReaderError ? error.code : 'WEB_REQUEST' }) + '\n');
      json(res, error instanceof ReaderError && error.code === 'BODY_LIMIT' ? 413 : 400, { error: message });
    }
  });
  server.requestTimeout = 320000; server.headersTimeout = 15000;
  return {
    server, settings, store,
    async listen(port = 4318) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ReaderError('INVALID_PORT', '端口必须为 0–65535 的整数。');
      await new Promise<void>((resolve, reject) => { const failure = (error: Error) => reject(error); server.once('error', failure); server.listen(port, '127.0.0.1', () => { server.removeListener('error', failure); resolve(); }); });
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
    async close() {
      if (closing) return; closing = true;
      for (const controller of active) controller.abort();
      const stopped = new Promise<void>(resolve => { if (!server.listening) resolve(); else server.close(() => resolve()); });
      await mcp.close(); await client.close(); server.closeAllConnections(); await stopped;
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  let app: Awaited<ReturnType<typeof createWebServer>> | undefined;
  try {
    app = await createWebServer({ root: value('--root') });
    const url = await app.listen(Number(value('--port') || process.env.CODE_EXPLAINER_WEB_PORT || 4318));
    process.stdout.write(`代码随读 · 独立网页版\n${url}\n关闭此服务可按 Ctrl+C。\n`);
    if (args.includes('--open')) {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(command, [url], { windowsHide: true, detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
    }
    const close = () => { void app?.close().finally(() => process.exit(0)); }; process.on('SIGINT', close); process.on('SIGTERM', close);
  } catch (error: any) {
    process.stderr.write(error?.code === 'EADDRINUSE' ? '端口已被占用，可用 --port 指定其他端口。\n' : '网页版启动失败，请检查文件和启动参数。\n');
    await app?.close(); process.exitCode = 1;
  }
}
