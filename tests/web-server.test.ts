import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebServer } from '../src/web/server.js';

test('standalone HTTP reader secures local file tools, supports API settings without returning keys, resumes tabs and invalidates provider caches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-web-integration-'));
  await writeFile(path.join(root, 'main.py'), 'def total(value):\n    return value * 2\n');
  const models: string[] = []; const secret = 'fixture-private-key';
  const provider = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'api-model-a' }, { id: 'api-model-b' }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()); models.push(request.model);
    const answer = request.messages[0].content.includes('"ok"') ? { ok: true } : { summary: '将输入乘以二。', inputs: ['value'], outputs: ['两倍值'], steps: ['乘以二并返回'], citations: [{ path: 'main.py', line: 1, description: '函数定义' }], cautions: [], coverage: 'main.py' };
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const app = await createWebServer({ htmlPath: path.resolve('dist/web/reader.html'), stateDirectory: path.join(root, 'prefs'), root });
  try {
    const origin = await app.listen(0);
    const bootstrap = await (await fetch(origin + '/api/bootstrap')).json(); const id = bootstrap.seed.sessionId;
    const second = await (await fetch(origin + '/api/bootstrap')).json(); assert.notEqual(second.seed.sessionId, id);
    assert.equal((await (await fetch(origin + '/api/bootstrap?session=' + id)).json()).seed.sessionId, id);
    assert.equal((await fetch(origin + '/health')).status, 200);
    const html = await fetch(origin); assert.equal(html.headers.get('x-frame-options'), 'DENY'); assert.ok((await html.text()).includes('代码随读'));
    assert.equal((await fetch(origin + '/api/provider')).status, 403);
    assert.equal((await fetch(origin + '/api/bootstrap', { headers: { Origin: 'https://untrusted.test' } })).status, 403);
    const post = async (route: string, data: unknown) => {
      const response = await fetch(origin + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Reader-Token': bootstrap.token }, body: JSON.stringify(data) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await post('/api/tools', { name, arguments: { sessionId: id, ...args } }); assert.ok(!result.isError, JSON.stringify(result.content)); return result.structuredContent;
    };
    assert.equal((await fetch(origin + '/api/tools', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Token': bootstrap.token }, body: JSON.stringify({ name: 'open_reader' }) })).status, 403);
    const denied = await post('/api/tools', { name: 'read_file', arguments: { sessionId: id, path: '../outside.py' } }); assert.equal(denied.isError, true);
    assert.ok((await call('browse_folders', { path: root })).folders.some((f: any) => f.name === 'prefs'));
    const draft = { mode: 'api', baseUrl: `http://127.0.0.1:${(provider.address() as any).port}/v1`, apiKey: secret, model: 'api-model-a', stream: false, rememberKey: false };
    assert.equal((await post('/api/provider/models', draft)).models.length, 2);
    assert.equal((await app.settings.state()).keySet, false); // Reading a draft list must not save credentials.
    const state = await post('/api/provider', draft); assert.equal(state.keySet, true); assert.ok(!JSON.stringify(state).includes(secret));
    assert.equal((await post('/api/provider/test', { ...draft, apiKey: undefined })).ok, true);
    const file = await call('read_file', { path: 'main.py' });
    const input = { path: file.path, from: 0, to: file.text.length, version: file.version, question: '解释' };
    const explain = async () => {
      const job = await call('request_explanation', input);
      for (let n = 0; n < 100; n++) { const next = await call('get_explanation', { jobId: job.id }); if (next.status !== 'pending') { assert.equal(next.status, 'complete'); return next; } await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error('Web background explanation timed out');
    };
    const old = await explain(); assert.equal(old.explanation.summary, '将输入乘以二。');
    const saved = await post('/api/provider', { ...draft, apiKey: undefined, model: 'api-model-b' }); assert.notEqual(saved.revision, state.revision);
    assert.equal((await call('get_explanation', { jobId: old.id })).status, 'stale');
    const newer = await explain(); assert.notEqual(newer.cached, true); assert.equal(models.at(-1), 'api-model-b');
    const publicSettings = await (await fetch(origin + '/api/provider', { headers: { 'X-Reader-Token': bootstrap.token } })).text(); assert.ok(!publicSettings.includes(secret));
  } finally { await app.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
