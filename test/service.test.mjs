import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { systemdUnit } from '../scripts/service.mjs';

test('systemd parser accepts units with spaces and percent in their working directory', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp systemd % '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'mcp-unit-check.service');
  await fs.writeFile(filename, systemdUnit({ id: 'unit-check', args: [process.execPath, '--version'], workingDirectory: dir }));
  // Parse with systemd itself: the previous quoted WorkingDirectory is fatal.
  execFileSync('systemd-analyze', ['verify', filename], { encoding: 'utf8', stdio: 'pipe' });
});
