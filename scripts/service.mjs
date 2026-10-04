import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

const entry = fileURLToPath(new URL('../bin/file-system-mcp.mjs', import.meta.url));
const packageDir = fileURLToPath(new URL('../', import.meta.url));
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const unitQuote = (value) => '"' + String(value).replace(/[%\\"\n\r]/g, (c) => ({ '%': '%%', '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r' })[c]) + '"';
function run(command, args, optional = false) {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (!optional) throw new Error(`${command}: ${error.stderr?.toString().trim() || error.message}`); return null; }
}

export function systemdUnit({ id, args, workingDirectory }) {
  if (!path.isAbsolute(workingDirectory) || /[\r\n]/.test(workingDirectory)) throw new Error('systemd working directory must be an absolute, single-line path.');
  // WorkingDirectory is a literal path, unlike ExecStart's quoted arguments.
  return ['[Unit]', `Description=DreamMate MCP (${id})`, 'After=network.target', '',
    '[Service]', 'Type=simple', 'WorkingDirectory=' + workingDirectory.replaceAll('%', '%%'),
    'ExecStart=' + args.map(unitQuote).join(' '), 'Restart=on-failure', 'RestartSec=5', '',
    '[Install]', 'WantedBy=default.target', ''].join('\n');
}

export async function checkServicePort(port, serviceId) {
  const probe = net.createServer();
  const occupied = await new Promise((resolve, reject) => {
    probe.once('error', (error) => error.code === 'EADDRINUSE' ? resolve(true) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
  if (!occupied) return;
  const own = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    .then((response) => response.json()).then((health) => health.service === serviceId && typeof health.upstream_version === 'string').catch(() => false);
  if (!own) throw new Error(`Port ${port} is occupied by another service. Choose a different --port.`);
}

export async function serviceCommand(action, { id, roots, port, agent, readOnly, report, labelPrefix = 'work.dreammate.filesystem', entryPath = entry, extraArgs = [] }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('User service installation supports macOS/Linux. On Windows run serve using your service manager.');
  const label = `${labelPrefix}.${id}`;
  const args = [process.execPath, entryPath, 'serve', '--id', id, '--port', String(port), '--agent', agent, ...extraArgs];
  for (const root of roots ?? []) args.push('--root', root);
  if (readOnly) args.push('--read-only');
  if (!report) args.push('--no-report');
  const logDir = path.join(os.homedir(), '.1agents/logs');
  const filename = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/LaunchAgents', label + '.plist')
    : path.join(os.homedir(), '.config/systemd/user', label + '.service');
  const target = `gui/${process.getuid()}/${label}`;

  if (action === 'status') {
    const output = process.platform === 'darwin'
      ? run('launchctl', ['print', target], true)
      : run('systemctl', ['--user', 'status', label + '.service', '--no-pager'], true);
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      .then(async (response) => ({ http_status: response.status, ...await response.json() })).catch(() => null);
    return { label, filename, loaded: output !== null, health, details: output?.trim() ?? null };
  }
  if (action === 'uninstall') {
    if (process.platform === 'darwin') run('launchctl', ['bootout', target], true);
    else run('systemctl', ['--user', 'disable', '--now', label + '.service'], true);
    await fs.rm(filename, { force: true });
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
    return { label, uninstalled: true, filename };
  }

  // Detect missing systemd user manager before writing any files.
  if (process.platform === 'linux') run('systemctl', ['--user', 'show-environment']);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  let content;
  if (process.platform === 'darwin') {
    content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(packageDir)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(path.join(logDir, label + '.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logDir, label + '.log'))}</string>
</dict></plist>
`;
  } else {
    content = systemdUnit({ id, args, workingDirectory: packageDir });
  }
  await fs.writeFile(filename, content, { mode: 0o600 });
  if (process.platform === 'darwin') {
    run('launchctl', ['bootout', target], true);
    let unloaded = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (run('launchctl', ['print', target], true) === null) { unloaded = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!unloaded) throw new Error(`launchctl did not finish unloading ${label}; retry after it exits.`);
    let installed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (run('launchctl', ['bootstrap', `gui/${process.getuid()}`, filename], true) !== null) { installed = true; break; }
      // Unloading is asynchronous; a rewritten RunAtLoad job may also already
      // be loaded when bootstrap returns EIO. Accept only the desired arguments.
      const loaded = run('launchctl', ['print', target], true);
      if (loaded?.includes(filename) && loaded.includes(entryPath) && new RegExp(`^\\s+${port}$`, 'm').test(loaded)) { installed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!installed) throw new Error(`launchctl could not load ${label}; inspect launchctl print ${target}`);
  } else {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', label + '.service']);
    run('systemctl', ['--user', 'restart', label + '.service']);
  }
  return { label, installed: true, filename, roots, port, read_only: readOnly, agent };
}
