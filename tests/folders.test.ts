import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FolderBrowser } from '../src/project/folders.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-reader-folders-'));
  const stateFile = path.join(root, 'preferences', 'recent-projects.json');
  const browser = new FolderBrowser(stateFile);
  return { root, stateFile, browser, cleanup: async () => { browser.close(); await rm(root, { recursive: true, force: true }); } };
}

test('folder browser handles Chinese and spaces, only lists directories, and provides real parents and breadcrumb targets', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, '中文 项目')); await mkdir(path.join(f.root, '其他项目')); await mkdir(path.join(f.root, '.git'));
    await writeFile(path.join(f.root, 'source.py'), 'print("hello")');
    const listing = await f.browser.list(f.root);
    assert.equal(listing.path, await realpath(f.root)); assert.equal(listing.parent, path.dirname(listing.path));
    assert.deepEqual(new Set(listing.folders.map(folder => folder.name)), new Set(['中文 项目', '其他项目']));
    assert.equal(listing.breadcrumbs.at(-1)?.path, listing.path);
    const child = await f.browser.list(listing.folders.find(folder => folder.name === '中文 项目')!.path);
    assert.equal(child.parent, listing.path); assert.equal(child.total, 0);
    assert.ok((await f.browser.list(f.root, '', true)).folders.some(folder => folder.name === '.git'));
    assert.equal((await f.browser.list(f.root, '中文')).total, 1);
    assert.equal(await f.browser.directory(`"${f.root}"`), listing.path);
    await assert.rejects(f.browser.list(path.join(f.root, 'source.py')), /路径是文件/);
    await assert.rejects(f.browser.list('relative/path'), /绝对路径/);
    await assert.rejects(f.browser.list(path.join(f.root, 'missing')), /无法访问/);
  } finally { await f.cleanup(); }
});

test('directory filtering searches beyond the displayed limit and symbolic links to files are excluded', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 405 }, (_, n) => mkdir(path.join(f.root, `项目${n}`))));
    await writeFile(path.join(f.root, 'notes.txt'), 'file');
    try { await symlink(path.join(f.root, 'notes.txt'), path.join(f.root, 'file-link')); } catch (error: any) { if (error.code !== 'EPERM') throw error; }
    const all = await f.browser.list(f.root);
    assert.equal(all.total, 405); assert.equal(all.folders.length, 400); assert.equal(all.truncated, true);
    const filtered = await f.browser.list(f.root, '项目404');
    assert.equal(filtered.folders[0]?.name, '项目404'); assert.equal(filtered.truncated, false);
  } finally { await f.cleanup(); }
});

test('recent projects persist, deduplicate canonical roots, preserve MRU order and recover from damaged preference data', async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.stateFile)); await writeFile(f.stateFile, 'not-json');
    assert.equal((await f.browser.locations()).recents.length, 0);
    const folders = Array.from({ length: 14 }, (_, n) => path.join(f.root, `项目 ${n}`));
    await Promise.all(folders.map(folder => mkdir(folder)));
    for (const folder of folders) await f.browser.remember(folder);
    await f.browser.remember(path.join(folders[4], '.'));
    const reloaded = new FolderBrowser(f.stateFile); const locations = await reloaded.locations();
    assert.equal(locations.recents.length, 12); assert.equal(locations.recents[0].path, await realpath(folders[4]));
    assert.equal(new Set(locations.recents.map(item => item.path)).size, 12);
    assert.equal(locations.recents[1].path, await realpath(folders[13]));
    assert.equal(JSON.parse(await readFile(f.stateFile, 'utf8')).length, 12);
    assert.ok(locations.shortcuts.some(item => item.kind === 'home')); assert.equal(typeof locations.nativeAvailable, 'boolean');
    await assert.rejects(f.browser.remember(path.join(f.root, 'missing')), /无法访问/);
    assert.equal((await f.browser.locations()).recents.length, 12);
  } finally { await f.cleanup(); }
});
