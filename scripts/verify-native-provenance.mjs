import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertNativeContract,
  readNativeContract,
  NATIVE_ABI_VERSION,
  NATIVE_CAPABILITY_SCAN_LF,
} from './native-contract.mjs';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'native', 'jsonl-core');
const DEFAULT_COMMITTED_BINARY = resolve(DEFAULT_SOURCE_ROOT, 'jsonl_core.win32-x64-msvc.node');
const PROVENANCE_SCHEMA_VERSION = 1;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const execFile = promisify(execFileCallback);

/**
 * Inputs that can affect the napi-rs cdylib. Generated output and Cargo's
 * target directory are deliberately excluded. The resulting digest is a
 * source identity, not a claim that two toolchains produce byte-identical
 * machine code.
 */
const REQUIRED_SOURCE_FILES = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'package.json'];
const OPTIONAL_SOURCE_FILES = [
  'rust-toolchain.toml',
  '.cargo/config.toml',
  '../rust-toolchain.toml',
  '../.cargo/config.toml',
  '../../rust-toolchain.toml',
  '../../.cargo/config.toml',
];

const TEST_VECTORS = [
  { name: 'lf-and-crlf', input: Buffer.from('one\ntwo\r\nthree\n', 'utf8'), start: 0, limit: 2, expected: [3, 8] },
  { name: 'resume-after-page', input: Buffer.from('zero\none\ntwo\n', 'utf8'), start: 5, limit: 8, expected: [8, 12] },
  { name: 'utf8-byte-offsets', input: Buffer.from('雪\nx\n', 'utf8'), start: 0, limit: 8, expected: [3, 5] },
  { name: 'empty', input: Buffer.alloc(0), start: 0, limit: 8, expected: [] },
];

export async function computeSourceManifest(sourceRoot = DEFAULT_SOURCE_ROOT) {
  const root = resolve(sourceRoot);
  const files = [];
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    files.push(await readSourceFile(root, relativePath, true));
  }
  for (const relativePath of OPTIONAL_SOURCE_FILES) {
    if (await isFile(resolve(root, relativePath))) files.push(await readSourceFile(root, relativePath, false));
  }
  const sourceFiles = await collectRustSources(resolve(root, 'src'));
  if (sourceFiles.length === 0) throw new Error(`native source directory is empty: ${root}`);
  for (const file of sourceFiles) files.push(await readSourceFile(root, file, true));
  files.sort((left, right) => stableCompare(left.path, right.path));

  const aggregate = createHash('sha256');
  for (const file of files) {
    aggregate.update(file.path);
    aggregate.update('\0');
    aggregate.update(String(file.bytes));
    aggregate.update('\0');
    aggregate.update(file.contents);
  }
  return {
    root: toReportPath(root),
    sha256: aggregate.digest('hex'),
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
}

export async function inspectNativeBinary(binaryPath) {
  const path = resolve(binaryPath);
  const binary = await readFile(path);
  const privatePathMarkers = findPrivatePathMarkers(binary);
  const require = createRequire(import.meta.url);
  let binding;
  try {
    binding = require(path);
  } catch (error) {
    throw new Error(`cannot load native addon ${toReportPath(path)}: ${error.message}`, { cause: error });
  }
  const contract = readNativeContract(binding);
  if (contract === undefined) throw new Error(`native addon has no complete contract: ${toReportPath(path)}`);
  assertNativeContract(contract);
  const vectors = TEST_VECTORS.map((vector) => {
    const observed = Array.from(binding.scanLf(vector.input, vector.start, vector.limit));
    if (!sameNumbers(observed, vector.expected)) {
      throw new Error(`${basename(path)} vector ${vector.name} mismatch: ${JSON.stringify({ observed, expected: vector.expected })}`);
    }
    return { name: vector.name, offsets: observed };
  });
  return {
    path: toReportPath(path),
    bytes: binary.byteLength,
    sha256: createHash('sha256').update(binary).digest('hex'),
    privatePathMarkers,
    contract,
    vectors,
  };
}

export async function locateNativeBinary(candidate) {
  const path = resolve(candidate);
  const details = await stat(path);
  if (details.isFile()) {
    if (extname(path).toLowerCase() !== '.node') throw new Error(`candidate is not a .node file: ${toReportPath(path)}`);
    return path;
  }
  if (!details.isDirectory()) throw new Error(`candidate is neither a file nor directory: ${toReportPath(path)}`);
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.node'))
    .map((entry) => resolve(path, entry.name));
  if (entries.length !== 1) {
    throw new Error(`candidate directory must contain exactly one .node file: ${toReportPath(path)} (${entries.length})`);
  }
  return entries[0];
}

export function buildProvenanceReport({ source, committed, rebuilt, toolchain = {}, repository = {} }) {
  const sameContract = committed === undefined
    ? undefined
    : committed.contract.abiVersion === rebuilt.contract.abiVersion
      && committed.contract.capabilities === rebuilt.contract.capabilities;
  const sameBehavior = committed === undefined
    ? undefined
    : JSON.stringify(committed.vectors) === JSON.stringify(rebuilt.vectors);
  const noPrivatePathMarkers = (committed?.privatePathMarkers ?? []).length === 0
    && (rebuilt.privatePathMarkers ?? []).length === 0;
  // Candidate-only mode is the safe default for untrusted PRs: the candidate
  // was built in this job and is the only addon that gets loaded. Full
  // committed-vs-rebuilt comparison remains available for a trusted release.
  const candidateChecksPass = rebuilt !== undefined
    && rebuilt.contract.abiVersion === NATIVE_ABI_VERSION
    && (rebuilt.contract.capabilities & NATIVE_CAPABILITY_SCAN_LF) === NATIVE_CAPABILITY_SCAN_LF
    && noPrivatePathMarkers;
  const comparisonPass = committed === undefined
    ? candidateChecksPass
    : candidateChecksPass && sameContract === true && sameBehavior === true;
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    ok: comparisonPass,
    recordedAt: new Date().toISOString(),
    source,
    expectedContract: { abiVersion: NATIVE_ABI_VERSION, requiredCapabilities: NATIVE_CAPABILITY_SCAN_LF },
    binaries: {
      ...(committed === undefined ? {} : { committed }),
      rebuilt,
    },
    comparison: {
      sourceDigest: source.sha256,
      contractEqual: sameContract,
      behaviorEqual: sameBehavior,
      noPrivatePathMarkers,
      byteIdentical: committed === undefined ? undefined : committed.sha256 === rebuilt.sha256,
      byteIdentityRequired: false,
      committedBinaryChecked: committed !== undefined,
      candidateChecksPass,
    },
    runtime: {
      node: process.version,
      platform: platform(),
      architecture: process.arch,
      osRelease: release(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
    },
    repository,
    toolchain,
  };
}

/**
 * Bind a provenance report to the source tree and HEAD observed by the caller.
 * This is deliberately reusable by release-preflight: a clean report is not
 * release evidence when it was produced for another commit or native source
 * snapshot.
 */
export function validateProvenanceSourceBinding(report, current) {
  const repositoryGitSha = report?.repository?.gitSha;
  const reportedSourceDigest = report?.comparison?.sourceDigest;
  const sourceManifestDigest = report?.source?.sha256;
  const currentGitSha = current?.gitSha;
  const currentSourceDigest = current?.sourceDigest;
  const repositoryHeadMatchesCurrent = GIT_SHA_PATTERN.test(repositoryGitSha ?? '')
    && GIT_SHA_PATTERN.test(currentGitSha ?? '')
    && repositoryGitSha.toLowerCase() === currentGitSha.toLowerCase();
  const sourceDigestMatchesCurrent = SHA256_PATTERN.test(reportedSourceDigest ?? '')
    && SHA256_PATTERN.test(currentSourceDigest ?? '')
    && reportedSourceDigest.toLowerCase() === currentSourceDigest.toLowerCase();
  const sourceManifestMatchesReport = SHA256_PATTERN.test(sourceManifestDigest ?? '')
    && SHA256_PATTERN.test(reportedSourceDigest ?? '')
    && sourceManifestDigest.toLowerCase() === reportedSourceDigest.toLowerCase();
  return {
    ok: repositoryHeadMatchesCurrent && sourceDigestMatchesCurrent && sourceManifestMatchesReport,
    repositoryHeadMatchesCurrent,
    sourceDigestMatchesCurrent,
    sourceManifestMatchesReport,
  };
}

function findPrivatePathMarkers(binary) {
  // Release binaries must not carry the builder's user/profile paths. Return
  // only short hashes so the provenance report cannot become a path leak.
  const text = binary.toString('latin1');
  // Require at least two readable path components after the root. A bare
  // `C:\\` byte sequence occurs naturally in machine code and is not a path.
  const matches = text.match(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\/(?:Users|home)\/)[A-Za-z0-9._~$()\- ]+(?:[\\/][A-Za-z0-9._~$()\- ]+)+/g) ?? [];
  return [...new Set(matches.map((match) => createHash('sha256').update(match).digest('hex').slice(0, 16)))].slice(0, 32);
}

export function parseArguments(args) {
  const parsed = {
    candidate: undefined,
    committed: DEFAULT_COMMITTED_BINARY,
    skipCommitted: false,
    sourceRoot: DEFAULT_SOURCE_ROOT,
    out: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--skip-committed') {
      parsed.skipCommitted = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
    if (argument === '--candidate') parsed.candidate = resolve(value);
    else if (argument === '--committed') parsed.committed = resolve(value);
    else if (argument === '--source-root') parsed.sourceRoot = resolve(value);
    else if (argument === '--out') parsed.out = resolve(value);
    else throw new Error(`unknown argument: ${argument}`);
    index += 1;
  }
  if (parsed.candidate === undefined) throw new Error('--candidate is required for a source rebuild gate');
  return parsed;
}

export async function runProvenance(options) {
  const source = await computeSourceManifest(options.sourceRoot);
  const committed = options.skipCommitted ? undefined : await inspectNativeBinary(options.committed);
  const rebuiltPath = await locateNativeBinary(options.candidate);
  const rebuilt = await inspectNativeBinary(rebuiltPath);
  const toolchain = await readToolchainVersions();
  const repository = await readRepositoryIdentity();
  const report = buildProvenanceReport({ source, committed, rebuilt, toolchain, repository });
  // Re-probe after every executable and source read. This catches a checkout
  // or native-source change racing the provenance run instead of blessing a
  // mixed snapshot under whichever identity happened to be read last.
  const [currentSource, currentRepository] = await Promise.all([
    computeSourceManifest(options.sourceRoot),
    readRepositoryIdentity(),
  ]);
  const sourceBinding = validateProvenanceSourceBinding(report, {
    gitSha: currentRepository.gitSha,
    sourceDigest: currentSource.sha256,
  });
  Object.assign(report.comparison, sourceBinding);
  report.ok = report.ok && sourceBinding.ok;
  if (options.out !== undefined) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (!report.ok) {
    const error = new Error(`native provenance gate failed: ${JSON.stringify(report.comparison)}`);
    error.provenanceReport = report;
    throw error;
  }
  return report;
}

async function collectRustSources(directory, prefix = 'src') {
  if (!(await isDirectory(directory))) return [];
  const output = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => stableCompare(left.name, right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`symlink is not a source input: ${resolve(directory, entry.name)}`);
    const child = resolve(directory, entry.name);
    const childRelative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) output.push(...await collectRustSources(child, childRelative));
    else if (entry.isFile() && entry.name.endsWith('.rs')) output.push(childRelative);
  }
  return output;
}

async function readSourceFile(root, relativePath, required) {
  const path = resolve(root, relativePath);
  if (!(await isFile(path))) {
    if (required) throw new Error(`required native source input is missing: ${relativePath}`);
    return undefined;
  }
  const contents = await readFile(path);
  return {
    path: relativePath.replaceAll(sep, '/'),
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
    contents,
  };
}

async function readToolchainVersions() {
  const toolchain = {};
  for (const [name, command, args] of [['rustc', 'rustc', ['-Vv']], ['cargo', 'cargo', ['-V']]]) {
    try {
      const result = await execFile(command, args, { cwd: REPOSITORY_ROOT, windowsHide: true });
      toolchain[name] = result.stdout.trim();
    } catch {
      toolchain[name] = 'unavailable';
    }
  }
  return toolchain;
}

async function readRepositoryIdentity() {
  try {
    const revision = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT, windowsHide: true })).stdout.trim();
    const status = (await execFile('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: REPOSITORY_ROOT,
      windowsHide: true,
    })).stdout.trim();
    return {
      gitSha: /^[0-9a-f]{7,64}$/i.test(revision) ? revision : 'unavailable',
      workingTreeClean: status.length === 0,
    };
  } catch {
    return { gitSha: 'unavailable' };
  }
}

async function isFile(path) {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toReportPath(path) {
  const normalized = relative(REPOSITORY_ROOT, resolve(path)).replaceAll(sep, '/');
  if (normalized === '' || (!normalized.startsWith('../') && normalized !== '..')) return normalized || '.';
  // Keep runner-local paths out of committed/reviewed evidence.
  return `<external>/${basename(path)}`;
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  runProvenance(options)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch(async (error) => {
      console.error(error.stack || error.message);
      if (options.out !== undefined) {
        await mkdir(dirname(options.out), { recursive: true });
        const report = error.provenanceReport ?? { schemaVersion: PROVENANCE_SCHEMA_VERSION, ok: false, error: error.message };
        await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      }
      process.exitCode = 1;
    });
}
