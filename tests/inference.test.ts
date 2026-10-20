import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReaderModel } from '../src/inference/codex.js';
import { ModelPreferences } from '../src/inference/preferences.js';
import { ReaderStore } from '../src/explanations/store.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('a custom provider uses its configured model even when the built-in catalogue advertises fast models', () => {
  const catalogue = [{ model: 'gpt-6.1-sol', isDefault: true }, { model: 'gpt-6-luna' }];
  assert.equal(selectReaderModel({ model: 'custom-model', model_provider: 'custom' }, catalogue), 'custom-model');
  assert.equal(selectReaderModel({ model: 'configured', model_provider: 'openai' }, catalogue), 'gpt-6-luna');
  assert.equal(selectReaderModel({ model: 'configured', model_provider: 'custom' }, catalogue, 'explicit-model'), 'explicit-model');
  assert.equal(selectReaderModel({}, [{ model: 'fallback', isDefault: true }]), 'fallback');
});

test('model preference persists for new readers, preserves open reader choices and recovers from invalid data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-models-'));
  const file = path.join(root, 'model.json');
  const preferences = new ModelPreferences(file);
  const store = new ReaderStore(undefined, preferences);
  try {
    assert.equal(await preferences.read(), null);
    const old = await store.create();
    await store.setModel(old.sessionId, 'provider/model-a');
    assert.equal((await new ReaderStore(undefined, new ModelPreferences(file)).create()).model, 'provider/model-a');
    const newer = await store.create();
    await store.setModel(newer.sessionId, null);
    // Connecting a project preserves the model of an already open reader.
    assert.equal((await store.connect(old.sessionId, root)).model, 'provider/model-a');
    assert.equal((await store.create()).model, null);
    await assert.rejects(() => preferences.save('model with spaces'));
    await writeFile(file, '{broken'); assert.equal(await preferences.read(), null);
    await writeFile(file, JSON.stringify({ model: 123 })); assert.equal(await preferences.read(), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
