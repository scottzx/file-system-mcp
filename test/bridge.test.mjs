import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FilesystemBridge, validateRoots } from '../src/bridge.mjs';
import { startServer, localAgentUrl } from '../src/server.mjs';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'filesystem-mcp-test-'));
  const root = path.join(base, '项目 with spaces');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const bridge = new FilesystemBridge({ roots: [root], ...options });
  t.after(async () => { await bridge.close(); await fs.rm(base, { recursive: true, force: true }); });
  await bridge.start();
  return { base, root, outside, bridge };
}
function text(result) { return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'); }
function ok(result) { assert.notEqual(result.isError, true, text(result)); return result; }

test('official tools: create, write, read, preview/edit, search, tree, metadata and move', async (t) => {
  const { root, bridge } = await fixture(t);
  const dir = path.join(root, 'nested/deep');
  const file = path.join(dir, '你好.txt');
  assert.equal(Object.keys(bridge.methods).length, 14);
  assert.equal(bridge.methods['filesystem.write_file'].parameters.type, 'object');
  assert.ok(bridge.methods['filesystem.read_text_file'].returns);
  ok(await bridge.invoke('filesystem.create_directory', { path: dir }));
  ok(await bridge.invoke('filesystem.write_file', { path: file, content: 'first\nsecond\n第三行\n' }));
  const result = ok(await bridge.invoke('filesystem.read_text_file', { path: file, head: 2 }));
  assert.equal(text(result), 'first\nsecond');
  assert.equal(result.structuredContent.content, 'first\nsecond');
  const edits = [{ oldText: 'second', newText: 'changed' }];
  assert.match(text(ok(await bridge.invoke('filesystem.edit_file', { path: file, edits, dryRun: true }))), /changed/);
  assert.match(await fs.readFile(file, 'utf8'), /second/);
  ok(await bridge.invoke('filesystem.edit_file', { path: file, edits }));
  assert.match(await fs.readFile(file, 'utf8'), /changed/);
  assert.match(text(ok(await bridge.invoke('filesystem.search_files', { path: root, pattern: '**/*.txt' }))), /你好\.txt/);
  assert.match(text(ok(await bridge.invoke('filesystem.directory_tree', { path: root }))), /你好\.txt/);
  assert.match(text(ok(await bridge.invoke('filesystem.list_directory_with_sizes', { path: dir }))), /你好\.txt/);
  assert.match(text(ok(await bridge.invoke('filesystem.get_file_info', { path: file }))), /size/i);
  assert.match(text(ok(await bridge.invoke('filesystem.read_multiple_files', { paths: [file] }))), /changed/);
  const destination = path.join(dir, 'renamed.txt');
  ok(await bridge.invoke('filesystem.move_file', { source: file, destination }));
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.match(await fs.readFile(destination, 'utf8'), /changed/);
  assert.equal((await bridge.invoke('filesystem.move_file', { source: destination, destination })).isError, true);
});

test('reject traversal, prefix siblings, external symlink reads/writes and nested creation', async (t) => {
  const { root, outside, bridge } = await fixture(t);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'outside data');
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(secret, path.join(root, 'file-link'));
  await fs.mkdir(root + '-sibling');
  for (const target of [secret, path.join(root, '../outside/secret.txt'), path.join(root, 'escape/secret.txt'), path.join(root, 'file-link'), root + '-sibling/file.txt']) {
    assert.equal((await bridge.invoke('filesystem.read_text_file', { path: target })).isError, true, target);
    assert.equal((await bridge.invoke('filesystem.write_file', { path: target, content: 'bad' })).isError, true, target);
  }
  assert.equal((await bridge.invoke('filesystem.create_directory', { path: path.join(root, 'escape/new/deep') })).isError, true);
  assert.equal(await fs.readFile(secret, 'utf8'), 'outside data');
  await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
});

test('read-only mode removes and denies every mutating method and raw-name alias', async (t) => {
  const { root, bridge } = await fixture(t, { readOnly: true });
  const file = path.join(root, 'data.txt');
  await fs.writeFile(file, 'keep');
  assert.equal(bridge.tools.length, 10);
  assert.equal(bridge.methods['filesystem.write_file'], undefined);
  for (const method of ['write_file', 'filesystem.write_file', 'edit_file', 'create_directory', 'move_file']) {
    assert.equal((await bridge.invoke(method, { path: file, content: 'bad' })).isError, true);
  }
  assert.equal(text(ok(await bridge.invoke('filesystem.read_text_file', { path: file }))), 'keep');
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});

test('media blocks are forwarded intact', async (t) => {
  const { root, bridge } = await fixture(t);
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9n0AAAAASUVORK5CYII=';
  const file = path.join(root, 'pixel.png');
  await fs.writeFile(file, Buffer.from(data, 'base64'));
  const result = ok(await bridge.invoke('filesystem.read_media_file', { path: file }));
  const block = result.content.find((entry) => entry.type === 'image');
  assert.equal(block.mimeType, 'image/png');
  assert.equal(block.data, data);
});

test('validation failures retain MCP isError; no roots means no ambient access', async (t) => {
  const { bridge } = await fixture(t);
  await assert.rejects(validateRoots([]), /at least one/);
  await assert.rejects(validateRoots(['']), /non-empty/);
  assert.equal((await bridge.invoke('filesystem.write_file', { path: 12, content: 'bad' })).isError, true);
  assert.equal((await bridge.invoke('filesystem.not_a_tool')).isError, true);
  assert.equal((await bridge.invoke(null)).isError, true);
  assert.equal((await bridge.invoke('filesystem.list_allowed_directories', [])).isError, true);
  assert.equal((await bridge.invoke('filesystem.list_allowed_directories', null)).isError, true);
});

test('multiple roots including macOS /tmp symlink work', async (t) => {
  const { root, outside } = await fixture(t);
  const bridge = new FilesystemBridge({ roots: [root, outside] });
  t.after(() => bridge.close());
  await bridge.start();
  const target = path.join(outside, 'second-root.txt');
  ok(await bridge.invoke('filesystem.write_file', { path: target, content: 'second root' }));
  assert.equal(text(ok(await bridge.invoke('filesystem.read_text_file', { path: target }))), 'second root');
});

test('stdio MCP preserves tools/results and does not let client Roots widen access', async (t) => {
  const { root, outside } = await fixture(t);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'outside');
  let rootRequests = 0;
  const client = new Client({ name: 'test-client', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => { rootRequests++; return { roots: [{ uri: 'file://' + outside }] }; });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/file-system-mcp.mjs', import.meta.url)), 'mcp', '--root', root, '--read-only'],
    stderr: 'pipe',
  });
  transport.stderr.on('data', () => {});
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 10);
  assert.equal((await client.callTool({ name: 'read_text_file', arguments: { path: secret } })).isError, true);
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: path.join(root, 'bad.txt'), content: 'bad' } })).isError, true);
  assert.equal(rootRequests, 0);
});

test('HTTP registration, invocation, bad requests, gateway re-registration and shutdown', async (t) => {
  const { root, bridge } = await fixture(t);
  const registrations = new Map();
  let count = 0;
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks));
      registrations.set(body.id, body); count++;
    } else if (req.method === 'DELETE') registrations.delete(decodeURIComponent(req.url.split('/').at(-1)));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { services: [...registrations.values()] } : { ok: true }));
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const running = await startServer(bridge, { port: 0, agent: `http://127.0.0.1:${gateway.address().port}`, registrationIntervalMs: 60_000, bodyLimit: 512, log: () => {} });
  t.after(() => running.stop());
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const registration = registrations.get('filesystem');
  assert.equal(registration.execution, 'http');
  assert.equal(registration.reachability, 'localhost');
  assert.equal(Object.keys(registration.methods).length, 14);
  assert.ok(registration.skills['file-system-mcp'].sop);
  assert.equal((await (await fetch(baseUrl + '/health')).json()).registered, true);
  const file = path.join(root, 'http.txt');
  const result = await (await fetch(baseUrl + '/invoke', { method: 'POST', body: JSON.stringify({ method: 'filesystem.write_file', params: { path: file, content: 'via HTTP' } }) })).json();
  ok(result);
  assert.equal(await fs.readFile(file, 'utf8'), 'via HTTP');
  const failure = await (await fetch(baseUrl + '/invoke', { method: 'POST', body: JSON.stringify({ method: 'filesystem.read_text_file', params: { path: path.join(root, 'missing') } }) })).json();
  assert.equal(failure.isError, true);
  assert.equal((await fetch(baseUrl + '/invoke', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(baseUrl + '/invoke', { method: 'POST', body: '[]' })).status, 400);
  assert.equal((await fetch(baseUrl + '/invoke', { method: 'POST', body: 'x'.repeat(1024) })).status, 413);
  assert.equal((await fetch(baseUrl + '/invoke', { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' })).status, 403);
  registrations.clear();
  await running.register();
  assert.equal(count, 2);
  assert.ok(registrations.has('filesystem'));
  await running.stop();
  assert.equal(registrations.has('filesystem'), false);
  assert.equal(bridge.ready, false);
});

test('reject remote registration endpoints', () => {
  assert.equal(localAgentUrl('http://127.0.0.1:36908'), 'http://127.0.0.1:36908');
  assert.throws(() => localAgentUrl('http://remote-node:36908'), /local HTTP/);
  assert.throws(() => localAgentUrl('https://localhost:36908'), /local HTTP/);
});
