import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateApi, listApiModels } from '../src/web/api-inference.js';
import { ProviderConfigStore, apiBaseUrl, type ProviderConfig } from '../src/web/config.js';

const key = 'test-key-only-not-a-real-credential';
const config = (baseUrl: string): ProviderConfig => ({ mode: 'api', baseUrl, apiKey: key, model: 'fixture-model', stream: true, rememberKey: false });
async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const input = () => ({ prompt: '解释中文源码。', schema: { type: 'object', properties: { summary: { type: 'string' } } }, signal: new AbortController().signal });

test('compatible API streams fragmented Unicode, passes selected model and private authorization, and lists real response data', async () => {
  let received: any; let authorization: string | undefined;
  const final = JSON.stringify({ summary: '中文解释与 emoji 🧭' });
  const f = await fixture(async (req, res) => {
    authorization = req.headers.authorization;
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); received = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'text/event-stream');
    const wire = `:comment\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: final.slice(0, 12) } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: final.slice(12) }, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = Buffer.from(wire);
    for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await new Promise(resolve => setTimeout(resolve, 1)); }
    res.end();
  });
  try {
    assert.deepEqual((await listApiModels(config(f.url))).map(m => m.id), ['fixture-model']);
    const deltas: string[] = [];
    assert.equal(await generateApi(config(f.url), { ...input(), model: 'selected-model', onDelta: text => deltas.push(text) }), final);
    assert.equal(received.model, 'selected-model'); assert.equal(received.stream, true); assert.equal(authorization, `Bearer ${key}`);
    assert.ok(received.messages[0].content.includes('JSON Schema')); assert.ok(!received.tools); assert.ok(deltas.length >= 2);
  } finally { await f.close(); }
});

test('API handles non-streaming JSON and fenced results, redacts provider failures, and cancels streaming reads', async () => {
  let mode = 'json';
  const f = await fixture(async (_req, res) => {
    if (mode === 'error') { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: key } })); return; }
    if (mode === 'cancel') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"{"}}]}\n\n'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: mode === 'bad' ? 'not json' : '```json\n{"summary":"普通响应"}\n```' } }] }));
  });
  try {
    assert.equal(JSON.parse(await generateApi({ ...config(f.url), stream: false }, input())).summary, '普通响应');
    mode = 'error'; await assert.rejects(() => generateApi(config(f.url), input()), error => !String(error).includes(key) && String(error).includes('鉴权失败'));
    mode = 'bad'; await assert.rejects(() => generateApi(config(f.url), input()), /JSON/);
    mode = 'cancel'; const abort = new AbortController();
    await assert.rejects(() => generateApi(config(f.url), { ...input(), signal: abort.signal, onDelta: () => abort.abort() }), /取消/);
  } finally { await f.close(); }
});

test('provider preferences retain or forget keys as requested, never reuse a key at a different origin, and round-trip protected storage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reader-web-secret-'));
  try {
    const store = new ProviderConfigStore(directory), draft = { ...config('https://example.test/v1') };
    const first = await store.save(draft);
    assert.equal(first.keySet, true); assert.ok(!('apiKey' in first));
    assert.ok(!(await readFile(path.join(directory, 'provider.json'), 'utf8')).includes(key));
    assert.equal((await new ProviderConfigStore(directory).state()).keySet, false);
    assert.equal((await store.resolve({ ...draft, baseUrl: 'https://other.test/v1', apiKey: undefined })).apiKey, '');
    await store.save({ ...draft, rememberKey: true });
    assert.equal((await new ProviderConfigStore(directory).current()).apiKey, key);
    if (process.platform === 'win32') assert.ok(!(await readFile(path.join(directory, 'provider.json'), 'utf8')).includes(key));
    await store.save({ ...draft, apiKey: undefined, clearKey: true, rememberKey: true });
    assert.equal((await new ProviderConfigStore(directory).state()).keySet, false);
    await assert.rejects(() => store.save({ ...draft, baseUrl: 'https://user:password@example.test/v1' }));
    assert.equal(apiBaseUrl('https://example.test/v1/chat/completions/'), 'https://example.test/v1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
