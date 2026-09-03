import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { artifactDirectory } from './artifact-directory.mjs';

const outputDirectory = artifactDirectory('benchmarks');
const outputFile = resolve(outputDirectory, 'benchmark-engine-runner.mjs');
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve('scripts/benchmark-engine-runner.ts')],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'silent',
});

const child = spawn(process.execPath, [outputFile, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
child.once('error', (error) => {
  throw error;
});
const exitCode = await new Promise((resolveExit) => child.once('exit', resolveExit));
if (exitCode !== 0) process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
