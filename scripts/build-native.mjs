import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { env } from 'node:process';
import { resolve } from 'node:path';

const remap = [];
for (const name of ['CARGO_HOME', 'RUSTUP_HOME']) {
  const value = env[name]?.trim();
  if (value) remap.push(`--remap-path-prefix=${value}=<${name.toLowerCase()}>`);
}
remap.push(`--remap-path-prefix=${process.cwd()}=<jsonl-view-workspace>`);

const result = spawnSync('pnpm', [
  'exec',
  'napi',
  'build',
  '--cwd',
  'native/jsonl-core',
  '--platform',
  '--release',
  '--output-dir',
  '.',
  '--no-js',
  '--no-dts-header',
], {
  stdio: 'inherit',
  env: {
    ...env,
    RUSTFLAGS: [env.RUSTFLAGS, ...remap].filter(Boolean).join(' '),
  },
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Rust's prebuilt standard library can retain its own toolchain path in panic
// metadata; remap those prefixes in-place without changing the native ABI.
const nativeRoot = resolve(process.cwd(), 'native/jsonl-core');
const rustupHome = env.RUSTUP_HOME?.trim() || execFileSync('rustup', ['show', 'home'], { encoding: 'utf8' }).trim();
const rustcSysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim();
const rustcToolchainRoot = resolve(rustcSysroot, '..', '..');
const prefixes = [
  [env.CARGO_HOME, '<cargo_home>'],
  [rustupHome, '<rustup_home>'],
  [rustcToolchainRoot, '<rustup_toolchain>'],
  [process.cwd(), '<jsonl-view-workspace>'],
].filter(([prefix]) => Boolean(prefix));

const rewritePrefix = (bytes, prefix, replacement) => {
  for (const spelling of new Set([prefix, prefix.replaceAll('\\', '/')])) {
    const needle = Buffer.from(spelling, 'latin1');
    if (needle.length === 0) continue;
    const padded = Buffer.alloc(needle.length, 0x20);
    Buffer.from(replacement, 'latin1').copy(padded);
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + padded.length)) {
      padded.copy(bytes, at);
    }
  }
};

for (const name of await readdir(nativeRoot)) {
  if (!name.endsWith('.node')) continue;
  const path = resolve(nativeRoot, name);
  const bytes = await readFile(path);
  for (const [prefix, replacement] of prefixes) rewritePrefix(bytes, prefix, replacement);
  await writeFile(path, bytes);
}
