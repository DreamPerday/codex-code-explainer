import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/project/repository.js';
import { ReaderStore } from '../src/explanations/store.js';
import type { Explanation } from '../src/shared/contracts.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-explainer-test-'));
  await writeFile(path.join(root, 'main.py'), '# 中文说明 🧭\r\ndef total(values):\r\n    return sum(values)\r\n');
  await writeFile(path.join(root, 'README.md'), 'A small code reader fixture.');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const explanation: Explanation = {
  summary: '计算数值集合的总和。', steps: ['调用 sum 对 values 求和并返回结果。'], inputs: ['values：可迭代数值集合'], outputs: ['数值总和'],
  citations: [{ path: 'main.py', line: 2, description: 'total 的定义' }], cautions: [], coverage: '阅读了 main.py；未运行程序。',
};

test('source reads preserve Chinese and emoji, normalize CRLF for editor offsets', async () => {
  const f = await fixture();
  try {
    const repository = await Repository.open(f.root);
    const file = await repository.read('main.py');
    assert.equal(file.text, '# 中文说明 🧭\ndef total(values):\n    return sum(values)\n');
    const store = new ReaderStore();
    const { sessionId } = await store.create(f.root);
    const from = file.text.indexOf('def');
    const to = file.text.indexOf('\n', from) + 1;
    const job = await store.request(sessionId, { path: 'main.py', from, to, version: file.version, question: '解释' });
    assert.equal(job.startLine, 2); assert.equal(job.endLine, 2);
    const context = await store.context(sessionId, job.id);
    assert.equal(context.selection, 'def total(values):\n');
    assert.ok(context.source.text.includes('2: def total(values):'));
  } finally { await f.cleanup(); }
});

test('paths outside the project, secrets, binary and invalid UTF-8 cannot be read', async () => {
  const f = await fixture();
  const outside = await fixture();
  try {
    const repository = await Repository.open(f.root);
    await writeFile(path.join(f.root, '.env'), 'SECRET=do-not-read');
    await writeFile(path.join(f.root, 'auth.json'), '{}');
    await writeFile(path.join(f.root, 'binary.py'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(f.root, 'bad.py'), Buffer.from([255, 254, 253]));
    await mkdir(path.join(f.root, 'external'));
    await symlink(outside.root, path.join(f.root, 'linked'), 'junction');
    for (const file of ['.env', 'auth.json', 'binary.py', 'bad.py', 'linked/main.py', path.join(outside.root, 'main.py'), '../' + path.basename(outside.root) + '/main.py']) {
      await assert.rejects(() => repository.read(file), { name: 'ReaderError' }, file);
    }
    const inventory = await repository.inventory();
    assert.ok(!inventory.files.includes('.env'));
    assert.ok(!inventory.files.some(s => s.startsWith('linked/')));
  } finally { await f.cleanup(); await outside.cleanup(); }
});

test('publishing fills only the matching reader session and is invalidated on source changes', async () => {
  const f = await fixture();
  try {
    const store = new ReaderStore();
    const { sessionId } = await store.create(f.root);
    const other = await store.create(f.root);
    const file = await store.repository(sessionId).read('main.py');
    const job = await store.request(sessionId, { path: file.path, from: file.text.indexOf('def'), to: file.text.length, version: file.version, question: '解释' });
    await assert.rejects(() => store.context(other.sessionId, job.id));
    await store.publish(sessionId, job.id, explanation);
    assert.equal((await store.poll(sessionId, job.id)).explanation?.summary, explanation.summary);
    await assert.rejects(() => store.publish(sessionId, job.id, explanation));
    await writeFile(path.join(f.root, 'main.py'), 'def total(values):\n    return 0\n');
    const stale = await store.poll(sessionId, job.id);
    assert.equal(stale.status, 'stale'); assert.equal(stale.explanation, undefined);
  } finally { await f.cleanup(); }
});

test('stale selections and cancelled jobs cannot produce misleading results', async () => {
  const f = await fixture();
  try {
    const store = new ReaderStore();
    const { sessionId } = await store.create(f.root);
    const file = await store.repository(sessionId).read('main.py');
    for (const [from, to] of [[-1, 5], [5, 5], [0, file.text.length + 1]]) {
      await assert.rejects(() => store.request(sessionId, { path: file.path, from, to, version: file.version, question: '解释' }));
    }
    const job = await store.request(sessionId, { path: file.path, from: 0, to: 5, version: file.version, question: '解释' });
    store.cancel(sessionId, job.id);
    await assert.rejects(() => store.publish(sessionId, job.id, explanation));
    assert.equal((await store.poll(sessionId, job.id)).status, 'cancelled');
    await writeFile(path.join(f.root, 'main.py'), '# changed');
    await assert.rejects(() => store.request(sessionId, { path: file.path, from: 0, to: 5, version: file.version, question: '解释' }));
  } finally { await f.cleanup(); }
});

test('invalid source citations are rejected before publishing', async () => {
  const f = await fixture();
  try {
    const store = new ReaderStore();
    const { sessionId } = await store.create(f.root);
    const file = await store.repository(sessionId).read('main.py');
    const job = await store.request(sessionId, { path: file.path, from: 0, to: 5, version: file.version, question: '解释' });
    await assert.rejects(() => store.publish(sessionId, job.id, { ...explanation, citations: [{ path: 'main.py', line: 1000, description: '不存在' }] }));
    assert.equal((await store.poll(sessionId, job.id)).status, 'pending');
  } finally { await f.cleanup(); }
});
