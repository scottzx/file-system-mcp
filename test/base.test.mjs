import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBaseBridge, DEFAULT_PYTHON } from '../src/base-services.mjs';
import { isPublicAddress, validateFetchUrl, startFetchProxy, publicTarget } from '../src/fetch-proxy.mjs';
import { checkServicePort } from '../scripts/service.mjs';

function text(result) { return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'); }
function ok(result) { assert.notEqual(result.isError, true, text(result)); return result; }
async function dataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'base-mcp-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}

test('memory isolates projects, serializes concurrent writes, and survives restart', async (t) => {
  const dir = await dataDir(t);
  const bridge = await createBaseBridge('memory', { dataDir: dir }); t.after(() => bridge.close());
  await bridge.start();
  assert.equal(bridge.tools.length, 9);
  assert.ok(bridge.methods['memory.create_entities'].parameters.required.includes('namespace'));
  const create = (name) => bridge.invoke('memory.create_entities', { namespace: 'project-a', entities: [{ name, entityType: 'test', observations: ['synthetic test'] }] });
  for (const result of await Promise.all([create('one'), create('two'), create('three')])) ok(result);
  assert.equal(bridge.sessions.size, 1);
  const graph = JSON.parse(text(ok(await bridge.invoke('memory.read_graph', { namespace: 'project-a' }))));
  assert.equal(graph.entities.length, 3);
  const separate = JSON.parse(text(ok(await bridge.invoke('memory.read_graph', { namespace: 'project-b' }))));
  assert.deepEqual(separate.entities, []);
  assert.equal((await bridge.invoke('memory.read_graph', { namespace: '../escape' })).isError, true);
  assert.equal((await bridge.invoke('memory.read_graph', {})).isError, true);
  await bridge.close();
  const reopened = await createBaseBridge('memory', { dataDir: dir }); t.after(() => reopened.close());
  const persisted = JSON.parse(text(ok(await reopened.invoke('memory.read_graph', { namespace: 'project-a' }))));
  assert.equal(persisted.entities.length, 3);
});

test('read-only memory denies mutations', async (t) => {
  const dir = await dataDir(t);
  const bridge = await createBaseBridge('memory', { dataDir: dir, readOnly: true }); t.after(() => bridge.close());
  await bridge.start(); assert.equal(bridge.tools.length, 3);
  assert.equal((await bridge.invoke('memory.create_entities', { namespace: 'readonly', entities: [] })).isError, true);
  ok(await bridge.invoke('memory.read_graph', { namespace: 'readonly' }));
});

test('thinking sessions keep separate histories', async (t) => {
  const bridge = await createBaseBridge('sequential-thinking'); t.after(() => bridge.close());
  await bridge.start();
  assert.equal(bridge.tools.length, 1);
  const name = 'thinking.' + bridge.tools[0].name;
  const params = { thought: 'Synthetic tool validation step.', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false };
  const first = JSON.parse(text(ok(await bridge.invoke(name, { ...params, session_id: 'session-a' }))));
  const second = JSON.parse(text(ok(await bridge.invoke(name, { ...params, session_id: 'session-a' }))));
  const separate = JSON.parse(text(ok(await bridge.invoke(name, { ...params, session_id: 'session-b' }))));
  assert.equal(first.thoughtHistoryLength, 1); assert.equal(second.thoughtHistoryLength, 2); assert.equal(separate.thoughtHistoryLength, 1);
  assert.equal((await bridge.invoke(name, params)).isError, true);
});

test('memory pool is bounded and idle eviction keeps persisted data', async (t) => {
  const dir = await dataDir(t);
  const bridge = await createBaseBridge('memory', { dataDir: dir }); t.after(() => bridge.close());
  bridge.limit = 1;
  ok(await bridge.invoke('memory.create_entities', { namespace: 'one', entities: [{ name: 'persist', entityType: 'test', observations: [] }] }));
  assert.equal((await bridge.invoke('memory.read_graph', { namespace: 'two' })).isError, true);
  bridge.sessions.get('one').usedAt = Date.now() - bridge.idleMs - 1;
  ok(await bridge.invoke('memory.read_graph', { namespace: 'two' }));
  assert.equal(bridge.sessions.has('one'), false);
  bridge.sessions.get('two').usedAt = Date.now() - bridge.idleMs - 1;
  assert.match(text(ok(await bridge.invoke('memory.read_graph', { namespace: 'one' }))), /persist/);
});

test('fetch URL policy rejects credentials, special ports, private and mapped addresses', () => {
  assert.equal(validateFetchUrl('https://example.com/').hostname, 'example.com');
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'http://example.com:3000']) assert.throws(() => validateFetchUrl(url));
  for (const ip of ['127.0.0.1', '10.1.2.3', '100.125.201.118', '169.254.169.254', '172.20.0.1', '192.168.1.1', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2001:2::40']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('Fake-IP DNS uses verified public answers and still rejects private results', async () => {
  const fake = async () => [{ address: '198.18.0.63', family: 4 }, { address: '2001:2::40', family: 6 }];
  let calls = 0;
  const doh = async () => { calls++; return [{ address: '1.1.1.1', family: 4 }]; };
  assert.equal((await publicTarget('public.example.org', { lookup: fake, doh })).address, '1.1.1.1');
  await assert.rejects(publicTarget('public.example.org', { lookup: fake, doh: async () => [{ address: '127.0.0.1', family: 4 }] }), /public internet/);
  await assert.rejects(publicTarget('internal.local', { lookup: fake, doh }), /public internet/);
  await assert.rejects(publicTarget('private.example.org', { lookup: async () => [{ address: '10.0.0.1', family: 4 }], doh }), /public internet/);
  await assert.rejects(publicTarget('198.18.0.63', { lookup: fake, doh }), /public internet/);
  assert.equal(calls, 1);
});

test('fetch proxy rejects loopback destinations on each HTTP/CONNECT request', async (t) => {
  const proxy = await startFetchProxy(); t.after(() => proxy.close());
  const http = await import('node:http');
  const url = new URL(proxy.url);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'GET', path: 'http://127.0.0.1/' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  const connected = await new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'CONNECT', path: '127.0.0.1:443' });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('error', reject); req.end();
  });
  assert.equal(connected, 403);
});

test('Git reads/writes only allowed repos and rejects external metadata', async (t) => {
  const dir = await dataDir(t);
  const root = path.join(dir, 'allowed'); const outside = path.join(dir, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  for (const repo of [root, outside]) {
    execFileSync('git', ['init', repo], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'MCP Test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  }
  const bridge = await createBaseBridge('git', { roots: [root] }); t.after(() => bridge.close());
  await bridge.start();
  assert.match(text(ok(await bridge.invoke('git.git_status', { repo_path: root }))), /branch/i);
  await fs.writeFile(path.join(root, 'test.txt'), 'synthetic');
  ok(await bridge.invoke('git.git_add', { repo_path: root, files: ['test.txt'] }));
  ok(await bridge.invoke('git.git_commit', { repo_path: root, message: 'Synthetic integration test' }));
  assert.match(text(ok(await bridge.invoke('git.git_log', { repo_path: root, max_count: 1 }))), /Synthetic integration test/);
  assert.equal((await bridge.invoke('git.git_status', { repo_path: outside })).isError, true);
  assert.equal((await bridge.invoke('git.git_add', { repo_path: root, files: ['../outside'] })).isError, true);
  assert.equal((await bridge.invoke('git.git_add', { repo_path: root, files: [':(top)../outside'] })).isError, true);
  await fs.symlink(outside, path.join(root, 'escape'));
  assert.equal((await bridge.invoke('git.git_status', { repo_path: path.join(root, 'escape') })).isError, true);
  const linked = path.join(root, 'linked'); await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, '.git'), `gitdir: ${path.join(outside, '.git')}\n`);
  assert.equal((await bridge.invoke('git.git_status', { repo_path: linked })).isError, true);
});

test('official Time current time and deterministic conversion', async (t) => {
  const bridge = await createBaseBridge('time'); t.after(() => bridge.close()); await bridge.start();
  assert.equal(bridge.tools.length, 2);
  const current = JSON.parse(text(ok(await bridge.invoke('time.get_current_time', { timezone: 'Asia/Shanghai' }))));
  assert.equal(current.timezone, 'Asia/Shanghai'); assert.ok(Number.isFinite(Date.parse(current.datetime)));
  const converted = JSON.parse(text(ok(await bridge.invoke('time.convert_time', { source_timezone: 'UTC', time: '12:00', target_timezone: 'Asia/Shanghai' }))));
  assert.match(converted.target.datetime, /T20:00/);
});

test('Fetch HTTP shutdown exits the CLI and closes its proxy', async (t) => {
  const http = await import('node:http');
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/base-mcp.mjs', import.meta.url)), 'serve', '--service', 'fetch', '--no-report', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', (chunk) => { logs += chunk; }); child.stdout.resume();
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    healthy = await fetch(base + '/health').then((response) => response.ok).catch(() => false);
    if (healthy) break;
    if (child.exitCode !== null) assert.fail(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, logs);
  assert.equal((await fetch(base + '/shutdown', { method: 'POST' })).status, 200);
  let deadline;
  try { assert.equal(await Promise.race([exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('CLI did not exit after shutdown: ' + logs)), 5000); })]), 0); }
  finally { clearTimeout(deadline); }
});

test('installer rejects another service port and permits its own upgrade', async (t) => {
  const http = await import('node:http');
  let service = 'someone-else';
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ service, upstream_version: 'test' })); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(checkServicePort(port, 'time'), /occupied/);
  service = 'time'; await checkServicePort(port, 'time');
});
