import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { artifactDirectory } from './artifact-directory.mjs';
import { resolvePnpmInvocation } from './package-manager-invocation.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const artifactRoot = artifactDirectory('vsix-package');
const output = resolve(process.env.JSONLVIEW_VSIX_OUTPUT ?? join(artifactRoot, 'jsonl-view.vsix'));
const manifest = resolve(process.env.JSONLVIEW_VSIX_MANIFEST ?? `${output}.provenance.json`);
const publisher = process.env.JSONLVIEW_VSIX_PUBLISHER?.trim();
const version = process.env.JSONLVIEW_VSIX_VERSION?.trim();
const target = process.env.JSONLVIEW_VSIX_TARGET?.trim();
let nativeOutput;
let nativeTarget;
let distOutput;

try {
  await mkdir(artifactRoot, { recursive: true });
  nativeOutput = await mkdtemp(join(artifactRoot, 'native-build-'));
  nativeTarget = await mkdtemp(join(artifactRoot, 'cargo-target-'));
  distOutput = await mkdtemp(join(artifactRoot, 'dist-build-'));
  await run('pnpm', ['build'], {
    env: { JSONLVIEW_DIST_OUTPUT: distOutput },
  });
  await run('pnpm', ['native:build'], {
    env: {
      JSONLVIEW_NATIVE_OUTPUT_DIR: nativeOutput,
      JSONLVIEW_NATIVE_TARGET_DIR: nativeTarget,
    },
  });
  const candidate = resolve(nativeOutput, 'jsonl_core.win32-x64-msvc.node');
  await run(process.execPath, ['scripts/verify-native-addon.mjs', '--addon', candidate]);
  await run(process.execPath, [
    'scripts/verify-native-provenance.mjs',
    '--candidate', nativeOutput,
    '--skip-committed',
    '--out', `${nativeOutput}.provenance.json`,
  ]);
  const candidateArgs = [
    'scripts/package-vsix-candidate.mjs',
    '--native', nativeOutput,
    '--dist', distOutput,
    '--out', output,
    '--manifest', manifest,
  ];
  if (publisher) candidateArgs.push('--publisher', publisher);
  if (version) candidateArgs.push('--version', version);
  if (target) candidateArgs.push('--target', target);
  await run(process.execPath, candidateArgs);
} finally {
  await Promise.allSettled([
    nativeOutput === undefined ? Promise.resolve() : rm(nativeOutput, { recursive: true, force: true }),
    nativeTarget === undefined ? Promise.resolve() : rm(nativeTarget, { recursive: true, force: true }),
    distOutput === undefined ? Promise.resolve() : rm(distOutput, { recursive: true, force: true }),
  ]);
}

async function run(command, args, options = {}) {
  const invocation = command === 'pnpm' ? resolvePnpmInvocation() : { command, prefix: [] };
  const result = await execFile(invocation.command, [...invocation.prefix, ...args], {
    cwd: root,
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
