import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nativeRoot = resolve(root, 'native', 'jsonl-core');
const outputDir = resolve(root, nonEmpty(process.env.JSONLVIEW_NATIVE_OUTPUT_DIR) ?? nativeRoot);
const targetDir = nonEmpty(process.env.JSONLVIEW_NATIVE_TARGET_DIR);
const cargoHome = resolve(nonEmpty(process.env.CARGO_HOME) ?? resolve(homedir(), '.cargo'));
const rustupHome = resolve(nonEmpty(process.env.RUSTUP_HOME) ?? rustupHomeFromSysroot() ?? resolve(homedir(), '.rustup'));
const declarationPath = resolve(nativeRoot, 'index.d.ts');
const declaration = readFileSync(declarationPath, 'utf8');
assertDeclaration(declaration);

// Cargo accepts encoded flags without shell quoting. Remapping the checkout,
// Cargo registry, and Rust toolchain keeps local usernames and drive paths out
// of the distributable native binary while preserving normal compiler output.
const remaps = [
  [root, '<workspace>'],
  [cargoHome, '<cargo>'],
  [rustupHome, '<rustup>'],
];
const existingEncoded = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f').filter(Boolean) ?? [];
const encodedFlags = [
  ...existingEncoded,
  ...remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`),
];

// `pnpm run` accepts an optional `--` separator. It is not a napi option and
// must not be forwarded to Cargo, where it changes the parser boundary.
const forwardedArgs = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2);
const buildArgs = [
  'exec',
  'napi',
  'build',
  '--cwd',
  nativeRoot,
  '--platform',
  '--release',
  '--output-dir',
  outputDir,
  ...(targetDir === undefined ? [] : ['--target-dir', resolve(root, targetDir)]),
  '--no-js',
  '--no-dts-header',
  ...forwardedArgs,
];

// Volta/Scoop expose a real pnpm.exe on Windows; invoking it directly avoids
// shell concatenation and Node's DEP0190 warning.
const command = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
const child = spawn(command, [
  ...buildArgs,
], {
  cwd: root,
  env: {
    ...process.env,
    CARGO_ENCODED_RUSTFLAGS: encodedFlags.join('\x1f'),
  },
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`native build terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    if ((code ?? 1) !== 0) {
      process.exitCode = code ?? 1;
      return;
    }
    try {
      // napi-rs emits an empty declaration when the Rust crate does not enable
      // its typedef feature. The declaration is an authored JS-facing
      // contract, so restore it after every build and copy it to candidates.
      writeFileSync(declarationPath, declaration, 'utf8');
      const outputDeclaration = resolve(outputDir, 'index.d.ts');
      if (outputDeclaration !== declarationPath) writeFileSync(outputDeclaration, declaration, 'utf8');
      process.exitCode = 0;
    } catch (error) {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    }
  }
});

function assertDeclaration(value) {
  for (const signature of [
    'export declare function abiVersion(): number;',
    'export declare function capabilities(): number;',
    'export declare function scanLf(input: Uint8Array, start: number, limit: number): Uint32Array;',
  ]) {
    if (!value.includes(signature)) throw new Error(`native declaration is missing: ${signature}`);
  }
}

function rustupHomeFromSysroot() {
  try {
    const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true }).trim();
    const normalized = sysroot.replaceAll('\\', '/');
    const marker = normalized.toLowerCase().indexOf('/toolchains/');
    return marker > 0 ? normalized.slice(0, marker) : undefined;
  } catch {
    return undefined;
  }
}

function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
