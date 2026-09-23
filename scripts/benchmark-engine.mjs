import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { artifactDirectory } from './artifact-directory.mjs';

const outputDirectory = artifactDirectory('benchmarks');
await mkdir(outputDirectory, { recursive: true });
const runDirectory = await mkdtemp(join(outputDirectory, 'engine-run-'));
const outputFile = resolve(runDirectory, 'dist', 'benchmark-engine-runner.mjs');
const sourceNativeAddon = resolve('native', 'jsonl-core', 'jsonl_core.win32-x64-msvc.node');
const stagedNativeDirectory = resolve(runDirectory, 'native', 'jsonl-core');
await mkdir(dirname(outputFile), { recursive: true });
if (existsSync(sourceNativeAddon)) {
  await mkdir(stagedNativeDirectory, { recursive: true });
  await copyFile(sourceNativeAddon, resolve(stagedNativeDirectory, 'jsonl_core.win32-x64-msvc.node'));
}
try {
  await build({
    entryPoints: [resolve('scripts/benchmark-engine-runner.ts')],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'silent',
    banner: {
      js: "import { fileURLToPath as __jsonlViewFileURLToPath } from 'node:url'; const __filename = __jsonlViewFileURLToPath(import.meta.url);",
    },
  });

  const child = spawn(process.execPath, [outputFile, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (exitCode !== 0) process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
} finally {
  await rm(runDirectory, { recursive: true, force: true });
}
