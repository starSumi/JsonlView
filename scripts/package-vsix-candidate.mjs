import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { locateNativeBinary } from './verify-native-provenance.mjs';
import { copyFrozenBundle, compareBundleInventories, inventoryFrozenBundle } from './bundle-integrity.mjs';
import { compareVsixArchiveIdentity, inspectVsixArchive } from './vsix-archive-integrity.mjs';
import { assertOutsideTree, assertPathsDoNotOverlap, isWithin } from './path-boundary.mjs';
import { resolveExtensionTarget } from './release-targets.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (isMainModule()) await main();

async function main() {
const options = parseArguments(process.argv.slice(2));
const sourceState = await readGitState();
const nativeBinary = await locateNativeBinary(options.native);
const nativeDirectory = dirname(nativeBinary);
const declaration = resolve(nativeDirectory, 'index.d.ts');
const frozenDist = resolve(options.dist);
await assertRegularFile(nativeBinary, 'native candidate');
await assertRegularFile(declaration, 'native candidate declaration');
await assertOutsideCheckout(frozenDist, 'frozen dist');
const frozenBundle = await inventoryFrozenBundle(frozenDist);

const output = resolve(options.out);
await assertOutsideCheckout(output, 'VSIX output');
if (options.manifest !== undefined) {
  assertPathsDoNotOverlap(
    output,
    resolve(options.manifest),
    `VSIX manifest must not overlap the VSIX output: ${options.manifest}`,
  );
}
await assertOutputReady(output, options.replace);
await mkdir(dirname(output), { recursive: true });

let staging;
let removeStaging = false;
try {
  if (options.staging === undefined) {
    staging = await mkdtemp(resolve(process.env.TEMP ?? process.env.TMP ?? '.', 'jsonlview-vsix-'));
    removeStaging = true;
  } else {
    staging = resolve(options.staging);
    await assertOutsideCheckout(staging, 'VSIX staging');
    await mkdir(staging, { recursive: true });
    await assertDirectoryEmpty(staging);
  }

  const packageFiles = [
    'README.md',
    'CHANGELOG.md',
    'LICENSE.txt',
    'THIRD-PARTY-NOTICES.txt',
    '.vscodeignore',
  ];
  for (const file of packageFiles) await cp(resolve(root, file), resolve(staging, file));
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const releaseTarget = options.target === undefined ? undefined : await resolveExtensionTarget(options.target);
  if (releaseTarget !== undefined) {
    if (options.publisher !== undefined && options.publisher !== releaseTarget.publisher) {
      throw new Error(`publisher override differs from release target ${releaseTarget.key}`);
    }
    packageJson.name = releaseTarget.name;
    packageJson.displayName = releaseTarget.displayName;
    packageJson.publisher = releaseTarget.publisher;
  } else if (options.publisher !== undefined) {
    packageJson.publisher = options.publisher;
  }
  if (options.version !== undefined) packageJson.version = options.version;
  // VSCE accepts either a `files` allowlist or .vscodeignore, never both.
  // npm keeps the allowlist in the source manifest; the VSIX staging copy uses
  // the reviewed .vscodeignore so the two artifact policies cannot conflict.
  delete packageJson.files;
  await writeFile(resolve(staging, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  if (typeof packageJson.icon === 'string' && packageJson.icon.trim().length > 0) {
    const iconPath = packageJson.icon.trim();
    if (isAbsolute(iconPath)) throw new Error('VSIX icon path must be relative to the product checkout');
    const sourceIcon = resolve(root, iconPath);
    if (!isWithin(root, sourceIcon) || sourceIcon === root) {
      throw new Error(`VSIX icon path must stay inside the product checkout: ${iconPath}`);
    }
    await assertRegularFile(sourceIcon, 'VSIX icon');
    const stagedIcon = resolve(staging, iconPath);
    await mkdir(dirname(stagedIcon), { recursive: true });
    await cp(sourceIcon, stagedIcon);
  }
  await mkdir(resolve(staging, 'dist'), { recursive: true });
  const stagedBundle = await copyFrozenBundle(frozenDist, resolve(staging, 'dist'));
  await mkdir(resolve(staging, 'native/jsonl-core'), { recursive: true });
  await cp(resolve(root, 'native/jsonl-core/package.json'), resolve(staging, 'native/jsonl-core/package.json'));
  await cp(declaration, resolve(staging, 'native/jsonl-core/index.d.ts'));
  const stagedNativeBinary = resolve(staging, 'native/jsonl-core', 'jsonl_core.win32-x64-msvc.node');
  await cp(nativeBinary, stagedNativeBinary);
  const stagedNativeSha256 = hash(stagedNativeBinary);
  // README images are intentionally shipped as approved product assets; keep
  // internal reports and source-study material out of the VSIX.
  if (await isDirectory(resolve(root, 'docs/assets'))) {
    await cp(resolve(root, 'docs/assets'), resolve(staging, 'docs/assets'), { recursive: true });
  }
  await cp(resolve(root, 'docs/acceleration-roadmap.md'), resolve(staging, 'docs/acceleration-roadmap.md'));
  await cp(resolve(root, 'docs/format-and-profile-boundaries.md'), resolve(staging, 'docs/format-and-profile-boundaries.md'));
  await cp(resolve(root, 'docs/decisions'), resolve(staging, 'docs/decisions'), { recursive: true });
  await cp(resolve(root, 'third_party/licenses'), resolve(staging, 'third_party/licenses'), { recursive: true });

  // Invoke the package's Node entrypoint directly. Calling the Windows .cmd
  // shim through child_process.execFile produces EINVAL on some Node builds
  // and makes shell quoting part of the release boundary.
  const vsce = resolve(root, 'node_modules/@vscode/vsce/vsce');
  await execFile(process.execPath, [vsce,
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--out',
    output,
  ], { cwd: staging, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

  const archive = await inspectVsixArchive(output);
  const embeddedNative = archive.native;
  const embeddedBundle = archive.bundle;
  const archiveIdentityIssues = compareVsixArchiveIdentity(archive.identity, packageJson, 'staged package');
  if (archiveIdentityIssues.length > 0) {
    throw new Error(`finished VSIX identity differs from staging: ${archiveIdentityIssues.join(', ')}`);
  }
  if (embeddedNative.sha256 !== stagedNativeSha256) {
    throw new Error('finished VSIX native addon differs from the frozen staging copy');
  }
  const bundleIssues = compareBundleInventories(frozenBundle, stagedBundle, embeddedBundle);
  if (bundleIssues.length > 0) throw new Error(`finished VSIX bundle differs from frozen staging: ${bundleIssues.join(', ')}`);
  const afterPackageState = await readGitState();
  assertGitStateStable(sourceState, afterPackageState);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      gitSha: sourceState.sha,
      gitState: sourceState.gitState,
      statusSha256: sourceState.statusSha256,
      diffSha256: sourceState.diffSha256,
      root: '<workspace>',
    },
    package: {
      name: packageJson.name ?? null,
      displayName: packageJson.displayName ?? null,
      publisher: packageJson.publisher ?? null,
      version: packageJson.version ?? null,
      private: typeof packageJson.private === 'boolean' ? packageJson.private : null,
      license: packageJson.license ?? null,
      repository: packageJson.repository ?? null,
    },
    archiveIdentity: archive.identity,
    releaseTarget: releaseTarget === undefined ? null : {
      key: releaseTarget.key,
      registry: releaseTarget.registry,
      extensionId: `${releaseTarget.publisher}.${releaseTarget.name}`,
      preservesUpdateChain: releaseTarget.preservesUpdateChain,
    },
    native: {
      candidateSha256: stagedNativeSha256,
      embeddedSha256: embeddedNative.sha256,
      embeddedBytes: embeddedNative.bytes,
      embeddedEntry: embeddedNative.entry,
      candidatePath: '<external>/jsonl_core.win32-x64-msvc.node',
    },
    bundle: embeddedBundle,
    artifact: {
      path: '<external>/' + output.split(/[\\/]/).pop(),
      bytes: archive.artifact.bytes,
      sha256: archive.artifact.sha256,
    },
    publication: 'staging-only; promotion requires the release gate and registry readback',
  };
  if (options.manifest !== undefined) {
    const manifestPath = resolve(options.manifest);
    await assertOutsideCheckout(manifestPath, 'VSIX manifest');
    await assertOutputReady(manifestPath, options.replace);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({ ok: true, output, manifest: options.manifest, ...manifest.artifact }, null, 2));
} finally {
  if (removeStaging && staging !== undefined) await rm(staging, { recursive: true, force: true });
}

}

export function parseArguments(args) {
  args = stripLeadingScriptSeparator(args);
  const parsed = {
    native: undefined,
    dist: undefined,
    out: undefined,
    manifest: undefined,
    staging: undefined,
    target: undefined,
    publisher: undefined,
    version: undefined,
    replace: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--replace') {
      parsed.replace = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--native') parsed.native = value;
    else if (key === '--dist') parsed.dist = value;
    else if (key === '--out') parsed.out = value;
    else if (key === '--manifest') parsed.manifest = value;
    else if (key === '--staging') parsed.staging = value;
    else if (key === '--target') parsed.target = value;
    else if (key === '--publisher') parsed.publisher = value;
    else if (key === '--version') parsed.version = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  if (parsed.native === undefined || parsed.dist === undefined || parsed.out === undefined) throw new Error('--native, --dist, and --out are required');
  if (parsed.target !== undefined && !['open-vsx', 'marketplace'].includes(parsed.target)) {
    throw new Error(`invalid extension release target: ${parsed.target}`);
  }
  if (parsed.publisher !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(parsed.publisher)) {
    throw new Error(`invalid VS Code publisher: ${parsed.publisher}`);
  }
  if (parsed.version !== undefined && !/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(parsed.version)) {
    throw new Error(`invalid extension version: ${parsed.version}`);
  }
  return parsed;
}

/**
 * pnpm can forward its script separator as argv[0] on some invocation forms.
 * Consume exactly one leading separator; a second one remains invalid input
 * and is reported by the parser instead of being silently discarded.
 */
export function stripLeadingScriptSeparator(args) {
  return args[0] === '--' ? args.slice(1) : args;
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function assertRegularFile(path, label) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function isDirectory(path) {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}

async function assertOutsideCheckout(path, label) {
  await assertOutsideTree(root, path, label);
}

async function assertOutputReady(path, replace) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`VSIX output must be a regular file: ${path}`);
    if (!replace) throw new Error(`VSIX output already exists; pass --replace only for an intentional overwrite: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertDirectoryEmpty(path) {
  const entries = await readdir(path);
  if (entries.length > 0) throw new Error(`VSIX staging directory must be empty: ${path}`);
}

function hash(path) {
  // This helper is only called for a bounded native candidate.
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function readGitState() {
  try {
    const [shaResult, statusResult, diffResult] = await Promise.all([
      execFile('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }),
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: root,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }),
      execFile('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], {
        cwd: root,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      }),
    ]);
    const status = typeof statusResult.stdout === 'string'
      ? Buffer.from(statusResult.stdout, 'utf8')
      : Buffer.from(statusResult.stdout);
    const diff = Buffer.isBuffer(diffResult.stdout) ? diffResult.stdout : Buffer.from(diffResult.stdout);
    return {
      sha: shaResult.stdout.trim(),
      gitState: status.toString('utf8').trim().length === 0 ? 'clean' : 'dirty',
      statusSha256: createHash('sha256').update(status).digest('hex'),
      diffSha256: createHash('sha256').update(diff).digest('hex'),
    };
  } catch {
    return {
      sha: 'unavailable',
      gitState: 'unknown',
      statusSha256: 'unavailable',
      diffSha256: 'unavailable',
    };
  }
}

function assertGitStateStable(before, after) {
  for (const field of ['sha', 'gitState', 'statusSha256', 'diffSha256']) {
    if (before[field] !== after[field]) {
      throw new Error(`source changed while packaging (git ${field} drifted); rebuild the candidate from a frozen checkout.`);
    }
  }
}
