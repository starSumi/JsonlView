import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleInventoryDigest, compareBundleInventories } from './bundle-integrity.mjs';
import { inspectNpmTarball } from './npm-tarball-integrity.mjs';
import { inspectVsixArchive } from './vsix-archive-integrity.mjs';

if (isMainModule()) await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [npm, vsix] = await Promise.all([
    inspectNpmTarball(options.npm),
    inspectVsixArchive(options.vsix),
  ]);
  const result = verifyCandidatePairEvidence({ npm, vsix }, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

/** Verify that npm and VSIX were assembled from the same frozen payload. */
export function verifyCandidatePairEvidence({ npm, vsix }, expected = {}) {
  const failures = [];
  const npmPackage = npm?.packageJson ?? {};
  const vsixPackage = vsix?.identity?.package ?? {};
  const npmBaseName = typeof npmPackage.name === 'string' && npmPackage.name.startsWith('@')
    ? npmPackage.name.slice(npmPackage.name.indexOf('/') + 1)
    : npmPackage.name;
  if (npmBaseName !== vsixPackage.name) failures.push('npm package basename differs from VSIX extension name');
  for (const field of ['publisher', 'version']) {
    if (npmPackage[field] !== vsixPackage[field]) failures.push(`${field} differs between npm and VSIX`);
  }
  if (expected.expectedNpmName !== undefined && npmPackage.name !== expected.expectedNpmName) {
    failures.push('npm package name differs from the expected release identity');
  }
  if (expected.expectedPublisher !== undefined && vsixPackage.publisher !== expected.expectedPublisher) {
    failures.push('VSIX publisher differs from the expected release identity');
  }
  if (expected.expectedVersion !== undefined && vsixPackage.version !== expected.expectedVersion) {
    failures.push('candidate version differs from the expected release identity');
  }
  const npmNative = npm?.files?.find((file) => file.path === 'native/jsonl-core/jsonl_core.win32-x64-msvc.node');
  if (typeof npmNative?.sha256 !== 'string' || typeof vsix?.native?.sha256 !== 'string') {
    failures.push('native addon evidence is missing from one candidate');
  } else if (npmNative.sha256.toLowerCase() !== vsix.native.sha256.toLowerCase()) {
    failures.push('native addon differs between npm and VSIX');
  }
  const npmBundle = bundleFromNpmFiles(npm?.files);
  failures.push(...compareBundleInventories(npmBundle, vsix?.bundle));
  return {
    schemaVersion: 1,
    ok: failures.length === 0,
    failures,
    identity: {
      npmName: npmPackage.name ?? null,
      extensionName: vsixPackage.name ?? null,
      publisher: vsixPackage.publisher ?? null,
      version: vsixPackage.version ?? null,
    },
    artifacts: {
      npm: npm?.artifact,
      vsix: vsix?.artifact,
    },
    nativeSha256: npmNative?.sha256 ?? null,
    bundleSha256: npmBundle?.sha256 ?? null,
  };
}

function bundleFromNpmFiles(files) {
  if (!Array.isArray(files)) return undefined;
  const selected = files
    .filter((file) => typeof file?.path === 'string' && file.path.startsWith('dist/'))
    .map((file) => ({ ...file, path: file.path.slice('dist/'.length) }));
  if (selected.length === 0) return undefined;
  const bytes = selected.reduce((sum, file) => sum + file.bytes, 0);
  const hash = new Map(selected.map((file) => [file.path, file]));
  const ordered = ['extension.cjs', 'webview.css', 'webview.js'].map((path) => hash.get(path)).filter(Boolean);
  if (ordered.length !== 3 || selected.length !== 3) return undefined;
  return { files: ordered, bytes, sha256: bundleInventoryDigest(ordered) };
}

export function parseArgs(args) {
  const input = args[0] === '--' ? args.slice(1) : [...args];
  const parsed = { npm: undefined, vsix: undefined, expectedNpmName: undefined, expectedPublisher: undefined, expectedVersion: undefined };
  for (let index = 0; index < input.length; index += 1) {
    const key = input[index];
    const value = input[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--npm') parsed.npm = resolve(value);
    else if (key === '--vsix') parsed.vsix = resolve(value);
    else if (key === '--expected-npm-name') parsed.expectedNpmName = value;
    else if (key === '--expected-publisher') parsed.expectedPublisher = value;
    else if (key === '--expected-version') parsed.expectedVersion = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  if (parsed.npm === undefined || parsed.vsix === undefined) throw new Error('--npm and --vsix are required');
  return parsed;
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
