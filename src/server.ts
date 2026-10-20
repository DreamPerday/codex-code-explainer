import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReaderStore } from './explanations/store.js';
import { CodexInference } from './inference/codex.js';
import { ModelPreferences } from './inference/preferences.js';
import { FolderBrowser } from './project/folders.js';
import { ReaderError } from './shared/contracts.js';

export const UI_URI = 'ui://code-explainer/reader-v1.html';
const id = z.string().uuid();
const filePath = z.string().min(1).max(1000);
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const uiOnly = { ui: { visibility: ['app'] } };
const modelOnly = { ui: { visibility: ['model'] } };

export function createReaderServer(htmlPath: string, store = new ReaderStore(new CodexInference(), new ModelPreferences()), folders = new FolderBrowser()) {
  const server = new McpServer({ name: 'code-explainer', version: '0.5.0' }, {
    instructions: 'Code Explainer runs explanations inside its own background inference process. Open a reader with the project root and a concise context summary from the current conversation. Do not explain selections in chat. Never read conversation databases. update_reader_context explicitly transfers a new summary to an existing reader.',
  });
  function guard<T extends Record<string, unknown>>(fn: () => Promise<T> | T, brief?: string) {
    return Promise.resolve().then(fn).then(data => ({
      content: [{ type: 'text' as const, text: brief ?? JSON.stringify(data) }], structuredContent: data,
    })).catch((error: unknown) => {
      const message = error instanceof ReaderError ? error.message : error instanceof z.ZodError ? '请求参数不符合要求。' : '读取失败，请检查项目路径或重试。';
      process.stderr.write(JSON.stringify({ level: 'error', code: error instanceof ReaderError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : String(error) }) + '\n');
      return { isError: true, content: [{ type: 'text' as const, text: message }] };
    });
  }
  server.registerResource('代码阅读面板', UI_URI, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
    contents: [{ uri: UI_URI, mimeType: 'text/html;profile=mcp-app', text: await readFile(htmlPath, 'utf8'),
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } }, 'openai/widgetDescription': '只读代码阅读器。选区由插件后台独立解释，结果直接进入浮窗。目录在文件名旁显示用途。' } }],
  }));
  const viewerMetadata = {
    ui: { resourceUri: UI_URI },
    'openai/outputTemplate': UI_URI,
    'openai/toolInvocation/invoking': '正在打开代码阅读面板',
    'openai/toolInvocation/invoked': '代码阅读面板已打开',
  };
  server.registerTool('open_reader', {
    title: '打开代码阅读面板',
    description: 'Open a reader with independent background explanations. Supply the current workspace root and a concise summary of relevant chat background in context. This is the explicit context bridge; the reader cannot read this chat automatically.',
    inputSchema: { root: z.string().min(1).max(1000).optional(), context: z.string().max(8000).default('') }, annotations,
    _meta: { ...viewerMetadata, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, ({ root, context }) => guard(async () => {
    const seed = await store.create(root, context);
    if (seed.project) await folders.remember(seed.project.root);
    return seed;
  }, '代码阅读面板已打开，选区解释由插件后台直接返回浮窗。'));
  server.registerTool('update_reader_context', {
    title: '同步项目背景到阅读器', description: 'Explicitly replace the background summary in an existing reader. Use only when the user asks to update/sync the reader context. Does not read chat logs.',
    inputSchema: { sessionId: id, context: z.string().max(8000) }, annotations,
  }, ({ sessionId, context }) => guard(() => store.updateContext(sessionId, context), '已同步背景摘要到阅读器。'));
  server.registerTool('set_reader_context', {
    description: 'Update the project background directly from the panel.', inputSchema: { sessionId: id, context: z.string().max(8000) }, annotations, _meta: uiOnly,
  }, ({ sessionId, context }) => guard(() => store.updateContext(sessionId, context)));
  server.registerTool('get_file_purposes', {
    description: 'Get source-based purpose labels beside filenames, optionally refine up to 24 labels with background AI.',
    inputSchema: { sessionId: id, paths: z.array(filePath).max(80), improve: z.boolean().default(false) }, annotations, _meta: uiOnly,
  }, ({ sessionId, paths, improve }) => guard(async () => ({ purposes: await store.purposes(sessionId, paths, improve) })));
  server.registerTool('get_reader_models', {
    description: 'List models advertised by the existing Codex backend, its configured provider and the reader selection.',
    inputSchema: { sessionId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId }) => guard(() => store.models(sessionId)));
  server.registerTool('set_reader_model', {
    description: 'Choose the inference model for this reader and remember it for newly opened readers. Cancels pending analyses; does not change Codex configuration.',
    inputSchema: { sessionId: id, model: z.string().max(200).nullable() }, annotations: { ...annotations, readOnlyHint: false }, _meta: uiOnly,
  }, ({ sessionId, model }) => guard(() => store.setModel(sessionId, model)));
  server.registerTool('get_mind_map', {
    description: 'Build a source-grounded project map containing directories, files, classes, functions, methods and static local references.',
    inputSchema: { sessionId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId }) => guard(async () => ({ map: await store.mindMap(sessionId).get() })));
  server.registerTool('start_mind_summary', {
    description: 'Start independent background architecture or detailed symbol summaries for a map node.',
    inputSchema: { sessionId: id, nodeId: z.string().min(1).max(100), version: z.string().length(64) }, annotations, _meta: uiOnly,
  }, ({ sessionId, nodeId, version }) => guard(() => store.mindMap(sessionId).start(nodeId, version)));
  server.registerTool('get_mind_summary', {
    description: 'Read progress and completed details of a background map summary.',
    inputSchema: { sessionId: id, jobId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId, jobId }) => guard(() => store.mindMap(sessionId).poll(jobId)));
  server.registerTool('cancel_mind_summary', {
    description: 'Cancel the current map summary and interrupt its inference.',
    inputSchema: { sessionId: id, jobId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId, jobId }) => guard(() => store.mindMap(sessionId).cancel(jobId)));
  server.registerTool('open_code_file', {
    title: '用代码阅读面板打开文件',
    description: 'File-viewer entrypoint; opens code files in the explanation reader.',
    inputSchema: { file: z.object({ name: z.string(), resourceUri: z.string() }) }, annotations,
    _meta: { ...viewerMetadata, 'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.py', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.json', '.rs', '.go', '.java', '.kt', '.cpp', '.c', '.cs', '.vue', '.svelte'] }] } },
  }, ({ file }) => guard(async () => ({ ...(await store.create()), openedFile: file }), '已打开文件阅读面板。'));
  server.registerTool('connect_open_file', {
    description: 'Initialize the reader from the host-provided opened-file path.',
    inputSchema: { sessionId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId }, extra) => guard(async () => {
    const meta = extra._meta as Record<string, unknown> | undefined;
    const resource = meta?.['openai/resource'] as { path?: string } | undefined;
    if (!resource?.path || !path.isAbsolute(resource.path)) throw new ReaderError('HOST_UNSUPPORTED', '客户端没有提供文件路径，请在面板中手动打开项目。');
    let root = path.dirname(resource.path);
    let current = root;
    while (true) {
      try { await access(path.join(current, '.git')); root = current; break; } catch { /* Search parents. */ }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const seed = await store.connect(sessionId, root);
    if (seed.project) await folders.remember(seed.project.root);
    return { ...seed, initialFile: path.relative(root, resource.path).replaceAll('\\', '/') };
  }));
  server.registerTool('connect_project', {
    description: 'Choose a project folder for this reader instance.',
    inputSchema: { sessionId: id, root: z.string().min(1).max(1000) }, annotations, _meta: uiOnly,
  }, ({ sessionId, root }) => guard(async () => {
    const canonical = await folders.directory(root);
    const seed = await store.connect(sessionId, canonical);
    if (seed.project) await folders.remember(seed.project.root);
    return seed;
  }));
  server.registerTool('get_folder_locations', {
    description: 'Get available drives, common folder shortcuts and locally remembered projects for the folder picker.',
    inputSchema: { sessionId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId }) => guard(async () => { store.assertSession(sessionId); return folders.locations(); }));
  server.registerTool('browse_folders', {
    description: 'List immediate child directories for a user-operated project picker. Does not scan files or send paths to the model.',
    inputSchema: { sessionId: id, path: z.string().max(1000).optional(), query: z.string().max(200).default(''), showHidden: z.boolean().default(false) }, annotations, _meta: uiOnly,
  }, ({ sessionId, path, query, showHidden }) => guard(async () => { store.assertSession(sessionId); return folders.list(path, query, showHidden); }));
  server.registerTool('pick_project_folder', {
    description: 'Open the native Windows folder dialog after a click in the panel. Returns a selected directory or null on cancellation.',
    inputSchema: { sessionId: id, requestId: id, initialPath: z.string().max(1000).optional() }, annotations, _meta: uiOnly,
  }, ({ sessionId, requestId, initialPath }) => guard(async () => { store.assertSession(sessionId); return folders.pick(`${sessionId}:${requestId}`, initialPath); }));
  server.registerTool('cancel_folder_picker', {
    description: 'Close only this panel\'s outstanding native folder dialog.',
    inputSchema: { sessionId: id, requestId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId, requestId }) => guard(() => { store.assertSession(sessionId); folders.cancel(`${sessionId}:${requestId}`); return { cancelled: true }; }));
  server.registerTool('list_project_files', {
    description: 'Refresh the source-file inventory for this reader.', inputSchema: { sessionId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId }) => guard(() => store.repository(sessionId).inventory()));
  server.registerTool('read_file', {
    description: 'Read source text and its content version for the code editor.',
    inputSchema: { sessionId: id, path: filePath }, annotations, _meta: uiOnly,
  }, ({ sessionId, path }) => guard(() => store.repository(sessionId).read(path)));
  server.registerTool('request_explanation', {
    description: 'Start an independent background explanation for a selection. Never sends a message to the host chat.',
    inputSchema: { sessionId: id, path: filePath, from: z.number().int().min(0), to: z.number().int().positive(), version: z.string().length(64), question: z.string().max(2000).default('解释这段代码的作用、输入输出、执行过程和需要审查的地方。') },
    annotations, _meta: uiOnly,
  }, ({ sessionId, ...input }) => guard(() => store.request(sessionId, input)));
  server.registerTool('get_explanation', {
    description: 'Read streamed summary, timing and the completed explanation for a popup.',
    inputSchema: { sessionId: id, jobId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId, jobId }) => guard(() => store.poll(sessionId, jobId)));
  server.registerTool('cancel_explanation', {
    description: 'Cancel a popup result and interrupt its background inference.',
    inputSchema: { sessionId: id, jobId: id }, annotations, _meta: uiOnly,
  }, ({ sessionId, jobId }) => guard(() => store.cancel(sessionId, jobId)));
  server.registerTool('read_source', {
    description: 'Read related source with verified line numbers in the active reader project. Useful for callers, callees, types and tests. Maximum 600 lines and 60,000 characters per call; read further ranges if truncated.',
    inputSchema: { sessionId: id, path: filePath, firstLine: z.number().int().positive().default(1), lastLine: z.number().int().positive().optional() },
    annotations, _meta: modelOnly,
  }, ({ sessionId, path, firstLine, lastLine }) => guard(async () => {
    const file = await store.repository(sessionId).read(path);
    if (firstLine > file.lineCount) throw new ReaderError('INVALID_RANGE', '起始行号超出文件范围。');
    const end = Math.min(lastLine ?? firstLine + 599, firstLine + 599, file.lineCount);
    if (end < firstLine) throw new ReaderError('INVALID_RANGE', '结束行号不能小于起始行号。');
    const text = file.text.split('\n').slice(firstLine - 1, end).map((s, i) => `${firstLine + i}: ${s}`).join('\n');
    return { path: file.path, version: file.version, firstLine, lastLine: end, totalLines: file.lineCount, text: text.slice(0, 60000), truncated: end < file.lineCount || text.length > 60000 };
  }));
  server.registerTool('search_source', {
    description: 'Search literal text in source files in the reader project. Reports coverage limits. Prefer available CodeGraph symbol/caller tools for structural analysis.',
    inputSchema: { sessionId: id, query: z.string().min(2).max(200) }, annotations, _meta: modelOnly,
  }, ({ sessionId, query }) => guard(() => store.repository(sessionId).search(query)));
  const close = server.close.bind(server);
  server.close = async () => { folders.close(); store.close(); await close(); };
  return server;
}

if (process.argv.includes('--stdio')) {
  const html = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reader.html');
  const server = createReaderServer(html);
  await server.connect(new StdioServerTransport());
  let closed = false;
  const close = () => { if (closed) return; closed = true; void server.close().finally(() => process.exit(0)); };
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}
