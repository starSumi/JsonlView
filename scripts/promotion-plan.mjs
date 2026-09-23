import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactDirectory } from './artifact-directory.mjs';
import { isApprovedPublicLicense } from './license-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const SHA256 = /^[0-9a-f]{64}$/i;
const SHA1 = /^[0-9a-f]{40}$/i;
const SEMVER = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const PUBLISHER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

if (isMainModule()) await main();

/**
 * Build a promotion state machine from already-produced evidence.
 *
 * This module deliberately has no registry, Git, VS Code, or shell write path.
 * It only joins the local-sync, VSIX, npm, and preflight manifests and emits a
 * target-specific pending plan. A separate operator or protected CI job owns
 * publication and must append independent readback evidence.
 */
export function buildPromotionPlan({ preflight, local, vsix, npm, localReloaded = false, createdAt = new Date().toISOString() }) {
  const blockers = [];
  const preflightChecks = isRecord(preflight?.checks) ? preflight.checks : {};
  if (preflight?.mode !== 'public-release') {
    blockers.push(`release preflight mode is not public-release (observed ${String(preflight?.mode)})`);
  }
  if (preflight?.ok !== true) {
    blockers.push(`release preflight is not green (${summarizeFailures(preflight?.failures)})`);
  }
  if (preflightChecks.git?.remoteConfigured !== true) blockers.push('preflight does not prove a configured Git remote');
  for (const checkName of ['package', 'npmCandidate', 'vsixCandidate', 'nativeProvenance']) {
    if (!isRecord(preflightChecks[checkName])) blockers.push(`preflight is missing checks.${checkName}`);
  }
  const gatePackage = preflightChecks.package;
  if (isRecord(gatePackage)) {
    for (const field of ['name', 'publisher', 'version', 'license', 'repository']) requireField(`preflight package.${field}`, gatePackage[field], blockers);
    if (gatePackage.private !== false) blockers.push('preflight package is private or omits private=false');
  }
  for (const checkName of ['npmCandidate', 'vsixCandidate']) {
    const candidateCheck = preflightChecks[checkName];
    if (isRecord(candidateCheck)) {
      if (candidateCheck.integrity !== true) blockers.push(`preflight ${checkName} integrity was not verified`);
      if (candidateCheck.clean !== undefined && candidateCheck.clean !== true) blockers.push(`preflight ${checkName} source was not clean`);
    }
  }
  const nativeCheck = preflightChecks.nativeProvenance;
  if (isRecord(nativeCheck)) {
    for (const field of ['ok', 'committedBinaryChecked', 'contractEqual', 'behaviorEqual']) {
      if (nativeCheck[field] !== true) blockers.push(`preflight native provenance ${field} did not pass`);
    }
  }

  const source = normalizeSource(preflightChecks.git, 'preflight.checks.git', blockers);
  const sourceSnapshots = [
    normalizeSource(vsix?.source, 'vsix.source', blockers),
    normalizeSource(npm?.source, 'npm.source', blockers),
    normalizeSource(local?.source, 'local.source', blockers),
  ];
  for (const [index, snapshot] of sourceSnapshots.entries()) {
    compareSource(source, snapshot, `source[${index}]`, blockers);
  }

  const localCandidate = isRecord(local?.candidate) ? local.candidate : {};
  const vsixPackage = isRecord(vsix?.package) ? vsix.package : {};
  const npmPackage = isRecord(npm?.package) ? npm.package : {};
  const vsixArtifact = isRecord(vsix?.artifact) ? vsix.artifact : {};

  const extensionName = stringOrUndefined(localCandidate.name)
    ?? stringOrUndefined(vsixPackage.name)
    ?? npmBaseName(npmPackage.name);
  const version = stringOrUndefined(localCandidate.version)
    ?? stringOrUndefined(vsixPackage.version)
    ?? stringOrUndefined(npmPackage.version);
  const publisher = stringOrUndefined(localCandidate.publisher)
    ?? stringOrUndefined(vsixPackage.publisher);
  const npmName = stringOrUndefined(npmPackage.name);
  const approvedNpmName = stringOrUndefined(preflightChecks.npmCandidate?.approvedName);

  if (extensionName === undefined) blockers.push('extension name is missing from the candidate manifests');
  else if (!EXTENSION_NAME.test(extensionName)) blockers.push('extension name is malformed');
  if (version === undefined || !SEMVER.test(version)) blockers.push('candidate version is missing or not semver');
  if (publisher === undefined) blockers.push('VS Code publisher is missing from the local/VSIX candidate');
  else if (!PUBLISHER.test(publisher)) blockers.push('VS Code publisher is malformed');
  if (npmName === undefined) blockers.push('npm package name is missing from the npm candidate');
  else if (!NPM_NAME.test(npmName)) blockers.push('npm package name is malformed');
  if (approvedNpmName === undefined) {
    blockers.push('preflight does not record an approved exact npm package name');
  } else if (npmName !== undefined && npmName !== approvedNpmName) {
    blockers.push('npm candidate name differs from the preflight approved package identity');
  }
  if (extensionName !== undefined && npmName !== undefined && npmBaseName(npmName) !== extensionName) {
    blockers.push('VSIX extension name differs from the npm package base name');
  }

  requireField('local candidate version', localCandidate.version, blockers);
  requireField('VSIX candidate version', vsixPackage.version, blockers);
  requireField('npm candidate version', npmPackage.version, blockers);
  requireField('VSIX candidate publisher', vsixPackage.publisher, blockers);
  requireField('npm candidate publisher', npmPackage.publisher, blockers);
  if (localCandidate.extensionId !== undefined && publisher !== undefined && extensionName !== undefined) {
    const expectedExtensionId = `${publisher}.${extensionName}`;
    if (String(localCandidate.extensionId).toLowerCase() !== expectedExtensionId.toLowerCase()) {
      blockers.push('local VSIX extension id does not match publisher and extension name');
    }
  } else {
    blockers.push('local VSIX extension id is missing');
  }
  compareEqual('version', [localCandidate.version, vsixPackage.version, npmPackage.version], blockers);
  compareEqual('publisher', [localCandidate.publisher, vsixPackage.publisher, npmPackage.publisher], blockers);
  compareEqual('npm package version', [version, npmPackage.version], blockers);
  if (isRecord(gatePackage)) {
    compareEqual('preflight package name', [gatePackage.name, extensionName], blockers);
    compareEqual('preflight package publisher', [gatePackage.publisher, publisher], blockers);
    compareEqual('preflight package version', [gatePackage.version, version], blockers);
  }

  if (vsixPackage.private !== false) blockers.push('VSIX candidate is private or omits the public flag');
  if (npmPackage.private !== false) blockers.push('npm candidate is private or omits the public flag');
  if (!isPublishableLicense(vsixPackage.license) || !isPublishableLicense(npmPackage.license)) {
    blockers.push('candidate license is missing or not publishable');
  }

  const localDigest = stringOrUndefined(localCandidate.sha256);
  const vsixDigest = stringOrUndefined(vsixArtifact.sha256);
  if (localDigest === undefined) blockers.push('local VSIX digest is missing');
  if (vsixDigest === undefined) blockers.push('VSIX artifact digest is missing');
  if (localDigest !== undefined && !SHA256.test(localDigest)) blockers.push('local VSIX digest is malformed');
  if (vsixDigest !== undefined && !SHA256.test(vsixDigest)) blockers.push('VSIX artifact digest is malformed');
  if (localDigest !== undefined && vsixDigest !== undefined && localDigest.toLowerCase() !== vsixDigest.toLowerCase()) {
    blockers.push('local installed candidate and VSIX release candidate have different digests; install the exact reviewed VSIX');
  }

  const localInstalled = local?.vscode?.status === 'installed';
  const manifestReloaded = local?.vscode?.activeWindowReloaded === true;
  if (!localInstalled) blockers.push('local VSIX sync is not verified as installed');
  if (!localReloaded && !manifestReloaded) blockers.push('active VS Code window has not been reloaded/read back');

  const readyForPromotion = blockers.length === 0;
  const targetStatus = readyForPromotion ? 'pending-authorization' : 'blocked-by-gate';
  const localStatus = localInstalled && (localReloaded || manifestReloaded) ? 'accepted' : 'awaiting-reload';

  return {
    schemaVersion: 1,
    operation: 'promotion-plan',
    createdAt,
    publication: 'plan-only; no external writes or registry calls were performed',
    readyForPromotion,
    blockers,
    source: redactSource(source),
    candidate: {
      extensionName: extensionName ?? null,
      publisher: publisher ?? null,
      version: version ?? null,
      npmName: npmName ?? null,
      approvedNpmName: approvedNpmName ?? null,
      vsixSha256: vsixDigest ?? localDigest ?? null,
    },
    authorization: {
      required: true,
      supplied: false,
      scope: 'each target independently; this plan is never authorization',
    },
    targets: {
      localVsCode: {
        status: localStatus,
        evidence: redactLocalEvidence(local),
        reloadEvidence: manifestReloaded ? 'manifest' : localReloaded ? 'operator-asserted' : 'missing',
        readbackRequired: true,
      },
      github: targetStatusObject(targetStatus, 'push reviewed ref and read back commit/tag/release'),
      npm: targetStatusObject(targetStatus, 'publish exact npm candidate and read back version/integrity'),
      openVsx: targetStatusObject(targetStatus, 'publish exact VSIX and read back extension/version/digest'),
      marketplace: targetStatusObject(targetStatus, 'publish exact VSIX and read back extension/version'),
    },
  };
}

function targetStatusObject(status, action) {
  return {
    status,
    authorizationRequired: true,
    action,
    readbackRequired: true,
    publicationAttempted: false,
  };
}

function normalizeSource(value, label, blockers) {
  const source = isRecord(value) ? value : {};
  const gitSha = firstString(source.gitSha, source.sha, source.revision);
  const gitState = firstString(source.gitState, source.state)
    ?? (source.clean === true ? 'clean' : source.clean === false ? 'dirty' : undefined);
  const statusSha256 = firstString(source.statusSha256);
  const diffSha256 = firstString(source.diffSha256);
  if (gitSha === undefined || !SHA1.test(gitSha)) blockers.push(`${label}.gitSha is missing or malformed`);
  if (gitState !== 'clean') blockers.push(`${label}.gitState is not clean`);
  if (statusSha256 === undefined || !SHA256.test(statusSha256)) blockers.push(`${label}.statusSha256 is missing or malformed`);
  if (diffSha256 === undefined || !SHA256.test(diffSha256)) blockers.push(`${label}.diffSha256 is missing or malformed`);
  return { gitSha, gitState, statusSha256, diffSha256 };
}

function compareSource(expected, observed, label, blockers) {
  for (const field of ['gitSha', 'gitState', 'statusSha256', 'diffSha256']) {
    if (expected[field] === undefined || observed[field] === undefined) continue;
    if (String(expected[field]).toLowerCase() !== String(observed[field]).toLowerCase()) {
      blockers.push(`${label}.${field} differs from the preflight source identity`);
    }
  }
}

function compareEqual(label, values, blockers) {
  const present = values.filter((value) => value !== undefined && value !== null && value !== '');
  if (present.length < 2) return;
  const first = String(present[0]);
  if (present.some((value) => String(value) !== first)) blockers.push(`${label} differs between candidate manifests`);
}

function redactLocalEvidence(local) {
  const candidate = isRecord(local?.candidate) ? local.candidate : {};
  const vscode = isRecord(local?.vscode) ? local.vscode : {};
  return {
    extensionId: stringOrUndefined(candidate.extensionId) ?? null,
    version: stringOrUndefined(candidate.version) ?? null,
    sha256: validDigestOrNull(candidate.sha256),
    status: stringOrUndefined(vscode.status) ?? 'unknown',
    reloadRequired: vscode.reloadRequired === true,
    activeWindowReloaded: vscode.activeWindowReloaded === true,
  };
}

function redactSource(source) {
  return {
    gitSha: source.gitSha ?? null,
    gitState: source.gitState ?? null,
    statusSha256: validDigestOrNull(source.statusSha256),
    diffSha256: validDigestOrNull(source.diffSha256),
  };
}

function validDigestOrNull(value) {
  return typeof value === 'string' && SHA256.test(value) ? value.toLowerCase() : null;
}

function npmBaseName(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.startsWith('@') ? value.slice(value.indexOf('/') + 1) : value;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isUnpublishableLicense(value) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  return normalized === undefined || normalized === null || normalized === '' || normalized === 'UNLICENSED' || normalized === 'SEE LICENSE IN LICENSE.txt';
}

function isPublishableLicense(value) {
  return !isUnpublishableLicense(value) && isApprovedPublicLicense(value);
}

function requireField(label, value, blockers) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
    blockers.push(`${label} is missing`);
  }
}

function summarizeFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return 'missing failure details';
  return `${failures.length} failed check${failures.length === 1 ? '' : 's'}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [preflight, local, vsix, npm] = await Promise.all([
    readJson(options.preflight, 'preflight report'),
    readJson(options.localManifest, 'local sync manifest'),
    readJson(options.vsixManifest, 'VSIX manifest'),
    readJson(options.npmManifest, 'npm manifest'),
  ]);
  const plan = buildPromotionPlan({ preflight, local, vsix, npm, localReloaded: options.localReloaded });
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const output = resolve(options.out ?? artifactDirectory('promotion', `promotion-${plan.candidate.version ?? 'unknown'}-${stamp}.json`));
  await assertOutsideCheckout(output, 'promotion plan output');
  await assertOutputReady(output, options.replace);
  await mkdir(dirname(output), { recursive: true });
  await writeAtomic(output, plan);
  console.log(JSON.stringify({ ok: plan.readyForPromotion, output, status: plan.readyForPromotion ? 'pending-authorization' : 'blocked-by-gate', blockers: plan.blockers }, null, 2));
  if (!plan.readyForPromotion) process.exitCode = 1;
}

export function parseArgs(args) {
  const input = [...args];
  if (input[0] === '--') input.shift();
  const parsed = {
    preflight: undefined,
    localManifest: undefined,
    vsixManifest: undefined,
    npmManifest: undefined,
    out: undefined,
    localReloaded: false,
    replace: false,
  };
  for (let index = 0; index < input.length; index += 1) {
    const key = input[index];
    if (key === '--local-reloaded') {
      parsed.localReloaded = true;
      continue;
    }
    if (key === '--replace') {
      parsed.replace = true;
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--preflight') parsed.preflight = value;
    else if (key === '--local-manifest') parsed.localManifest = value;
    else if (key === '--vsix-manifest') parsed.vsixManifest = value;
    else if (key === '--npm-manifest') parsed.npmManifest = value;
    else if (key === '--out') parsed.out = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  for (const [key, value] of Object.entries({
    '--preflight': parsed.preflight,
    '--local-manifest': parsed.localManifest,
    '--vsix-manifest': parsed.vsixManifest,
    '--npm-manifest': parsed.npmManifest,
  })) {
    if (value === undefined) throw new Error(`${key} is required`);
  }
  return parsed;
}

async function readJson(path, label) {
  if (path === undefined) throw new Error(`${label} path is required`);
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${path}`, { cause: error });
  }
}

async function writeAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertOutsideCheckout(path, label) {
  const resolved = resolve(path);
  const relativePath = relative(root, resolved);
  if (relativePath === '' || (!isAbsolute(relativePath) && !relativePath.startsWith('..'))) {
    throw new Error(`${label} must be outside the product checkout: ${path}`);
  }
  let cursor = resolved;
  while (true) {
    try {
      const details = await lstat(cursor);
      if (details.isSymbolicLink()) throw new Error(`${label} cannot pass through a symbolic-link ancestor: ${cursor}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function assertOutputReady(path, replace) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`promotion plan output must be a regular file: ${path}`);
    if (!replace) throw new Error(`promotion plan output already exists; pass --replace for an intentional overwrite: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
