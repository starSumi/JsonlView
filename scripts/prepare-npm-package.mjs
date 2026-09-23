import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { artifactDirectory } from './artifact-directory.mjs';
import { compareBundleInventories, copyFrozenBundle, inventoryFrozenBundle } from './bundle-integrity.mjs';
import { compareNpmFileInventories, inspectNpmTarball } from './npm-tarball-integrity.mjs';
import { assertOutsideTree, assertPathsDoNotOverlap } from './path-boundary.mjs';
import { validateProjectLicense } from './license-policy.mjs';
import { locateNativeBinary } from './verify-native-provenance.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');

if (isMainModule()) await main();

async function main() {
const sourcePackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sourceLicense = await readFile(resolve(root, 'LICENSE.txt'), 'utf8');
const options = parseArgs(process.argv.slice(2));
const publicCandidate = options.public === true;
const output = resolve(options.output ?? artifactDirectory('npm-package'));
const manifestPath = resolve(options.manifest ?? `${output}.provenance.json`);
const tarballPath = resolve(options.tarball ?? `${output}.tgz`);
const artifactRoot = resolve(artifactDirectory());

if (publicCandidate && options.allowDirty) {
  throw new Error('--public cannot be combined with --allow-dirty; public candidates require a clean reviewed checkout.');
}
if (publicCandidate && options.allowProprietary) {
  throw new Error('--public cannot be combined with --allow-proprietary; proprietary staging is never a public release.');
}

await assertOutsideSourceTree(output, 'npm staging output');
await assertOutsideSourceTree(manifestPath, 'npm staging manifest');
await assertOutsideSourceTree(tarballPath, 'npm tarball');
await assertOutsideSourceTree(artifactRoot, 'artifact root');
assertManifestOutsideOutput(output, manifestPath);
assertPathsDoNotOverlap(output, tarballPath, `npm tarball must not overlap the staging output: ${tarballPath}`);
assertPathsDoNotOverlap(manifestPath, tarballPath, `npm tarball must not overlap the staging manifest: ${tarballPath}`);
await assertOutputDirectoryReady(output, options.replace);
await assertManifestPathReady(manifestPath, options.replace);
await assertArtifactPathReady(tarballPath, options.replace);
if (sourcePackage.private === true && !publicCandidate && !options.allowProprietary) {
  throw new Error('The source package is private; pass --allow-proprietary only for a local, non-public candidate.');
}
if (publicCandidate && sourcePackage.private === true) {
  throw new Error('A public npm candidate requires package.json private=false; use a reviewed public release checkout.');
}
const licenseValidation = validateProjectLicense(sourcePackage.license, sourceLicense);
if (publicCandidate && !licenseValidation.ok) {
  throw new Error(`A public npm candidate requires a reviewed project license: ${licenseValidation.issues.join('; ')}`);
}
if (publicCandidate && sourcePackage.publisher === 'momo') {
  throw new Error('A public VS Code/npm candidate cannot inherit the development publisher "momo".');
}
if (publicCandidate && options.native === undefined) {
  throw new Error('A public npm candidate requires --native so npm and VSIX can share one frozen native build.');
}
if (publicCandidate && options.dist === undefined) {
  throw new Error('A public npm candidate requires --dist so npm and VSIX can share one frozen production bundle.');
}
if (publicCandidate && options.tarball === undefined) {
  throw new Error('A public npm candidate requires --tarball <external .tgz> so promotion can publish the exact reviewed archive.');
}
if (!options.name || !options.version) {
  throw new Error('Both --name and --version are required for a publish candidate.');
}
if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(options.name)) {
  throw new Error(`Invalid npm package name: ${options.name}`);
}
if (!/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(options.version)) {
  throw new Error(`Invalid semver version: ${options.version}`);
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`The npm candidate currently ships the win32-x64 native addon; run this staging command on win32-x64 (observed ${process.platform}-${process.arch}).`);
}

const gitState = await readGitState();
if (gitState.dirty && (publicCandidate || !options.allowDirty)) {
  throw new Error('The checkout is dirty; use a clean candidate or pass --allow-dirty for a local, non-release staging run.');
}

let nativeOutput;
let nativeTarget;
let nativeProvenancePath;
let operationError;
try {
  if (options.dist === undefined) await run('pnpm', ['build']);
  const frozenDist = resolve(options.dist ?? resolve(root, 'dist'));
  if (publicCandidate) await assertOutsideSourceTree(frozenDist, 'frozen dist');
  const frozenBundle = await inventoryFrozenBundle(frozenDist);
  await mkdir(artifactRoot, { recursive: true });
  if (options.native === undefined) {
    nativeOutput = await mkdtemp(join(artifactRoot, 'npm-native-build-'));
    nativeTarget = await mkdtemp(join(artifactRoot, 'npm-native-target-'));
    await run('pnpm', ['native:build'], {
      env: {
        JSONLVIEW_NATIVE_OUTPUT_DIR: nativeOutput,
        JSONLVIEW_NATIVE_TARGET_DIR: nativeTarget,
      },
    });
  }
  const candidateBinary = await locateNativeBinary(options.native ?? nativeOutput);
  const candidateDeclaration = resolve(dirname(candidateBinary), 'index.d.ts');
  nativeProvenancePath = resolve(artifactRoot, `.npm-native-provenance-${process.pid}-${Date.now()}.json`);
  await assertCandidateFile(candidateBinary, 'native candidate binary');
  const declaration = await readFile(candidateDeclaration, 'utf8');
  assertNativeDeclaration(declaration);
  const afterBuildState = await readGitState();
  if (afterBuildState.statusSha256 !== gitState.statusSha256 || afterBuildState.diffSha256 !== gitState.diffSha256) {
    throw new Error('native/package staging changed the product checkout; inspect git status and diff before continuing.');
  }
  // Only load the freshly rebuilt candidate. Loading the committed .node would
  // execute an untrusted artifact from a dirty/PR checkout before provenance
  // has been established.
  await run(process.execPath, ['scripts/verify-native-addon.mjs', '--addon', candidateBinary]);
  await run(process.execPath, [
    'scripts/verify-native-provenance.mjs',
    '--candidate',
    candidateBinary,
    '--skip-committed',
    '--out',
    nativeProvenancePath,
  ]);
  const nativeProvenance = JSON.parse(await readFile(nativeProvenancePath, 'utf8'));
  if (nativeProvenance.ok !== true) {
    throw new Error('native candidate provenance did not pass.');
  }

  await prepareManifestPath(manifestPath, options.replace);
  await prepareOutputDirectory(output, options.replace);
  await mkdir(output, { recursive: true });
  const packageJson = {
    name: options.name,
    version: options.version,
    publisher: sourcePackage.publisher,
    description: sourcePackage.description,
    license: sourcePackage.license,
    repository: sourcePackage.repository,
    type: sourcePackage.type,
    main: './dist/extension.cjs',
    private: publicCandidate ? false : true,
    files: [
      'dist',
      'native/jsonl-core',
      'docs/acceleration-roadmap.md',
      'docs/format-and-profile-boundaries.md',
      'docs/decisions',
      'docs/assets',
      'third_party/licenses',
      'README.md',
      'CHANGELOG.md',
      'LICENSE.txt',
      'THIRD-PARTY-NOTICES.txt',
    ],
    ...(publicCandidate ? {
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org',
      },
    } : {}),
  };
  await writeFile(resolve(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await mkdir(resolve(output, 'dist'), { recursive: true });
  const stagedBundle = await copyFrozenBundle(frozenDist, resolve(output, 'dist'));
  const bundleIssues = compareBundleInventories(frozenBundle, stagedBundle);
  if (bundleIssues.length > 0) throw new Error(`staged npm bundle differs from frozen staging: ${bundleIssues.join(', ')}`);
  await mkdir(resolve(output, 'native/jsonl-core'), { recursive: true });
  for (const file of [
    'native/jsonl-core/package.json',
  ]) {
    await cp(resolve(root, file), resolve(output, file));
  }
  await cp(candidateDeclaration, resolve(output, 'native/jsonl-core/index.d.ts'));
  const stagedNativeBinary = resolve(output, 'native/jsonl-core/jsonl_core.win32-x64-msvc.node');
  await cp(candidateBinary, stagedNativeBinary);
  const stagedNativeSha256 = createHash('sha256').update(await readFile(stagedNativeBinary)).digest('hex');
  if (stagedNativeSha256 !== nativeProvenance.binaries?.rebuilt?.sha256) {
    throw new Error('staged npm native addon differs from the verified frozen candidate');
  }
  for (const relativePath of [
    'docs/acceleration-roadmap.md',
    'docs/format-and-profile-boundaries.md',
  ]) {
    await cp(resolve(root, relativePath), resolve(output, relativePath));
  }
  await cp(resolve(root, 'docs/assets'), resolve(output, 'docs/assets'), { recursive: true });
  await cp(resolve(root, 'docs/decisions'), resolve(output, 'docs/decisions'), { recursive: true });
  await cp(resolve(root, 'third_party/licenses'), resolve(output, 'third_party/licenses'), { recursive: true });
  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']) {
    await cp(resolve(root, file), resolve(output, file));
  }

  const files = await inventory(output);
  const npmTarball = await createAndInspectTarball(output, tarballPath, options.replace, packageJson, files);
  const finalGitState = await readGitState();
  assertGitStateStable(gitState, finalGitState);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      // Keep review evidence portable and avoid leaking a developer's checkout
      // path when the manifest is attached to a candidate.
      root: '<workspace>',
      gitSha: gitState.sha,
      gitState: gitState.dirty ? 'dirty' : 'clean',
      statusSha256: gitState.statusSha256,
      diffSha256: gitState.diffSha256,
    },
    package: {
      name: packageJson.name,
      version: packageJson.version,
      // Keep the release identity complete in the evidence manifest. npm's
      // package.json does not need a VS Code publisher field, but the paired
      // VSIX and npm candidates must still be tied to the same owner/repo.
      publisher: sourcePackage.publisher ?? null,
      private: publicCandidate ? false : true,
      license: packageJson.license,
      repository: packageJson.repository ?? null,
    },
    native: {
      provenanceSchemaVersion: nativeProvenance.schemaVersion,
      sourceDigest: nativeProvenance.comparison?.sourceDigest ?? 'unavailable',
      candidateSha256: stagedNativeSha256,
      contractEqual: nativeProvenance.comparison?.contractEqual === true,
      behaviorEqual: nativeProvenance.comparison?.behaviorEqual === true,
      noPrivatePathMarkers: nativeProvenance.comparison?.noPrivatePathMarkers === true,
    },
    bundle: stagedBundle,
    files,
    tarball: {
      path: '<external>/' + basename(tarballPath),
      bytes: npmTarball.artifact.bytes,
      sha256: npmTarball.artifact.sha256,
      inventorySha256: npmTarball.inventorySha256,
      files: npmTarball.files,
      package: npmTarball.packageJson,
    },
    publication: 'staging-only; publishing requires a separate reviewed promotion step',
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, output, manifest: manifestPath, tarball: tarballPath, files: files.length, gitState: manifest.source.gitState }, null, 2));
} catch (error) {
  operationError = error;
  throw error;
} finally {
  const cleanupResults = await Promise.allSettled([
    nativeTarget === undefined ? Promise.resolve() : rm(nativeTarget, { recursive: true, force: true }),
    nativeOutput === undefined ? Promise.resolve() : rm(nativeOutput, { recursive: true, force: true }),
    nativeProvenancePath === undefined ? Promise.resolve() : rm(nativeProvenancePath, { force: true }),
  ]);
  const cleanupErrors = cleanupResults.filter((result) => result.status === 'rejected');
  if (cleanupErrors.length > 0) {
    const message = `failed to clean temporary native staging directories (${cleanupErrors.length})`;
    if (operationError === undefined) throw new Error(message, { cause: cleanupErrors[0].reason });
    console.error(message);
  }
}

}

export function parseArgs(args) {
  args = stripLeadingScriptSeparator(args);
  const parsed = {
    output: undefined,
    manifest: undefined,
    tarball: undefined,
    native: undefined,
    dist: undefined,
    name: process.env.JSONLVIEW_NPM_NAME?.trim(),
    version: process.env.JSONLVIEW_NPM_VERSION?.trim(),
    allowDirty: false,
    allowProprietary: false,
    public: false,
    replace: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--allow-dirty') {
      parsed.allowDirty = true;
      continue;
    }
    if (key === '--allow-proprietary') {
      parsed.allowProprietary = true;
      continue;
    }
    if (key === '--public') {
      parsed.public = true;
      continue;
    }
    if (key === '--replace') {
      parsed.replace = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--output') parsed.output = value;
    else if (key === '--manifest') parsed.manifest = value;
    else if (key === '--tarball') parsed.tarball = value;
    else if (key === '--native') parsed.native = value;
    else if (key === '--dist') parsed.dist = value;
    else if (key === '--name') parsed.name = value;
    else if (key === '--version') parsed.version = value;
    else throw new Error(`Unknown argument: ${key}`);
    index += 1;
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

async function prepareOutputDirectory(directory, replace) {
  await assertOutputDirectoryReady(directory, replace);
  if (!(await pathExists(directory))) return;
  await rm(directory, { recursive: true, force: true });
}

async function prepareManifestPath(file, replace) {
  await assertManifestPathReady(file, replace);
  if (await pathExists(file)) await rm(file, { force: true });
  await mkdir(dirname(file), { recursive: true });
}

async function assertOutputDirectoryReady(directory, replace) {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`npm staging output must not be a symbolic link: ${directory}`);
  if (!details.isDirectory()) throw new Error(`npm staging output must be a directory: ${directory}`);
  if (!replace) throw new Error(`npm staging output already exists; pass --replace only when you intend to replace it: ${directory}`);
}

async function assertManifestPathReady(file, replace) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`npm staging manifest must not be a symbolic link: ${file}`);
  if (!details.isFile()) throw new Error(`npm staging manifest must be a file: ${file}`);
  if (!replace) throw new Error(`npm staging manifest already exists; pass --replace only when you intend to replace it: ${file}`);
}

async function assertArtifactPathReady(file, replace) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`npm tarball must not be a symbolic link: ${file}`);
  if (!details.isFile()) throw new Error(`npm tarball must be a file: ${file}`);
  if (!replace) throw new Error(`npm tarball already exists; pass --replace only when you intend to replace it: ${file}`);
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function createAndInspectTarball(directory, destination, replace, expectedPackage, expectedFiles) {
  const packDirectory = await mkdtemp(join(artifactDirectory(), 'npm-pack-'));
  try {
    const executable = process.platform === 'win32' ? 'npm.exe' : 'npm';
    const result = await execFile(executable, [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
    ], {
      cwd: directory,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    let metadata;
    try {
      metadata = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error('npm pack did not return valid JSON metadata', { cause: error });
    }
    if (!Array.isArray(metadata) || metadata.length !== 1 || typeof metadata[0]?.filename !== 'string') {
      throw new Error('npm pack must produce exactly one JSON artifact record');
    }
    const entries = await readdir(packDirectory, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isFile() || entries[0].isSymbolicLink()) {
      throw new Error('npm pack destination must contain exactly one regular tarball');
    }
    const filename = entries[0].name;
    if (filename !== metadata[0].filename || filename.includes('/') || filename.includes('\\')) {
      throw new Error('npm pack reported a filename different from its sole output artifact');
    }
    const temporaryTarball = resolve(packDirectory, filename);
    const inspected = await inspectNpmTarball(temporaryTarball);
    const inventoryIssues = compareNpmFileInventories(expectedFiles, inspected.files);
    if (inventoryIssues.length > 0) {
      throw new Error(`npm tarball inventory differs from the reviewed staging tree: ${inventoryIssues.join(', ')}`);
    }
    for (const field of ['name', 'version', 'publisher', 'license', 'private']) {
      if (inspected.packageJson[field] !== expectedPackage[field]) {
        throw new Error(`npm tarball package.json ${field} differs from the reviewed package identity`);
      }
    }
    if (JSON.stringify(inspected.packageJson.repository ?? null) !== JSON.stringify(expectedPackage.repository ?? null)) {
      throw new Error('npm tarball package.json repository differs from the reviewed package identity');
    }
    await cp(temporaryTarball, destination, { force: replace, errorOnExist: !replace });
    const copied = await inspectNpmTarball(destination);
    if (copied.artifact.bytes !== inspected.artifact.bytes || copied.artifact.sha256 !== inspected.artifact.sha256) {
      throw new Error('copied npm tarball differs from the pack output');
    }
    const copiedIssues = compareNpmFileInventories(inspected.files, copied.files);
    if (copiedIssues.length > 0) throw new Error(`copied npm tarball inventory differs: ${copiedIssues.join(', ')}`);
    return copied;
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
}

async function assertCandidateFile(file, label) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    throw new Error(`${label} is missing: ${file}`, { cause: error });
  }
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${file}`);
}

function assertNativeDeclaration(value) {
  for (const signature of [
    'export declare function abiVersion(): number;',
    'export declare function capabilities(): number;',
    'export declare function scanLf(input: Uint8Array, start: number, limit: number): Uint32Array;',
  ]) {
    if (!value.includes(signature)) throw new Error(`native candidate declaration is missing: ${signature}`);
  }
}

async function assertOutsideSourceTree(candidate, label) {
  await assertOutsideTree(root, candidate, label);
}

function assertManifestOutsideOutput(directory, manifest) {
  assertPathsDoNotOverlap(
    directory,
    manifest,
    `npm staging manifest must not overlap the staging output: ${manifest}`,
  );
}

async function run(command, args, options = {}) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.exe' : command;
  const result = await execFile(executable, args, {
    cwd: root,
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function readGitState() {
  try {
    const [shaResult, statusResult, diffResult] = await Promise.all([
      execFile('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }),
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, windowsHide: true }),
      execFile('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], {
        cwd: root,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
      }),
    ]);
    const status = statusResult.stdout;
    const diff = Buffer.isBuffer(diffResult.stdout) ? diffResult.stdout : Buffer.from(diffResult.stdout);
    return {
      sha: shaResult.stdout.trim(),
      dirty: status.trim().length > 0,
      statusSha256: createHash('sha256').update(status).digest('hex'),
      diffSha256: createHash('sha256').update(diff).digest('hex'),
    };
  } catch {
    return { sha: 'unavailable', dirty: true, statusSha256: 'unavailable', diffSha256: 'unavailable' };
  }
}

function assertGitStateStable(before, after) {
  for (const field of ['sha', 'dirty', 'statusSha256', 'diffSha256']) {
    if (before[field] !== after[field]) {
      throw new Error(`source changed while packaging (git ${field} drifted); rebuild the candidate from a frozen checkout.`);
    }
  }
}

async function inventory(directory) {
  const entries = [];
  await walk(directory, directory, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(directory, base, entries) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, base, entries);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(absolute);
    entries.push({
      path: relative(base, absolute).replaceAll('\\', '/'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}
