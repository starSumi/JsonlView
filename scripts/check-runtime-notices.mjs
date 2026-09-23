import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const noticesPath = resolve(root, 'THIRD-PARTY-NOTICES.txt');
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';

const [{ stdout }, notices] = await Promise.all([
  execFile(pnpm, ['list', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  }),
  readFile(noticesPath, 'utf8'),
]);

const roots = JSON.parse(stdout);
const packages = new Map();
for (const project of roots) collect(project.dependencies, packages);

const missing = [...packages]
  .filter(([name, version]) => !notices.includes(`${name} ${version}`))
  .map(([name, version]) => ({ name, version }));
if (missing.length > 0) {
  console.error(JSON.stringify({ ok: false, missing, notices: '<workspace>/THIRD-PARTY-NOTICES.txt' }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true,
    packages: [...packages].map(([name, version]) => ({ name, version })),
    notices: '<workspace>/THIRD-PARTY-NOTICES.txt',
  }, null, 2));
}

function collect(dependencies, output) {
  if (dependencies === undefined) return;
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency?.version === 'string') {
      const existing = output.get(name);
      if (existing !== undefined && existing !== dependency.version) {
        throw new Error(`multiple production versions require explicit notice handling: ${name} ${existing}, ${dependency.version}`);
      }
      output.set(name, dependency.version);
    }
    collect(dependency?.dependencies, output);
  }
}
