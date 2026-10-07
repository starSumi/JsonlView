import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'jsonlview-mutation-benchmark-'));
const output = resolve(temporaryDirectory, 'runner.mjs');
try {
  await build({
    entryPoints: [resolve('scripts/benchmark-staged-mutation-runner.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
  });
  const child = spawn(process.execPath, [output, ...process.argv.slice(2)], { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
