import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const config = resolve(root, 'tsconfig.declaration-gate.json');
const output = mkdtempSync(join(tmpdir(), 'jsonlview-declaration-gate-'));
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');

try {
  execFileSync(process.execPath, [
    tsc,
    '--project',
    config,
    '--declarationDir',
    output,
    '--pretty',
    'false',
  ], { cwd: root, stdio: 'inherit' });
  console.log(`TypeScript declaration gate passed (${config}).`);
} finally {
  rmSync(output, { recursive: true, force: true });
}
