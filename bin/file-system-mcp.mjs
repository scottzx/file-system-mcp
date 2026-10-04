#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FilesystemBridge, VERSION, errorResult, validateRoots } from '../src/bridge.mjs';
import { startServer, DEFAULT_PORT, DEFAULT_AGENT, localAgentUrl } from '../src/server.mjs';
import { serviceCommand } from '../scripts/service.mjs';

const help = `file-system-mcp ${VERSION}

Usage: file-system-mcp <serve|mcp|invoke|manifest|install|uninstall|status> [options]

  --root DIR      Allowed directory; repeat for multiple roots (required to serve)
  --read-only     Expose only upstream tools annotated as read-only
  --port N        Loopback HTTP port (default ${DEFAULT_PORT})
  --agent URL     Local DreamMate gateway (default ${DEFAULT_AGENT})
  --id NAME       DreamMate service id (default filesystem)
  --no-report     Run HTTP without registering with DreamMate
  --help          Show this help
  --version       Show version

invoke reads {"method":"filesystem.read_text_file","params":{"path":"..."}}
from stdin, writes the complete MCP result as JSON, then exits.
FILESYSTEM_ALLOWED_DIRS can supply roots as a JSON array of absolute paths.
install sets up a user service on macOS/Linux; it does not publish an npm package.
`;

let bridge;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', multiple: true }, 'read-only': { type: 'boolean' },
      port: { type: 'string' }, agent: { type: 'string' }, id: { type: 'string' },
      'no-report': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'serve';
  if (values.help) { process.stdout.write(help); process.exit(0); }
  if (values.version) { process.stdout.write(VERSION + '\n'); process.exit(0); }
  if (positionals.length > 1) throw new Error('Use --root for each allowed directory.');
  if (!['serve', 'mcp', 'invoke', 'manifest', 'install', 'uninstall', 'status'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const id = values.id ?? 'filesystem';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error('Invalid service id.');
  const port = Number(values.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535.');
  const agent = localAgentUrl(values.agent ?? process.env.DREAMMATE_AGENT_URL ?? DEFAULT_AGENT);
  const options = { id, port, agent, readOnly: values['read-only'] ?? false, report: !values['no-report'] };
  if (command === 'uninstall' || command === 'status') {
    process.stdout.write(JSON.stringify(await serviceCommand(command, options), null, 2) + '\n');
  } else {
    const roots = await validateRoots(values.root ?? JSON.parse(process.env.FILESYSTEM_ALLOWED_DIRS ?? '[]'));
    if (command === 'install') {
      process.stdout.write(JSON.stringify(await serviceCommand(command, { ...options, roots }), null, 2) + '\n');
    } else {
      const log = (message) => process.stderr.write(`[file-system-mcp] ${message}\n`);
      bridge = new FilesystemBridge({ ...options, roots, log });
      await bridge.start();
      if (command === 'serve') {
        const running = await startServer(bridge, { ...options, log });
        log(`listening on http://127.0.0.1:${running.port}; roots=${JSON.stringify(roots)}; readOnly=${options.readOnly}`);
        const stop = () => { void running.stop().catch((error) => { log(error.message); process.exitCode = 1; }); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } else if (command === 'mcp') {
        const server = new Server({ name: '@1agents/file-system-mcp', version: VERSION }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.tools }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => bridge.invoke(request.params.name, request.params.arguments));
        const stop = async () => { await server.close(); await bridge.close(); };
        server.onclose = () => { void bridge.close(); };
        process.once('SIGINT', () => { void stop(); });
        process.once('SIGTERM', () => { void stop(); });
        await server.connect(new StdioServerTransport());
      } else if (command === 'manifest') {
        process.stdout.write(JSON.stringify({ id, methods: bridge.methods, metadata: { allowed_directories: roots, read_only: options.readOnly } }, null, 2) + '\n');
        await bridge.close();
      } else {
        const chunks = [];
        let size = 0;
        for await (const chunk of process.stdin) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error('Request body too large.');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await bridge.invoke(body.method ?? body.capability, body.params ?? {});
        process.stdout.write(JSON.stringify(result) + '\n');
        if (result.isError) process.exitCode = 1;
        await bridge.close();
      }
    }
  }
} catch (error) {
  if (process.argv.includes('invoke')) process.stdout.write(JSON.stringify(errorResult(error)) + '\n');
  process.stderr.write(`[file-system-mcp] ${error.message}\n`);
  process.exitCode = 1;
  await bridge?.close().catch(() => {});
}
