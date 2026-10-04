#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const venv = path.join(packageDir, '.local/python');
const uv = process.env.BASE_MCP_UV ?? [path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv'].find((candidate) => fs.existsSync(candidate)) ?? 'uv';
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const cache = process.env.BASE_MCP_UV_CACHE ?? path.join(os.tmpdir(), 'base-mcp-uv-cache');
const index = process.env.BASE_MCP_PYPI_INDEX ?? 'https://pypi.org/simple';
try {
  if (!fs.existsSync(python)) execFileSync(uv, ['venv', venv, '--python', '3.12', '--cache-dir', cache], { stdio: 'inherit' });
  execFileSync(uv, ['--native-tls', '--no-config', ...(process.env.BASE_MCP_PYPI_INDEX ? ['--no-cache'] : []), 'pip', 'sync', path.join(packageDir, 'requirements.lock'), '--python', python, '--require-hashes', '--index-url', index, '--cache-dir', cache], { stdio: 'inherit' });
  process.stdout.write(`Python MCP runtime ready: ${python}\n`);
} catch (error) { process.stderr.write('Python setup failed. Install uv and Python 3.12, then rerun this command.\n'); process.exitCode = error.status ?? 1; }
