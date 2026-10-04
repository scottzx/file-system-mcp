import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpBridge, NamespacedBridge } from './mcp-bridge.mjs';
import { validateRoots } from './bridge.mjs';
import { validateFetchUrl, publicTarget } from './fetch-proxy.mjs';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
export const BASE_SERVICES = ['fetch', 'git', 'memory', 'sequential-thinking', 'time'];
export const DEFAULT_BASE_PORT = 7790;
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.local/base-mcp', import.meta.url));
export const DEFAULT_PYTHON = fileURLToPath(new URL(process.platform === 'win32' ? '../.local/python/Scripts/python.exe' : '../.local/python/bin/python', import.meta.url));
export const BASE_SKILL_DIR = fileURLToPath(new URL('../skills/base-mcp', import.meta.url));

function nodeServer(packageName) {
  const packageFile = require.resolve(packageName + '/package.json');
  return { command: process.execPath, args: [path.join(path.dirname(packageFile), 'dist/index.js')], stderr: 'pipe' };
}
function within(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export async function gitParams(roots, name, params) {
  if (typeof params.repo_path !== 'string' || !path.isAbsolute(params.repo_path)) throw new Error('repo_path must be an absolute path inside an allowed root.');
  const realRoots = await Promise.all(roots.map((root) => fs.realpath(root)));
  const repo = await fs.realpath(params.repo_path);
  if (!realRoots.some((root) => within(repo, root))) throw new Error('Git repository is outside allowed roots.');
  // gitdir and linked worktrees may reference metadata outside the working tree.
  const gitArgs = ['-C', repo, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'];
  const { stdout } = await exec('git', gitArgs, { timeout: 2_000, maxBuffer: 64 * 1024 });
  for (const candidate of stdout.trim().split('\n')) {
    const real = await fs.realpath(candidate);
    if (!realRoots.some((root) => within(real, root))) throw new Error('Git worktree or metadata is outside allowed roots.');
  }
  if (name === 'git_add') {
    if (!Array.isArray(params.files)) throw new Error('files must be an array.');
    for (const file of params.files) {
      if (typeof file !== 'string' || file.includes('\0') || file.startsWith(':')) throw new Error('Unsupported Git pathspec. Use literal paths.');
      const absolute = path.resolve(repo, file);
      if (!within(absolute, repo)) throw new Error('Git file path is outside the repository.');
      const real = await fs.realpath(absolute).catch(async (error) => {
        if (error.code !== 'ENOENT') throw error;
        return path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
      });
      if (!within(real, repo)) throw new Error('Git file symlink is outside the repository.');
    }
  }
  return { ...params, repo_path: repo };
}

export async function createBaseBridge(service, { roots, dataDir = DEFAULT_DATA_DIR, python = DEFAULT_PYTHON, proxyUrl, log = () => {}, readOnly = false } = {}) {
  const common = { prefix: service.replace('-', '_') + '.', log, readOnly };
  if (service === 'memory') {
    const memoryDir = path.join(path.resolve(dataDir), 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    return new NamespacedBridge({ prefix: 'memory.', key: 'namespace', metadata: { namespace_parameter: 'namespace', data_directory: memoryDir }, factory: (namespace) =>
      new McpBridge({ ...common, serialize: true, upstream: '@modelcontextprotocol/server-memory', upstreamVersion: '2026.8.31',
        transport: { ...nodeServer('@modelcontextprotocol/server-memory'), env: { MEMORY_FILE_PATH: path.join(memoryDir, namespace + '.jsonl') } } }) });
  }
  if (service === 'sequential-thinking') {
    return new NamespacedBridge({ prefix: 'thinking.', key: 'session_id', metadata: { session_parameter: 'session_id', idle_timeout_seconds: 300 }, factory: () =>
      new McpBridge({ ...common, prefix: 'thinking.', serialize: true, upstream: '@modelcontextprotocol/server-sequential-thinking', upstreamVersion: '2026.8.31',
        transport: { ...nodeServer('@modelcontextprotocol/server-sequential-thinking'), env: { DISABLE_THOUGHT_LOGGING: 'true' } } }) });
  }
  await fs.access(python);
  const module = { fetch: 'mcp_server_fetch', git: 'mcp_server_git', time: 'mcp_server_time' }[service];
  if (!module) throw new Error(`Unknown base MCP service: ${service}`);
  const transport = { command: path.resolve(python), args: ['-m', module], stderr: 'pipe', env: { PYTHONIOENCODING: 'utf-8', PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? ''), GIT_PYTHON_GIT_EXECUTABLE: process.platform === 'win32' ? 'git' : '/usr/bin/git' } };
  const options = { ...common, transport, upstream: `mcp-server-${service}`, upstreamVersion: '2026.8.18' };
  if (service === 'time') transport.args.push('--local-timezone', 'Asia/Shanghai');
  if (service === 'fetch') {
    if (!proxyUrl) throw new Error('Fetch requires the public-address proxy.');
    transport.args.push('--proxy-url', proxyUrl);
    options.metadata = { network_scope: 'public_internet_only', ports: [80, 443] };
    options.prepareParams = async (_name, params) => {
      const url = validateFetchUrl(params.url);
      // Resolve before the upstream's short robots.txt timeout begins. The proxy
      // still validates every destination, including redirected hosts.
      await publicTarget(url.hostname);
      return params;
    };
    options.annotations = { fetch: { readOnlyHint: true, openWorldHint: true } };
  }
  if (service === 'git') {
    roots = await validateRoots(roots);
    options.metadata = { allowed_directories: roots };
    options.serialize = true;
    options.prepareParams = (name, params) => gitParams(roots, name, params);
    const readonlyTools = ['git_status', 'git_diff_unstaged', 'git_diff_staged', 'git_diff', 'git_log', 'git_show', 'git_branch'];
    options.annotations = Object.fromEntries(readonlyTools.map((name) => [name, { readOnlyHint: true, openWorldHint: false }]));
  }
  return new McpBridge(options);
}
