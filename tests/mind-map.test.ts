import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/project/repository.js';
import { parseSymbols } from '../src/project/symbols.js';
import { MindMapIndex, resolveImportPath } from '../src/project/mind-map.js';
import { mindLayout, expandAncestors } from '../src/ui/mind-layout.js';
import type { Inference, InferenceRequest } from '../src/inference/codex.js';
import type { MindJob } from '../src/shared/mind-map.js';

class Backend implements Inference {
  requests: InferenceRequest[] = [];
  handler: (r: InferenceRequest) => Promise<string> = async r => {
    const evidence = JSON.parse(r.prompt.slice(r.prompt.indexOf('\n') + 1)).nodes;
    return JSON.stringify({ nodes: evidence.map((n: any) => ({ id: n.id, summary: `作用：${n.name}`, inputs: [], outputs: [], steps: ['执行源码逻辑'], cautions: [] })) });
  };
  generate(r: InferenceRequest) { this.requests.push(r); return this.handler(r); }
  close() {}
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-reader-mind-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/rates.ts'), 'export const rate = (n: number) => n * 0.9;\n');
  await writeFile(path.join(root, 'src/cart.ts'), '/** 购物车金额服务。 */\nimport { rate } from "./rates.js";\nexport class Cart {\n  total(n: number) { return rate(n); }\n  checkout(n: number) { return this.total(n); }\n}\n');
  const repository = await Repository.open(root); const backend = new Backend();
  let background = '关注金额计算';
  const index = new MindMapIndex(repository, backend, () => background);
  return { root, repository, backend, index, context: (s: string) => { background = s; }, cleanup: async () => { index.close(); await rm(root, { recursive: true, force: true }); } };
}
async function finished(index: MindMapIndex, job: MindJob) {
  for (let n = 0; n < 200; n++) { const result = index.poll(job.id); if (result.status !== 'pending') return result; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Mind-map job never settled');
}

test('TS syntax keeps callbacks and named nested functions in their own return scopes', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, 'src/scopes.ts'), 'export function outer(xs: number[]) {\n  const nested = () => 42;\n  const mapped = xs.map(x => { return x + 1; });\n  function inner() { return "inner"; }\n  return mapped;\n}\nclass Controller {\n  run = (x: number) => x * 2;\n}\n');
    const parsed = parseSymbols(await f.repository.read('src/scopes.ts'));
    assert.equal(parsed.hasErrors, false);
    const outer = parsed.nodes.find(n => n.name === 'outer')!;
    assert.deepEqual(outer.returns, ['mapped']); assert.deepEqual(outer.calls, ['xs.map']);
    assert.deepEqual(parsed.nodes.find(n => n.name === 'nested')!.returns, ['42']);
    assert.equal(parsed.nodes.find(n => n.name === 'inner')!.parentId, outer.id);
    const method = parsed.nodes.find(n => n.name === 'run')!;
    assert.equal(method.kind, 'method'); assert.equal(method.line, 8); assert.deepEqual(method.returns, ['x * 2']);
    assert.ok(parsed.nodes.every(n => n.endLine! >= n.line!));
  } finally { await f.cleanup(); }
});

test('Python decorators, docstrings, method ownership, imports and nested functions retain real locations', async () => {
  const f = await fixture();
  try {
    const source = 'from .rates import rate as discount\n@decorate\nclass Cart(Base):\n    """购物车服务。"""\n    async def total(self, amount: float = 1) -> float:\n        """计算应付金额。"""\n        def helper():\n            return 99\n        return discount(amount)\n';
    await writeFile(path.join(f.root, 'src/cart.py'), source);
    const parsed = parseSymbols(await f.repository.read('src/cart.py'));
    const klass = parsed.nodes.find(n => n.kind === 'class')!; const method = parsed.nodes.find(n => n.name === 'total')!;
    assert.equal(parsed.hasErrors, false); assert.equal(klass.line, 2); assert.equal(klass.summary, '购物车服务。');
    assert.deepEqual(klass.bases, ['Base']); assert.equal(method.parentId, klass.id); assert.equal(method.line, 5); assert.equal(method.endLine, 9);
    assert.equal(method.summary, '计算应付金额。'); assert.ok(!method.returns!.includes('99')); assert.ok(method.returns!.includes('discount(amount)'));
    assert.deepEqual(method.calls, ['discount']); assert.equal(parsed.nodes.find(n => n.name === 'helper')!.kind, 'function');
    assert.deepEqual(parsed.imports[0], { module: '.rates', names: [{ local: 'discount', imported: 'rate' }] });
  } finally { await f.cleanup(); }
});

test('map links local imports and self calls, refreshes source versions, and does not need inference', async () => {
  const f = await fixture();
  try {
    const map = await f.index.get(); const find = (name: string) => map.nodes.find(n => n.qualifiedName === name)!;
    assert.equal(map.coverage.symbols, 4); assert.equal(f.backend.requests.length, 0);
    assert.ok(map.edges.some(e => e.from === find('Cart.total').id && e.to === find('rate').id && e.kind === 'calls'));
    assert.ok(map.edges.some(e => e.from === find('Cart.checkout').id && e.to === find('Cart.total').id));
    assert.equal(resolveImportPath('src/cart.py', '.rates', new Set(['src/rates.py'])), 'src/rates.py');
    await writeFile(path.join(f.root, 'src/rates.ts'), '\nexport const rate = (n: number) => n * 0.8;\n');
    const fresh = await f.index.get(); assert.notEqual(fresh.version, map.version);
    assert.equal(fresh.nodes.find(n => n.name === 'rate')!.line, 2);
    await assert.rejects(f.index.start(find('rate').id, map.version), /变化/);
    assert.equal((await new MindMapIndex(f.repository, undefined, () => '').get()).coverage.symbols, 4);
  } finally { await f.cleanup(); }
});

test('independent summary uses actual source, caches by context, and rejects invented IDs', async () => {
  const f = await fixture();
  try {
    let map = await f.index.get(); let node = map.nodes.find(n => n.name === 'total')!;
    const result = await finished(f.index, await f.index.start(node.id, map.version));
    assert.equal(result.status, 'complete'); assert.equal(result.analyses.length, 1);
    assert.ok(f.backend.requests[0].prompt.includes('return rate(n)')); assert.ok(f.backend.requests[0].prompt.includes('关注金额计算'));
    const payload = JSON.parse(f.backend.requests[0].prompt.split('\n').slice(1).join('\n'));
    assert.ok(payload.related.some((r: any) => r.path === 'src/rates.ts' && r.source.includes('n * 0.9')));
    assert.equal((await finished(f.index, await f.index.start(node.id, map.version))).status, 'complete');
    assert.equal(f.backend.requests.length, 1);
    f.context('关注调用方'); map = await f.index.get(); node = map.nodes.find(n => n.name === 'total')!;
    assert.equal(node.analysis, undefined);
    f.backend.handler = async () => JSON.stringify({ nodes: [{ id: 'invented', summary: '错', inputs: [], outputs: [], steps: [], cautions: [] }] });
    assert.equal((await finished(f.index, await f.index.start(node.id, map.version))).status, 'failed');
    assert.equal((await f.index.get()).nodes.find(n => n.id === node.id)!.analysis, undefined);
  } finally { await f.cleanup(); }
});

test('framework constrains references; changed sources and cancelled jobs cannot publish late results', async () => {
  const f = await fixture();
  try {
    const map = await f.index.get();
    f.backend.handler = async () => JSON.stringify({ summary: '金额服务框架', layers: [{ name: '计算层', responsibility: '计算金额', nodeIds: [map.rootId, 'invented'] }], flow: ['输入金额，调用费率'], coverage: '目录及实际给定片段' });
    const framework = await finished(f.index, await f.index.start(map.rootId, map.version));
    assert.equal(framework.status, 'complete'); assert.deepEqual(framework.architecture!.layers[0].nodeIds, [map.rootId]);
    const node = map.nodes.find(n => n.name === 'rate')!;
    let release: (s: string) => void = () => {}; f.backend.handler = () => new Promise(resolve => { release = resolve; });
    const stale = await f.index.start(node.id, map.version);
    while (f.backend.requests.length < 2) await new Promise(r => setTimeout(r, 5));
    await writeFile(path.join(f.root, 'src/rates.ts'), 'export const rate = () => 1;\n');
    release(JSON.stringify({ nodes: [{ id: node.id, summary: '旧结果', inputs: [], outputs: [], steps: [], cautions: [] }] }));
    assert.equal((await finished(f.index, stale)).status, 'stale');
    const fresh = await f.index.get(); const target = fresh.nodes.find(n => n.name === 'rate')!;
    const cancelled = await f.index.start(target.id, fresh.version);
    while (f.backend.requests.length < 3) await new Promise(r => setTimeout(r, 5));
    f.index.cancel(cancelled.id); assert.equal(f.backend.requests[2].signal.aborted, true);
    release(JSON.stringify({ nodes: [{ id: target.id, summary: '已取消结果', inputs: [], outputs: [], steps: [], cautions: [] }] }));
    await new Promise(r => setTimeout(r, 10));
    assert.equal(f.index.poll(cancelled.id).status, 'cancelled'); assert.equal((await f.index.get()).nodes.find(n => n.id === target.id)!.analysis, undefined);
  } finally { await f.cleanup(); }
});

test('search reveals collapsed ancestors, caps visible nodes, and keeps expansion paths', async () => {
  const f = await fixture();
  try {
    const map = await f.index.get(); const target = map.nodes.find(n => n.name === 'checkout')!;
    const layout = mindLayout(map.nodes, map.rootId, new Set(), 'checkout');
    assert.ok(layout.positions.some(p => p.node.id === target.id)); assert.ok(layout.positions.every(p => p.x >= 24 && p.y >= 24));
    assert.equal(mindLayout(map.nodes, map.rootId, new Set()).positions.length, 1);
    const expanded = expandAncestors(map.nodes, target.id); assert.ok(expanded.has(map.rootId)); assert.ok(expanded.has(target.parentId!));
    assert.equal(mindLayout(map.nodes, map.rootId, expanded, '', 2).truncated, true);
  } finally { await f.cleanup(); }
});
