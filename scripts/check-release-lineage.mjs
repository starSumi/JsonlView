import { execFile as execFileCallback } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { normalizeRepositoryIdentity } from './repository-identity.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, '..');
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REPOSITORY = 'github.com/starsumi/jsonlview';
const SURFACES = ['npm', 'open-vsx', 'marketplace'];

if (isMainModule()) await main();

/**
 * Validate release identity without publishing or contacting a registry.
 *
 * The candidate, ledger, and readback files are external evidence inputs.
 * Their paths and contents are treated as untrusted; malformed or incomplete
 * evidence is a hard failure rather than a warning.
 */
export function validateReleaseLineage({ candidate, ledger, readback, git, expectedRepository = REPOSITORY }) {
  const failures = [];
  const warnings = [];
  const normalizedCandidate = normalizeCandidate(candidate, failures);
  const normalizedLedger = normalizeLedger(ledger, failures);
  const normalizedReadback = normalizeReadback(readback, failures);

  if (normalizedCandidate !== undefined && expectedRepository !== undefined
    && normalizedCandidate.source.repository !== expectedRepository) {
    failures.push(`candidate source.repository must be ${expectedRepository}`);
  }

  const currentSha = git?.headSha;
  if (normalizedCandidate !== undefined) {
    if (!SHA1.test(currentSha ?? '')) failures.push('git.headSha is missing or malformed');
    else if (currentSha.toLowerCase() !== normalizedCandidate.source.gitSha.toLowerCase()) {
      failures.push('candidate source.gitSha does not match the checked-out HEAD');
    }
  }

  const lineage = checkGitLineage(normalizedCandidate, git, failures);
  const ledgerEntries = normalizedLedger?.entries ?? [];
  const existing = normalizedCandidate === undefined
    ? undefined
    : ledgerEntries.find((entry) => entry.version === normalizedCandidate.version);
  const higherVersions = normalizedCandidate === undefined
    ? []
    : ledgerEntries.filter((entry) => compareSemver(entry.version, normalizedCandidate.version) > 0);

  if (existing !== undefined && normalizedCandidate !== undefined) {
    const differences = compareReleaseIdentity(existing, normalizedCandidate);
    if (differences.length > 0) {
      failures.push(...differences.map((difference) => `existing version ${normalizedCandidate.version} differs: ${difference}`));
    } else {
      warnings.push(`version ${normalizedCandidate.version} is an idempotent replay of the ledger entry`);
    }
  } else if (higherVersions.length > 0 && normalizedCandidate !== undefined) {
    failures.push(`candidate version ${normalizedCandidate.version} is lower than a recorded release (${higherVersions.map((entry) => entry.version).join(', ')})`);
  }
  if (normalizedCandidate !== undefined && lineage.tagState === 'exact' && existing === undefined) {
    failures.push(`version tag ${normalizedCandidate.source.tag} exists but the ledger has no matching version entry`);
  }

  const matchingReadbacks = normalizedCandidate === undefined
    ? []
    : normalizedReadback?.entries.filter((entry) => entry.version === normalizedCandidate.version) ?? [];
  if (normalizedCandidate !== undefined) {
    const readbackIssues = compareReadbacks(normalizedCandidate, matchingReadbacks, normalizedCandidate.state);
    failures.push(...readbackIssues);
    if (normalizedCandidate.state === 'candidate' && matchingReadbacks.length === 0) {
      warnings.push('registry readback is absent for an unpublished candidate; publication remains gated');
    }
  }

  if (normalizedCandidate?.state === 'published') {
    if (matchingReadbacks.length === 0) failures.push('published candidate requires registry readback entries for every artifact surface');
    if (lineage.tagState !== 'exact') failures.push('published candidate requires an exact version tag at the candidate commit');
    if (lineage.remoteContainsCandidate !== true) failures.push('published candidate commit is not an ancestor of the declared remote ref');
  }

  const ok = failures.length === 0;
  return {
    schemaVersion: 1,
    kind: 'jsonlview-release-lineage-report',
    ok,
    failures,
    warnings,
    candidate: normalizedCandidate === undefined ? null : summarizeCandidate(normalizedCandidate),
    ledger: {
      entries: ledgerEntries.length,
      versions: ledgerEntries.map((entry) => entry.version),
      matchingVersion: existing?.version ?? null,
    },
    registryReadback: {
      entries: normalizedReadback?.entries.length ?? 0,
      matchingVersion: normalizedCandidate?.version ?? null,
      matchedSurfaces: matchingReadbacks.map((entry) => entry.surface),
    },
    git: lineage,
    decision: ok
      ? existing === undefined ? 'new-candidate' : 'idempotent-replay'
      : 'blocked',
  };
}

/** Normalize and validate the external candidate evidence contract. */
export function normalizeCandidate(value, failures = []) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'jsonlview-release-candidate') {
    failures.push('candidate must declare schemaVersion 1 and kind jsonlview-release-candidate');
    return undefined;
  }
  const version = stringValue(value.version);
  if (version === undefined || !SEMVER.test(version)) failures.push('candidate.version must be a valid semantic version');
  const state = value.state;
  if (state !== 'candidate' && state !== 'published') failures.push('candidate.state must be candidate or published');
  const source = isRecord(value.source) ? value.source : {};
  const gitSha = stringValue(source.gitSha);
  const repositoryInput = stringValue(source.repository);
  const repository = repositoryInput === undefined ? undefined : normalizeRepositoryIdentity(repositoryInput);
  if (!SHA1.test(gitSha ?? '')) failures.push('candidate.source.gitSha must be a full commit id');
  if (repository === undefined) failures.push('candidate.source.repository is required');
  const tag = stringValue(source.tag) ?? (version === undefined ? undefined : `v${version}`);
  const remoteRef = stringValue(source.remoteRef);
  if (tag === undefined) failures.push('candidate.source.tag is required');
  if (remoteRef === undefined) failures.push('candidate.source.remoteRef is required');

  const artifactValue = Array.isArray(value.artifacts) ? value.artifacts : [];
  if (artifactValue.length !== SURFACES.length) failures.push(`candidate.artifacts must contain exactly ${SURFACES.length} entries`);
  const artifacts = [];
  const seen = new Set();
  for (const [index, item] of artifactValue.entries()) {
    const surface = stringValue(item?.surface);
    const coordinate = stringValue(item?.coordinate);
    const artifactVersion = stringValue(item?.version);
    const sha256 = stringValue(item?.sha256);
    const bytes = item?.bytes;
    if (!SURFACES.includes(surface ?? '')) failures.push(`candidate.artifacts[${index}].surface is unsupported`);
    if (surface !== undefined && seen.has(surface)) failures.push(`candidate.artifacts contains duplicate surface ${surface}`);
    if (surface !== undefined) seen.add(surface);
    if (coordinate === undefined) failures.push(`candidate.artifacts[${index}].coordinate is required`);
    if (artifactVersion !== version) failures.push(`candidate.artifacts[${index}].version must equal candidate.version`);
    if (!SHA256.test(sha256 ?? '')) failures.push(`candidate.artifacts[${index}].sha256 must be a SHA-256 digest`);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) failures.push(`candidate.artifacts[${index}].bytes must be a positive safe integer`);
    artifacts.push({ surface, coordinate, version: artifactVersion, sha256, bytes });
  }
  for (const surface of SURFACES) if (!seen.has(surface)) failures.push(`candidate.artifacts is missing ${surface}`);
  return {
    version,
    state,
    source: { gitSha, repository, tag, remoteRef },
    artifacts: artifacts.sort((left, right) => String(left.surface).localeCompare(String(right.surface))),
  };
}

export function normalizeLedger(value, failures = []) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'jsonlview-release-ledger' || !Array.isArray(value.entries)) {
    failures.push('ledger must declare schemaVersion 1, kind jsonlview-release-ledger, and entries');
    return undefined;
  }
  const entries = [];
  const seen = new Set();
  for (const [index, raw] of value.entries.entries()) {
    const candidate = normalizeLedgerEntry(raw, `ledger.entries[${index}]`, failures);
    if (candidate === undefined) continue;
    if (seen.has(candidate.version)) failures.push(`ledger contains duplicate version ${candidate.version}`);
    seen.add(candidate.version);
    entries.push(candidate);
  }
  return { entries: entries.sort((left, right) => compareSemver(left.version, right.version)) };
}

export function normalizeReadback(value, failures = []) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'jsonlview-registry-readbacks' || !Array.isArray(value.entries)) {
    failures.push('registry readback must declare schemaVersion 1, kind jsonlview-registry-readbacks, and entries');
    return undefined;
  }
  const entries = [];
  const seen = new Set();
  for (const [index, raw] of value.entries.entries()) {
    const surface = stringValue(raw?.surface);
    const coordinate = stringValue(raw?.coordinate);
    const version = stringValue(raw?.version);
    const sha256 = stringValue(raw?.sha256);
    const status = raw?.status;
    const bytes = raw?.bytes;
    const key = `${surface}:${version}`;
    if (!SURFACES.includes(surface ?? '')) failures.push(`registry readback entries[${index}].surface is unsupported`);
    if (coordinate === undefined) failures.push(`registry readback entries[${index}].coordinate is required`);
    if (version === undefined || !SEMVER.test(version)) failures.push(`registry readback entries[${index}].version is invalid`);
    if (!SHA256.test(sha256 ?? '')) failures.push(`registry readback entries[${index}].sha256 must be a SHA-256 digest`);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0)) failures.push(`registry readback entries[${index}].bytes must be a positive safe integer when supplied`);
    if (status !== 'published') failures.push(`registry readback entries[${index}].status must be published`);
    if (seen.has(key)) failures.push(`registry readback contains duplicate ${key}`);
    seen.add(key);
    entries.push({ surface, coordinate, version, sha256, bytes });
  }
  return { entries };
}

function normalizeLedgerEntry(value, label, failures) {
  const version = stringValue(value?.version);
  if (version === undefined || !SEMVER.test(version)) failures.push(`${label}.version is invalid`);
  const source = isRecord(value?.source) ? value.source : {};
  const gitSha = stringValue(source.gitSha);
  if (!SHA1.test(gitSha ?? '')) failures.push(`${label}.source.gitSha is invalid`);
  const artifacts = Array.isArray(value?.artifacts) ? value.artifacts : [];
  if (artifacts.length !== SURFACES.length) failures.push(`${label}.artifacts must contain exactly ${SURFACES.length} entries`);
  const normalized = [];
  const seen = new Set();
  for (const [index, item] of artifacts.entries()) {
    const surface = stringValue(item?.surface);
    const coordinate = stringValue(item?.coordinate);
    const sha256 = stringValue(item?.sha256);
    const artifactVersion = stringValue(item?.version);
    if (!SURFACES.includes(surface ?? '')) failures.push(`${label}.artifacts[${index}].surface is unsupported`);
    if (surface !== undefined && seen.has(surface)) failures.push(`${label}.artifacts contains duplicate surface ${surface}`);
    if (surface !== undefined) seen.add(surface);
    if (coordinate === undefined) failures.push(`${label}.artifacts[${index}].coordinate is required`);
    if (artifactVersion !== version) failures.push(`${label}.artifacts[${index}].version must equal the ledger version`);
    if (!SHA256.test(sha256 ?? '')) failures.push(`${label}.artifacts[${index}].sha256 is invalid`);
    normalized.push({ surface, coordinate, version: artifactVersion, sha256, bytes: item?.bytes });
  }
  for (const surface of SURFACES) if (!seen.has(surface)) failures.push(`${label}.artifacts is missing ${surface}`);
  return { version, source: { gitSha }, artifacts: normalized.sort((left, right) => String(left.surface).localeCompare(String(right.surface))) };
}

function compareReleaseIdentity(left, right) {
  const failures = [];
  if (left.source.gitSha.toLowerCase() !== right.source.gitSha.toLowerCase()) failures.push('source commit differs');
  const leftArtifacts = new Map(left.artifacts.map((item) => [item.surface, item]));
  for (const artifact of right.artifacts) {
    const previous = leftArtifacts.get(artifact.surface);
    if (previous === undefined) failures.push(`${artifact.surface} artifact is missing from the ledger`);
    else if (previous.coordinate !== artifact.coordinate || previous.sha256.toLowerCase() !== artifact.sha256.toLowerCase() || previous.bytes !== artifact.bytes) {
      failures.push(`${artifact.surface} artifact coordinate, digest, or size differs`);
    }
  }
  return failures;
}

function compareReadbacks(candidate, entries, state) {
  const failures = [];
  const bySurface = new Map(entries.map((entry) => [entry.surface, entry]));
  for (const artifact of candidate.artifacts) {
    const readback = bySurface.get(artifact.surface);
    if (readback === undefined) {
      if (state === 'published') failures.push(`registry readback is missing ${artifact.surface} for version ${candidate.version}`);
      continue;
    }
    if (readback.coordinate !== artifact.coordinate) failures.push(`registry readback coordinate differs for ${artifact.surface}`);
    if (readback.sha256.toLowerCase() !== artifact.sha256.toLowerCase()) failures.push(`registry readback digest differs for ${artifact.surface}`);
    if (readback.bytes !== undefined && readback.bytes !== artifact.bytes) failures.push(`registry readback byte count differs for ${artifact.surface}`);
  }
  for (const readback of entries) if (!candidate.artifacts.some((artifact) => artifact.surface === readback.surface)) failures.push(`registry readback contains an undeclared surface ${readback.surface}`);
  return failures;
}

function checkGitLineage(candidate, git, failures) {
  const result = {
    headSha: git?.headSha ?? null,
    tagRef: candidate?.source.tag ?? null,
    tagState: git?.tagState ?? 'unavailable',
    tagSha: git?.tagSha ?? null,
    remoteRef: candidate?.source.remoteRef ?? null,
    remoteSha: git?.remoteSha ?? null,
    remoteContainsCandidate: git?.remoteContainsCandidate ?? null,
    candidateContainsRemote: git?.candidateContainsRemote ?? null,
  };
  if (candidate === undefined) return result;
  if (git?.tagState === 'mismatch') failures.push(`version tag ${candidate.source.tag} points to a different commit`);
  if (git?.tagState === 'unavailable') failures.push('version tag lineage could not be inspected');
  if (git?.remoteSha === undefined || !SHA1.test(git.remoteSha)) failures.push(`remote ref ${candidate.source.remoteRef} could not be resolved`);
  if (git?.remoteContainsCandidate === false && git?.candidateContainsRemote === false) failures.push('candidate and remote ref have unrelated history');
  return result;
}

function summarizeCandidate(candidate) {
  return {
    version: candidate.version,
    state: candidate.state,
    source: { ...candidate.source },
    artifacts: candidate.artifacts.map(({ surface, coordinate, version, sha256, bytes }) => ({ surface, coordinate, version, sha256, bytes })),
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) return String(left).localeCompare(String(right));
  for (const index of [0, 1, 2]) if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  if (a.pre === undefined && b.pre !== undefined) return 1;
  if (a.pre !== undefined && b.pre === undefined) return -1;
  if (a.pre === undefined && b.pre === undefined) return 0;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.pre.length) return -1;
    if (index >= b.pre.length) return 1;
    const leftPart = a.pre[index];
    const rightPart = b.pre[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function parseSemver(value) {
  const match = SEMVER.exec(String(value));
  if (match === null) return undefined;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
}

export async function inspectGitLineage({ cwd = root, candidateSha, tagRef, remoteRef }) {
  const headSha = await gitText(['rev-parse', 'HEAD'], cwd);
  const tagSha = tagRef === undefined ? undefined : await gitText(['rev-parse', `${tagRef}^{commit}`], cwd);
  const remoteSha = remoteRef === undefined ? undefined : await gitText(['rev-parse', `${remoteRef}^{commit}`], cwd);
  const tagState = tagSha === undefined ? 'absent' : tagSha.toLowerCase() === String(candidateSha).toLowerCase() ? 'exact' : 'mismatch';
  const remoteContainsCandidate = candidateSha !== undefined && remoteRef !== undefined
    ? await isAncestor(candidateSha, remoteRef, cwd)
    : undefined;
  const candidateContainsRemote = candidateSha !== undefined && remoteRef !== undefined
    ? await isAncestor(remoteRef, candidateSha, cwd)
    : undefined;
  return { headSha, tagSha, remoteSha, tagState, remoteContainsCandidate, candidateContainsRemote };
}

async function isAncestor(ancestor, descendant, cwd) {
  try {
    await execFile('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, windowsHide: true });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    return undefined;
  }
}

async function gitText(args, cwd) {
  try {
    const result = await execFile('git', args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const value = result.stdout.trim();
    return SHA1.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [candidate, ledger, readback, packageJson] = await Promise.all([
    readJson(options.candidate, 'candidate'),
    readJson(options.ledger, 'ledger'),
    readJson(options.readback, 'registry readback'),
    readJson(resolve(root, 'package.json'), 'package.json'),
  ]);
  const candidateSource = isRecord(candidate?.source) ? candidate.source : {};
  const git = await inspectGitLineage({
    candidateSha: candidateSource.gitSha,
    tagRef: candidateSource.tag ?? (candidate?.version === undefined ? undefined : `refs/tags/v${candidate.version}`),
    remoteRef: candidateSource.remoteRef,
  });
  const report = validateReleaseLineage({
    candidate,
    ledger,
    readback,
    git,
    expectedRepository: normalizeRepository(packageJson.repository),
  });
  if (options.out !== undefined) {
    const output = resolve(options.out);
    await assertOutsideCheckout(output, 'lineage report output');
    await assertOutputReady(output, options.replace);
    await mkdir(dirname(output), { recursive: true });
    await writeAtomic(output, report);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

export function parseArgs(args) {
  const input = args[0] === '--' ? args.slice(1) : [...args];
  const parsed = { candidate: undefined, ledger: undefined, readback: undefined, out: undefined, replace: false };
  for (let index = 0; index < input.length; index += 1) {
    const key = input[index];
    if (key === '--replace') { parsed.replace = true; continue; }
    const value = input[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--candidate') parsed.candidate = resolve(value);
    else if (key === '--ledger') parsed.ledger = resolve(value);
    else if (key === '--registry-readback') parsed.readback = resolve(value);
    else if (key === '--out') parsed.out = resolve(value);
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  for (const [flag, value] of [['--candidate', parsed.candidate], ['--ledger', parsed.ledger], ['--registry-readback', parsed.readback]]) {
    if (value === undefined) throw new Error(`${flag} is required`);
  }
  return parsed;
}

function normalizeRepository(value) {
  if (typeof value === 'string') return normalizeRepositoryIdentity(value);
  if (isRecord(value) && typeof value.url === 'string') return normalizeRepositoryIdentity(value.url);
  return undefined;
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(resolve(path), 'utf8')); }
  catch (error) { throw new Error(`cannot read ${label}: ${path}`, { cause: error }); }
}

async function assertOutsideCheckout(path, label) {
  const resolved = resolve(path);
  const within = relative(root, resolved);
  if (within === '' || (!isAbsolute(within) && !within.startsWith('..'))) throw new Error(`${label} must be outside the product checkout: ${path}`);
  let cursor = resolved;
  while (true) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`${label} cannot pass through a symbolic-link ancestor: ${cursor}`); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function assertOutputReady(path, replace) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`lineage report output must be a regular file: ${path}`);
    if (!replace) throw new Error(`lineage report output already exists; pass --replace for an intentional overwrite: ${path}`);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

async function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function stringValue(value) { return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined; }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isMainModule() { const entry = process.argv[1]; return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href; }
