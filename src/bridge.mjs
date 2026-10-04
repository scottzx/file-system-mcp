import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpBridge, VERSION, errorResult } from './mcp-bridge.mjs';

const require = createRequire(import.meta.url);
const upstreamPackage = require.resolve('@modelcontextprotocol/server-filesystem/package.json');
const upstreamEntry = path.join(path.dirname(upstreamPackage), 'dist/index.js');
export { VERSION, errorResult };
export const UPSTREAM_VERSION = JSON.parse(await fs.readFile(upstreamPackage, 'utf8')).version;
export const PREFIX = 'filesystem.';

export async function validateRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('Specify at least one --root directory or FILESYSTEM_ALLOWED_DIRS (JSON array).');
  }
  const result = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('Every root must be a non-empty path.');
    const expanded = root === '~' ? os.homedir() : root.startsWith('~/') ? path.join(os.homedir(), root.slice(2)) : root;
    const absolute = path.resolve(expanded);
    if (!(await fs.stat(absolute)).isDirectory()) throw new Error(`Not a directory: ${absolute}`);
    if (!result.includes(absolute)) result.push(absolute);
  }
  return result;
}

// The official server owns all file operations and path validation. We do not
// advertise MCP Roots, so callers cannot replace the deployment's allowed roots.
export class FilesystemBridge extends McpBridge {
  constructor({ roots, readOnly = false, timeoutMs = 12_000, log = () => {} }) {
    super({
      prefix: PREFIX, upstream: '@modelcontextprotocol/server-filesystem', upstreamVersion: UPSTREAM_VERSION,
      readOnly, timeoutMs, log,
      prepare: async () => { this.roots = await validateRoots(this.roots); },
      transport: () => ({ command: process.execPath, args: [upstreamEntry, ...this.roots], stderr: 'pipe' }),
    });
    this.roots = roots;
  }
}
