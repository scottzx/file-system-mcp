import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const directory of ['bin', 'src', 'scripts']) {
  for (const name of await fs.readdir(new URL(`../${directory}/`, import.meta.url))) {
    if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../${directory}/${name}`, import.meta.url))], { stdio: 'inherit' });
  }
}
