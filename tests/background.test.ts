import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReaderStore } from '../src/explanations/store.js';
import { PurposeIndex, describeFile } from '../src/project/purposes.js';
import { Repository } from '../src/project/repository.js';
import type { Inference, InferenceRequest } from '../src/inference/codex.js';
import type { JobView } from '../src/shared/contracts.js';

const reply = { summary: '使用费率计算金额。', steps: ['调用 rate 并返回。'], inputs: ['amount'], outputs: ['金额'], citations: [{ path: 'main.py', line: 3, description: '计算函数' }], cautions: [], coverage: '已检查 main.py 和 rates.py。' };
class Backend implements Inference {
  requests: InferenceRequest[] = [];
  handler = async (_r: InferenceRequest): Promise<string> => JSON.stringify(reply);
  generate(r: InferenceRequest) { this.requests.push(r); return this.handler(r); }
  close() {}
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-reader-background-'));
  await writeFile(path.join(root, 'main.py'), '"""计算订单应付金额。"""\nfrom rates import rate\ndef total(amount):\n    return amount * rate()\n');
  await writeFile(path.join(root, 'rates.py'), 'def rate():\n    return 0.9\n');
  await writeFile(path.join(root, 'README.md'), '订单金额项目。');
  const backend = new Backend(); const store = new ReaderStore(backend);
  const seed = await store.create(root, '关注金额与费率。');
  const file = await store.repository(seed.sessionId).read('main.py');
  const input = { path: file.path, from: file.text.indexOf('def total'), to: file.text.length, version: file.version, question: '解释' };
  return { root, store, backend, id: seed.sessionId, input, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
async function finished(store: ReaderStore, id: string, job: JobView) {
  for (let n = 0; n < 100; n++) { const result = await store.poll(id, job.id); if (result.status !== 'pending') return result; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Background job never settled');
}

test('background completes without chat publishing, caches exact context, and invalidates changed dependencies', async () => {
  const f = await fixture();
  try {
    const first = await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(first.status, 'complete'); assert.equal(first.explanation?.summary, reply.summary);
    const prompt = JSON.parse(f.backend.requests[0].prompt);
    assert.equal(prompt.background, '关注金额与费率。');
    assert.ok(prompt.related.sources.some((s: any) => s.path === 'rates.py' && s.text.includes('return 0.9')));
    const cached = await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(cached.cached, true); assert.equal(f.backend.requests.length, 1);
    await writeFile(path.join(f.root, 'rates.py'), 'def rate():\n    return 0.8\n');
    assert.equal((await f.store.poll(f.id, first.id)).status, 'stale');
    await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(f.backend.requests.length, 2);
    f.store.updateContext(f.id, '关注舍入误差。');
    await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(f.backend.requests.length, 3);
    assert.equal(JSON.parse(f.backend.requests[2].prompt).background, '关注舍入误差。');
  } finally { await f.cleanup(); }
});

test('new selection aborts old inference and late responses cannot replace its result', async () => {
  const f = await fixture();
  try {
    let late: (s: string) => void = () => {};
    f.backend.handler = () => new Promise(resolve => { late = resolve; });
    const old = await f.store.request(f.id, f.input);
    while (!f.backend.requests.length) await new Promise(r => setTimeout(r, 5));
    const signal = f.backend.requests[0].signal;
    f.backend.handler = async () => JSON.stringify(reply);
    const current = await f.store.request(f.id, { ...f.input, question: '举例' });
    assert.equal(signal.aborted, true);
    late(JSON.stringify({ ...reply, summary: '不应写入的旧结果' }));
    assert.equal((await f.store.poll(f.id, old.id)).status, 'cancelled');
    assert.equal((await finished(f.store, f.id, current)).explanation?.summary, reply.summary);
  } finally { await f.cleanup(); }
});

test('source changes during inference and backend failures stay in the popup job', async () => {
  const f = await fixture();
  try {
    f.backend.handler = async () => { await writeFile(path.join(f.root, 'rates.py'), 'def rate():\n    return 1\n'); return JSON.stringify(reply); };
    assert.equal((await finished(f.store, f.id, await f.store.request(f.id, f.input))).status, 'stale');
    f.backend.handler = async () => { throw new Error('provider failure with private details'); };
    const failed = await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(failed.status, 'failed'); assert.ok(!failed.error?.includes('private details'));
  } finally { await f.cleanup(); }
});

test('directory purpose uses source immediately, batches AI, and refreshes changed files', async () => {
  const f = await fixture();
  try {
    const repository = await Repository.open(f.root); const index = new PurposeIndex(repository, f.backend);
    const local = await index.get(['main.py', 'rates.py']);
    assert.equal(local['main.py'].text, '计算订单应付金额。'); assert.equal(local['main.py'].basis, 'source');
    assert.ok(describeFile(await repository.read('rates.py')).text.includes('rate'));
    f.backend.handler = async () => JSON.stringify({ files: [{ path: 'main.py', text: '结合费率计算订单应付金额。' }, { path: 'outside.py', text: '不能写入' }] });
    const result = await index.improve(['main.py', 'rates.py'], new AbortController().signal, '订单项目');
    assert.equal(result['main.py'].basis, 'ai'); assert.ok(!result['outside.py']);
    await index.improve(['main.py'], new AbortController().signal, '订单项目');
    assert.equal(f.backend.requests.length, 1);
    await writeFile(path.join(f.root, 'main.py'), '"""导出订单。"""\n');
    const changed = await index.get(['main.py']);
    assert.equal(changed['main.py'].basis, 'source'); assert.equal(changed['main.py'].text, '导出订单。');
  } finally { await f.cleanup(); }
});

test('model selection reaches explanations, file purposes and map summaries without reusing another model cache', async () => {
  const f = await fixture();
  try {
    await f.store.setModel(f.id, 'provider/model-a');
    const first = await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(first.status, 'complete'); assert.equal(f.backend.requests.at(-1)!.model, 'provider/model-a');
    const other = await f.store.create(f.root);
    assert.equal(other.model, null);
    await f.store.setModel(f.id, 'model-b');
    assert.equal((await f.store.poll(f.id, first.id)).status, 'stale');
    const second = await finished(f.store, f.id, await f.store.request(f.id, f.input));
    assert.equal(second.status, 'complete'); assert.notEqual(second.cached, true);
    assert.equal(f.backend.requests.at(-1)!.model, 'model-b');
    f.backend.handler = async () => JSON.stringify({ files: [{ path: 'main.py', text: '解释文件用途。' }] });
    await f.store.purposes(f.id, ['main.py'], true);
    assert.equal(f.backend.requests.at(-1)!.model, 'model-b');
    const index = f.store.mindMap(f.id), map = await index.get(), node = map.nodes.find(n => n.name === 'total')!;
    f.backend.handler = async () => JSON.stringify({ nodes: [{ id: node.id, summary: '计算金额。', inputs: [], outputs: [], steps: [], cautions: [] }] });
    const job = await index.start(node.id, map.version);
    let result = await index.poll(job.id);
    for (let n = 0; n < 100 && result.status === 'pending'; n++) { await new Promise(r => setTimeout(r, 10)); result = await index.poll(job.id); }
    assert.equal(result.status, 'complete'); assert.equal(f.backend.requests.at(-1)!.model, 'model-b');
    let release: (text: string) => void = () => {};
    f.backend.handler = () => new Promise(resolve => { release = resolve; });
    const count = f.backend.requests.length;
    const pending = await f.store.request(f.id, { ...f.input, question: 'different question' });
    for (let n = 0; n < 100 && f.backend.requests.length === count; n++) await new Promise(r => setTimeout(r, 5));
    const signal = f.backend.requests.at(-1)!.signal;
    await f.store.setModel(f.id, null);
    assert.equal(signal.aborted, true); assert.equal((await f.store.poll(f.id, pending.id)).status, 'cancelled');
    release(JSON.stringify(reply));
    assert.equal((await f.store.mindMap(f.id).get()).nodes.find(n => n.name === 'total')!.analysis, undefined);
    await assert.rejects(() => f.store.setModel(f.id, 'bad\nmodel'));
  } finally { await f.cleanup(); }
});
