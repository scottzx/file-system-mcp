#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBaseBridge, BASE_SERVICES, DEFAULT_BASE_PORT, DEFAULT_DATA_DIR, DEFAULT_PYTHON, BASE_SKILL_DIR } from '../src/base-services.mjs';
import { startFetchProxy } from '../src/fetch-proxy.mjs';
import { startServer, DEFAULT_AGENT, localAgentUrl } from '../src/server.mjs';
import { validateRoots } from '../src/bridge.mjs';
import { VERSION, errorResult } from '../src/mcp-bridge.mjs';
import { serviceCommand, checkServicePort } from '../scripts/service.mjs';

const names = { fetch: '网页抓取 MCP', git: 'Git MCP', memory: '项目记忆 MCP', 'sequential-thinking': '分步思考 MCP', time: '时间与时区 MCP' };
const help = `base-mcp ${VERSION}
Usage: base-mcp <serve|install|uninstall|status|manifest|invoke> [options]
  --service NAME   Select fetch|git|memory|sequential-thinking|time (default all)
  --root DIR       Allowed Git root; repeat as needed (required for git/all)
  --port N         Base HTTP port (default ${DEFAULT_BASE_PORT}; all uses 5 consecutive ports)
  --python PATH    Python with official MCP dependencies (default package .local/python)
  --data-dir DIR   Persistent data (default package .local/base-mcp)
  --agent URL      Local dreammate-node gateway (default ${DEFAULT_AGENT})
  --read-only      Expose only read-only Git/Memory methods
  --id NAME        Service id override for one selected service
  --no-report      Run without registering with dreammate-node
  --help           Show help

Memory calls require namespace; thinking calls require session_id.
invoke reads a DreamMate {method,params} JSON request from stdin.
Python setup: node scripts/setup-python.mjs
`;
const running = [];
const bridges = [];
let proxy;
let stopping;
function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await Promise.allSettled(running.map((instance) => instance.stop()));
    await Promise.allSettled(bridges.map((bridge) => bridge.close()));
    await proxy?.close();
  })();
  return stopping;
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    service: { type: 'string' }, root: { type: 'string', multiple: true }, port: { type: 'string' },
    python: { type: 'string' }, 'data-dir': { type: 'string' }, agent: { type: 'string' },
    id: { type: 'string' }, 'read-only': { type: 'boolean' }, 'no-report': { type: 'boolean' },
    help: { type: 'boolean' }, version: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(help); process.exit(0); }
  if (values.version) { process.stdout.write(VERSION + '\n'); process.exit(0); }
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1 || !['serve', 'install', 'uninstall', 'status', 'manifest', 'invoke'].includes(command)) throw new Error('Invalid command; use --help.');
  const selection = values.service ?? 'all';
  const selected = selection === 'all' ? BASE_SERVICES : [selection];
  if (selected.some((service) => !BASE_SERVICES.includes(service))) throw new Error('Unknown service.');
  if (values.id && (selected.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(values.id))) throw new Error('--id requires one selected service and a valid identifier.');
  if (command === 'invoke' && selected.length !== 1) throw new Error('invoke requires --service.');
  const port = Number(values.port ?? DEFAULT_BASE_PORT);
  if (!Number.isInteger(port) || port < 1 || port + selected.length - 1 > 65535) throw new Error('Invalid port range.');
  const agent = localAgentUrl(values.agent ?? DEFAULT_AGENT);
  const dataDir = path.resolve(values['data-dir'] ?? DEFAULT_DATA_DIR);
  const python = path.resolve(values.python ?? DEFAULT_PYTHON);
  const roots = ['status', 'uninstall'].includes(command) || !selected.includes('git') ? [] : await validateRoots(values.root ?? []);
  const readOnly = values['read-only'] ?? false;
  const report = !values['no-report'];
  const log = (message) => process.stderr.write(`[base-mcp] ${message}\n`);
  if (['install', 'uninstall', 'status'].includes(command)) {
    if (command === 'install') {
      for (let index = 0; index < selected.length; index++) await checkServicePort(port + index, values.id ?? selected[index]);
    }
    const results = [];
    for (let index = 0; index < selected.length; index++) {
      const service = selected[index];
      results.push(await serviceCommand(command, {
        id: values.id ?? service, port: port + index, agent, roots: service === 'git' ? roots : [], readOnly, report,
        labelPrefix: 'work.dreammate.base-mcp', entryPath: fileURLToPath(import.meta.url),
        extraArgs: ['--service', service, '--python', python, '--data-dir', dataDir],
      }));
    }
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
    if (selected.includes('fetch')) proxy = await startFetchProxy();
    for (let index = 0; index < selected.length; index++) {
      const service = selected[index];
      const bridge = await createBaseBridge(service, { roots, python, dataDir, readOnly, proxyUrl: proxy?.url, log });
      bridges.push(bridge); await bridge.start();
      if (command === 'serve') {
        const instance = await startServer(bridge, { id: values.id ?? service, port: port + index, agent, report, log, profile: {
          name: names[service], skillName: 'base-mcp', skillDescription: '通过 DreamMate 调用官方网页抓取、Git、记忆、分步思考与时间基础能力。', skillDir: BASE_SKILL_DIR,
        } });
        running.push(instance);
        instance.server.once('close', () => {
          if (selected.length === 1) void stop();
          else if (service === 'fetch') void proxy?.close();
        });
        log(`${service} listening on 127.0.0.1:${port + index}`);
      } else if (command === 'manifest') {
        process.stdout.write(JSON.stringify({ id: values.id ?? service, methods: bridge.methods, metadata: bridge.metadata }, null, 2) + '\n');
      } else {
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) {
          size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Request body too large.'); chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await bridge.invoke(body.method ?? body.capability, body.params ?? {});
        process.stdout.write(JSON.stringify(result) + '\n'); if (result.isError) process.exitCode = 1;
      }
    }
    if (command !== 'serve') await stop();
  }
} catch (error) {
  if (process.argv.includes('invoke')) process.stdout.write(JSON.stringify(errorResult(error)) + '\n');
  process.stderr.write(`[base-mcp] ${error.message}\n`); process.exitCode = 1; await stop();
}
