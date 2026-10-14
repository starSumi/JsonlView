import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

export const EXECUTION_IDENTITY_SCHEMA = 'jsonlview.execution-identity.v1';
export const EXECUTION_IDENTITY_MANIFEST = 'execution-identity.json';
export const EXECUTION_BUNDLE_INVENTORY = 'execution-bundle-inventory.json';
const RUNTIME_BINDING = '__JSONLVIEW_EXECUTION_IDENTITY_V1__';
const INVENTORIED_FILES = ['execution-identity.json', 'extension.cjs', 'webview.css', 'webview.js'];
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const BUILD_INPUT_FILES = ['esbuild.mjs', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'scripts/execution-identity.mjs'];
const BUILD_INPUT_DIRECTORIES = ['src'];
const MAX_BUILD_INPUT_FILES = 4096;
const MAX_BUILD_INPUT_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function collectRegularFiles(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`execution identity input must not be a symbolic link: ${relative(root, absolutePath)}`);
    if (entry.isDirectory()) {
      await collectRegularFiles(root, absolutePath, files);
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
    if (files.length > MAX_BUILD_INPUT_FILES) throw new Error('execution identity input file limit exceeded');
  }
}

export async function collectExecutionIdentityInputs(rootDirectory) {
  const root = resolve(rootDirectory);
  const files = BUILD_INPUT_FILES.map((entry) => resolve(root, entry));
  for (const directory of BUILD_INPUT_DIRECTORIES) {
    await collectRegularFiles(root, resolve(root, directory), files);
  }
  files.sort((left, right) => left.localeCompare(right, 'en'));
  return files;
}

async function digestBuildInputs(root, files) {
  const aggregate = createHash('sha256');
  let totalBytes = 0;
  for (const absolutePath of files) {
    const detailsBefore = await lstat(absolutePath);
    if (!detailsBefore.isFile() || detailsBefore.isSymbolicLink()) {
      throw new Error(`execution identity input must be a regular file: ${relative(root, absolutePath)}`);
    }
    if (totalBytes + detailsBefore.size > MAX_BUILD_INPUT_BYTES) throw new Error('execution identity input byte limit exceeded');
    const bytes = await readFile(absolutePath);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUILD_INPUT_BYTES) throw new Error('execution identity input byte limit exceeded');
    const detailsAfter = await lstat(absolutePath);
    if (detailsBefore.size !== detailsAfter.size || detailsBefore.mtimeMs !== detailsAfter.mtimeMs) {
      throw new Error(`execution identity input changed while hashing: ${relative(root, absolutePath)}`);
    }
    const normalizedPath = relative(root, absolutePath).split(sep).join('/');
    aggregate.update(normalizedPath, 'utf8');
    aggregate.update('\0', 'utf8');
    aggregate.update(sha256(bytes), 'ascii');
    aggregate.update('\n', 'utf8');
  }
  return { sha256: aggregate.digest('hex'), count: files.length };
}

async function readGitIdentity(root) {
  const options = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 };
  const [{ stdout: revisionOutput }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], options),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', '.'], options),
  ]);
  const sourceRevision = revisionOutput.trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error('git returned an invalid source revision');
  return { sourceRevision, sourceState: statusOutput.trim().length === 0 ? 'clean' : 'modified' };
}

export function finalizeExecutionIdentity(payload) {
  const manifestSha256 = sha256(canonicalJson(payload));
  return Object.freeze({ ...payload, manifestSha256 });
}

function assertExecutionIdentity(identity) {
  const keys = ['schemaVersion', 'extensionId', 'extensionVersion', 'buildMode', 'sourceRevision',
    'sourceState', 'buildInputsSha256', 'buildInputCount', 'digestAlgorithm', 'canonicalization', 'manifestSha256'];
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
    || Object.keys(identity).length !== keys.length || !keys.every((key) => Object.hasOwn(identity, key))
    || identity.schemaVersion !== EXECUTION_IDENTITY_SCHEMA
    || typeof identity.extensionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/.test(identity.extensionId)
    || typeof identity.extensionVersion !== 'string' || identity.extensionVersion.length > 64
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(identity.extensionVersion)
    || !['development', 'production', 'test'].includes(identity.buildMode)
    || typeof identity.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(identity.sourceRevision)
    || !['clean', 'modified'].includes(identity.sourceState)
    || typeof identity.buildInputsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(identity.buildInputsSha256)
    || !Number.isSafeInteger(identity.buildInputCount) || identity.buildInputCount < 1 || identity.buildInputCount > MAX_BUILD_INPUT_FILES
    || identity.digestAlgorithm !== 'sha256' || identity.canonicalization !== 'jsonlview.sorted-json.v1') {
    throw new Error('execution identity manifest shape is invalid');
  }
  const { manifestSha256, ...payload } = identity;
  if (!/^[0-9a-f]{64}$/.test(manifestSha256 ?? '') || sha256(canonicalJson(payload)) !== manifestSha256) {
    throw new Error('execution identity manifest digest is invalid');
  }
}

function assertKnownRuntimeIdentity(runtime) {
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)
    || Object.keys(runtime).length !== 3
    || typeof runtime.extensionId !== 'string' || runtime.extensionId === 'unknown'
    || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/.test(runtime.extensionId)
    || typeof runtime.extensionVersion !== 'string' || runtime.extensionVersion.length > 64
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(runtime.extensionVersion)
    || !['production', 'development', 'test'].includes(runtime.extensionMode)) {
    throw new Error('runtime execution identity is missing or unknown');
  }
}

/** Read-only harness gate: compare receipts with an explicitly selected artifact and host. */
export function verifyExecutionReceipt(receipt, expectedIdentity, expectedRuntime) {
  assertExecutionIdentity(expectedIdentity);
  assertKnownRuntimeIdentity(expectedRuntime);
  assertExecutionIdentity(receipt?.executionIdentity);
  assertKnownRuntimeIdentity(receipt?.runtimeIdentity);
  if (canonicalJson(receipt.executionIdentity) !== canonicalJson(expectedIdentity)
    || canonicalJson(receipt.runtimeIdentity) !== canonicalJson(expectedRuntime)) {
    throw new Error('execution receipt does not match the selected artifact and runtime');
  }
  return Object.freeze({ executionIdentity: Object.freeze({ ...expectedIdentity }), runtimeIdentity: Object.freeze({ ...expectedRuntime }) });
}

export async function createExecutionIdentity({ rootDirectory, buildMode }) {
  if (!['development', 'production', 'test'].includes(buildMode)) throw new Error('unsupported execution identity build mode');
  const root = resolve(rootDirectory);
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (typeof packageJson.publisher !== 'string' || typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
    throw new Error('package.json is missing execution identity fields');
  }
  const files = await collectExecutionIdentityInputs(root);
  const [gitIdentity, buildInputs] = await Promise.all([readGitIdentity(root), digestBuildInputs(root, files)]);
  return finalizeExecutionIdentity({
    schemaVersion: EXECUTION_IDENTITY_SCHEMA,
    extensionId: `${packageJson.publisher}.${packageJson.name}`,
    extensionVersion: packageJson.version,
    buildMode,
    sourceRevision: gitIdentity.sourceRevision,
    sourceState: gitIdentity.sourceState,
    buildInputsSha256: buildInputs.sha256,
    buildInputCount: buildInputs.count,
    digestAlgorithm: 'sha256',
    canonicalization: 'jsonlview.sorted-json.v1',
  });
}

export async function writeExecutionIdentityManifest(outputDirectory, identity) {
  await mkdir(resolve(outputDirectory), { recursive: true });
  await writeFile(resolve(outputDirectory, EXECUTION_IDENTITY_MANIFEST), `${JSON.stringify(identity, null, 2)}\n`, 'utf8');
}

export function renderExecutionIdentityBinding(identity) {
  assertExecutionIdentity(identity);
  return `"use strict";\nconst ${RUNTIME_BINDING}=Object.freeze(${canonicalJson(identity)});`;
}

/** The one static binding is also the value actually imported by runtime code. */
export function createExecutionIdentityPlugin({ identity, watchFiles = [] }) {
  const binding = renderExecutionIdentityBinding(identity);
  return {
    name: `jsonlview-execution-identity-${identity.buildMode}`,
    setup(buildApi) {
      buildApi.initialOptions.banner = { ...buildApi.initialOptions.banner,
        js: binding + '\n' + (buildApi.initialOptions.banner?.js ?? '') };
      buildApi.onResolve({ filter: /^jsonlview:execution-identity$/ }, () => ({
        path: EXECUTION_IDENTITY_SCHEMA,
        namespace: 'jsonlview-execution-identity',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'jsonlview-execution-identity' }, () => {
        return { contents: `export default ${RUNTIME_BINDING};`, loader: 'js', watchFiles };
      });
    },
  };
}

/** Re-derive from the explicitly selected checkout, never from target package metadata. */
export async function assertExecutionIdentityMatchesSource(rootDirectory, identity, { requireCleanProduction = false } = {}) {
  assertExecutionIdentity(identity);
  if (requireCleanProduction && (identity.buildMode !== 'production' || identity.sourceState !== 'clean')) {
    throw new Error('release execution identity requires a production build from clean source');
  }
  const current = await createExecutionIdentity({ rootDirectory, buildMode: identity.buildMode });
  if (canonicalJson(current) !== canonicalJson(identity)) {
    throw new Error('execution identity differs from selected source; source changed or frozen dist is stale');
  }
  return current;
}

/**
 * Static consistency check, not a proof of arbitrary JavaScript semantics.
 * The controlled generator connects its runtime import to this binding; a
 * reference here only rejects an obviously unused marker. Unsigned metadata
 * cannot attest artifacts rewritten together with a recomputed inventory.
 */
export function extractRuntimeExecutionIdentity(contents, bundle = 'bundle') {
  if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error(`${bundle} exceeds the execution identity byte boundary`);
  let source;
  try { source = parse(contents, { sourceType: 'unambiguous', errorRecovery: false }); }
  catch { throw new Error(`${bundle} has invalid JavaScript`); }
  const first = source.program.body[0];
  const declaration = first?.type === 'VariableDeclaration' && first.kind === 'const'
    && first.declarations.length === 1 ? first.declarations[0] : undefined;
  if (declaration === undefined || declaration.id.type !== 'Identifier' || declaration.id.name !== RUNTIME_BINDING) {
    throw new Error(`${bundle} is missing its canonical runtime identity binding`);
  }
  if (source.program.directives.length !== 1 || source.program.directives[0].value.value !== 'use strict') {
    throw new Error(`${bundle} must retain its single controlled strict directive`);
  }
  const initializer = declaration.init;
  if (initializer?.type !== 'CallExpression' || initializer.arguments.length !== 1
    || initializer.callee.type !== 'MemberExpression' || initializer.callee.computed
    || initializer.callee.object.type !== 'Identifier' || initializer.callee.object.name !== 'Object'
    || initializer.callee.property.type !== 'Identifier' || initializer.callee.property.name !== 'freeze') throw new Error(`${bundle} has an invalid runtime identity binding`);
  const argument = initializer.arguments[0];
  if (argument.type !== 'ObjectExpression') throw new Error(`${bundle} runtime identity is not a literal`);
  const literal = contents.slice(argument.start, argument.end);
  let identity;
  try { identity = JSON.parse(literal); } catch { throw new Error(`${bundle} runtime identity is not JSON`); }
  assertExecutionIdentity(identity);
  if (literal !== canonicalJson(identity)) throw new Error(`${bundle} runtime identity is not canonical`);
  const bindings = new Set();
  const addPatternBindings = (pattern) => {
    const pending = [pattern];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || node === undefined) continue;
      if (node.type === 'Identifier') { if (node.name === RUNTIME_BINDING) bindings.add(node); }
      else if (node.type === 'ObjectPattern') pending.push(...node.properties.map((entry) => entry.type === 'RestElement' ? entry.argument : entry.value));
      else if (node.type === 'ArrayPattern') pending.push(...node.elements);
      else if (node.type === 'RestElement') pending.push(node.argument);
      else if (node.type === 'AssignmentPattern') pending.push(node.left);
    }
  };
  const walk = (visitor) => {
    const pending = [{ node: source, parent: undefined }];
    while (pending.length > 0) {
      const { node, parent } = pending.pop();
      visitor(node, parent);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const entry of value) if (entry !== null && typeof entry === 'object' && typeof entry.type === 'string') pending.push({ node: entry, parent: node }); }
        else if (value !== null && typeof value === 'object' && typeof value.type === 'string') pending.push({ node: value, parent: node });
      }
    }
  };
  walk((node) => {
    if (node.type === 'VariableDeclarator') addPatternBindings(node.id);
    if (node.type === 'CatchClause') addPatternBindings(node.param);
    if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type)) addPatternBindings(node.id);
    if (Array.isArray(node.params)) node.params.forEach(addPatternBindings);
    if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) addPatternBindings(node.local);
  });
  let references = 0;
  walk((node, parent) => {
    if (node.type !== 'Identifier' || node.name !== RUNTIME_BINDING || bindings.has(node)) return;
    // Property names and statement labels do not read the runtime binding.
    if ((!parent?.computed && parent?.property === node)
      || (!parent?.computed && parent?.key === node) || parent?.label === node) return;
    references += 1;
  });
  if (bindings.size !== 1 || references === 0) throw new Error(`${bundle} runtime identity binding is duplicated or unused`);
  return identity;
}

async function readStableArtifact(directory, name, limit = MAX_ARTIFACT_BYTES) {
  const path = resolve(directory, name);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > BigInt(limit)) {
    throw new Error(`execution identity artifact is outside the regular-file byte boundary: ${name}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino || BigInt(bytes.byteLength) !== before.size) {
    throw new Error(`execution identity artifact changed while reading: ${name}`);
  }
  return bytes;
}

async function inventoryExecutionBytes(distDirectory) {
  return Promise.all(INVENTORIED_FILES.map(async (path) => {
    const bytes = await readStableArtifact(distDirectory, path);
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }));
}

/** Independent postbuild inventory; its own bytes are intentionally excluded. */
export async function writeExecutionBundleInventory(distDirectory, identity) {
  assertExecutionIdentity(identity);
  const inventory = { schemaVersion: 'jsonlview.execution-bundle-inventory.v1',
    manifestSha256: identity.manifestSha256, files: await inventoryExecutionBytes(distDirectory) };
  await writeFile(resolve(distDirectory, EXECUTION_BUNDLE_INVENTORY), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
}

/** A frozen production pair is published only after compilation and source revalidation. */
export async function finalizeExecutionBuild({ rootDirectory, outputDirectory, identity }) {
  await assertExecutionIdentityMatchesSource(rootDirectory, identity);
  for (const bundle of ['extension.cjs', 'webview.js']) {
    const embedded = extractRuntimeExecutionIdentity((await readStableArtifact(outputDirectory, bundle)).toString('utf8'), bundle);
    if (canonicalJson(embedded) !== canonicalJson(identity)) throw new Error(`${bundle} runtime identity differs from build round`);
  }
  await writeExecutionIdentityManifest(outputDirectory, identity);
  await writeExecutionBundleInventory(outputDirectory, identity);
  return verifyBuiltExecutionIdentity(outputDirectory);
}

export async function verifyBuiltExecutionIdentity(distDirectory) {
  const identity = JSON.parse((await readStableArtifact(distDirectory, EXECUTION_IDENTITY_MANIFEST, 16 * 1024)).toString('utf8'));
  assertExecutionIdentity(identity);
  const { manifestSha256 } = identity;
  for (const bundle of ['extension.cjs', 'webview.js']) {
    const embedded = extractRuntimeExecutionIdentity((await readStableArtifact(distDirectory, bundle)).toString('utf8'), bundle);
    if (canonicalJson(embedded) !== canonicalJson(identity)) throw new Error(`${bundle} runtime identity differs from manifest`);
  }
  const inventory = JSON.parse((await readStableArtifact(distDirectory, EXECUTION_BUNDLE_INVENTORY, 16 * 1024)).toString('utf8'));
  const actualInventory = { schemaVersion: 'jsonlview.execution-bundle-inventory.v1', manifestSha256, files: await inventoryExecutionBytes(distDirectory) };
  if (canonicalJson(inventory) !== canonicalJson(actualInventory)) throw new Error('execution bundle inventory differs from current bundle bytes');
  process.stdout.write(`execution identity verified: ${identity.extensionId}@${identity.extensionVersion} build=${identity.buildMode} ${manifestSha256}\n`);
  return identity;
}

export async function verifyBuiltExecutionIdentityForSource({ rootDirectory, distDirectory, requireCleanProduction = true }) {
  const identity = await verifyBuiltExecutionIdentity(distDirectory);
  await assertExecutionIdentityMatchesSource(rootDirectory, identity, { requireCleanProduction });
  return identity;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  const distIndex = process.argv.indexOf('--dist');
  const distDirectory = distIndex >= 0 ? process.argv[distIndex + 1] : undefined;
  if (!distDirectory) throw new Error('usage: node scripts/execution-identity.mjs --dist <dist-directory>');
  const identity = await verifyBuiltExecutionIdentity(distDirectory);
  const receiptIndex = process.argv.indexOf('--receipt');
  if (receiptIndex >= 0) {
    const receiptPath = process.argv[receiptIndex + 1];
    if (!receiptPath || (await stat(receiptPath)).size > 16 * 1024) throw new Error('execution receipt is missing or exceeds 16 KiB');
    const readArgument = (name) => {
      const index = process.argv.indexOf(name);
      return index < 0 ? undefined : process.argv[index + 1];
    };
    verifyExecutionReceipt(JSON.parse(await readFile(receiptPath, 'utf8')), identity, {
      extensionId: readArgument('--extension-id'),
      extensionVersion: readArgument('--extension-version'),
      extensionMode: readArgument('--extension-mode'),
    });
    process.stdout.write('execution receipt verified against the selected artifact and host\n');
  }
}
