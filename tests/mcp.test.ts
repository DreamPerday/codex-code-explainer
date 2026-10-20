import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

test('packaged stdio MCP exposes the independent reader, source purposes and explicit context bridge', async () => {
  const client = new Client({ name: 'code-reader-integration-test', version: '1' });
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'code-reader-mcp-prefs-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/plugin/dist/server.mjs'), '--stdio'], stderr: 'pipe', env: { CODE_EXPLAINER_STATE_DIR: stateDir } });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const open = listed.tools.find(t => t.name === 'open_reader');
    assert.equal((open?._meta?.ui as { resourceUri?: string })?.resourceUri, 'ui://code-explainer/reader-v1.html');
    assert.ok(!listed.tools.some(t => ['publish_explanation', 'get_explanation_context'].includes(t.name)));
    const resource = await client.readResource({ uri: 'ui://code-explainer/reader-v1.html' });
    assert.ok('text' in resource.contents[0] && resource.contents[0].text.includes('代码随读'));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.structuredContent as Record<string, any>;
    };
    const seed = await call('open_reader', { root: process.cwd() });
    assert.ok(seed.project.files.includes('src/server.ts'));
    const blank = await call('open_reader', {});
    const folders = await call('browse_folders', { sessionId: blank.sessionId, path: process.cwd(), query: 'src' });
    assert.ok(folders.folders.some((folder: any) => folder.name === 'src'));
    const locations = await call('get_folder_locations', { sessionId: blank.sessionId });
    assert.ok(locations.recents.some((recent: any) => recent.path === folders.path));
    for (const name of ['browse_folders', 'get_folder_locations', 'pick_project_folder', 'cancel_folder_picker', 'get_reader_models', 'set_reader_model']) {
      assert.deepEqual((listed.tools.find(tool => tool.name === name)?._meta?.ui as any)?.visibility, ['app']);
    }
    const invalid = await client.callTool({ name: 'browse_folders', arguments: { sessionId: '00000000-0000-4000-8000-000000000000', path: process.cwd() } });
    assert.equal(invalid.isError, true);
    assert.equal((await call('set_reader_model', { sessionId: blank.sessionId, model: 'custom/model-test' })).model, 'custom/model-test');
    assert.equal((await call('open_reader', {})).model, 'custom/model-test');
    await call('set_reader_model', { sessionId: blank.sessionId, model: null });
    const badModel = await client.callTool({ name: 'set_reader_model', arguments: { sessionId: blank.sessionId, model: 'bad\nmodel' } });
    assert.equal(badModel.isError, true);
    const file = await call('read_file', { sessionId: seed.sessionId, path: 'src/shared/contracts.ts' });
    const purposes = await call('get_file_purposes', { sessionId: seed.sessionId, paths: [file.path] });
    assert.ok(purposes.purposes[file.path].text.length > 0);
    const { map } = await call('get_mind_map', { sessionId: seed.sessionId });
    const method = map.nodes.find((n: any) => n.qualifiedName === 'MindMapIndex.start');
    assert.equal(method.path, 'src/project/mind-map.ts');
    assert.ok(method.line > 1 && method.endLine >= method.line);
    assert.ok(map.edges.some((e: any) => e.kind === 'imports'));
    assert.equal((await call('update_reader_context', { sessionId: seed.sessionId, context: '关注输入参数的校验。' })).context, '关注输入参数的校验。');
  } finally { await client.close(); await rm(stateDir, { recursive: true, force: true }); }
});
