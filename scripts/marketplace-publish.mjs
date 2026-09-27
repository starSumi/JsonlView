import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { publishVSIX } from '@vscode/vsce';
import { inspectVsixArchive } from './vsix-archive-integrity.mjs';
import { normalizeMarketplaceUrl, pollGalleryVersion, queryGallery } from './marketplace-gallery.mjs';

const root = resolve(import.meta.dirname, '..');
const DEFAULT_PUBLISHER = 'Sumi-Sophia';
const DEFAULT_EXTENSION_NAME = 'jsonlview-data-studio';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 10_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

if (isMainModule()) await main().catch((error) => {
  console.error(JSON.stringify({ schemaVersion: 1, ok: false, error: safeError(error) }, null, 2));
  process.exitCode = 1;
});

export function parseArgs(args) {
  const parsed = {
    mode: 'plan',
    vsix: undefined,
    provenance: undefined,
    preflight: undefined,
    publisher: process.env.JSONLVIEW_MARKETPLACE_PUBLISHER?.trim() || DEFAULT_PUBLISHER,
    extensionName: process.env.JSONLVIEW_MARKETPLACE_EXTENSION_NAME?.trim() || DEFAULT_EXTENSION_NAME,
    marketplaceUrl: process.env.VSCE_MARKETPLACE_URL?.trim() || 'https://marketplace.visualstudio.com',
    confirmTarget: undefined,
    out: undefined,
    timeoutMs: parseBoundedNumber(process.env.JSONLVIEW_MARKETPLACE_READBACK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 900_000),
    intervalMs: parseBoundedNumber(process.env.JSONLVIEW_MARKETPLACE_READBACK_INTERVAL_MS, DEFAULT_INTERVAL_MS, 1_000, 60_000),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--publish') parsed.mode = 'publish';
    else if (arg === '--vsix') parsed.vsix = nextValue(args, ++index, arg);
    else if (arg === '--provenance') parsed.provenance = nextValue(args, ++index, arg);
    else if (arg === '--preflight') parsed.preflight = nextValue(args, ++index, arg);
    else if (arg === '--publisher') parsed.publisher = nextValue(args, ++index, arg);
    else if (arg === '--extension-name') parsed.extensionName = nextValue(args, ++index, arg);
    else if (arg === '--marketplace-url') parsed.marketplaceUrl = nextValue(args, ++index, arg);
    else if (arg === '--confirm-target') parsed.confirmTarget = nextValue(args, ++index, arg);
    else if (arg === '--out') parsed.out = nextValue(args, ++index, arg);
    else if (arg === '--timeout-ms') parsed.timeoutMs = parseBoundedNumber(nextValue(args, ++index, arg), DEFAULT_TIMEOUT_MS, 5_000, 900_000);
    else if (arg === '--interval-ms') parsed.intervalMs = parseBoundedNumber(nextValue(args, ++index, arg), DEFAULT_INTERVAL_MS, 1_000, 60_000);
    else if (arg === '--pat') throw new Error('PATs must come from VSCE_PAT, never from command-line arguments');
    else if (arg === '--') continue;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (parsed.vsix === undefined) throw new Error('--vsix <exact .vsix> is required');
  if (parsed.intervalMs > parsed.timeoutMs) throw new Error('--interval-ms cannot exceed --timeout-ms');
  if (parsed.mode === 'publish' && (parsed.provenance === undefined || parsed.preflight === undefined)) {
    throw new Error('--publish requires both --provenance and --preflight');
  }
  return parsed;
}

export function buildTarget(publisher, extensionName, version) {
  return {
    publisher,
    extensionName,
    version,
    extensionId: `${publisher}.${extensionName}`,
    confirmation: `${publisher}/${extensionName}@${version}`,
  };
}

export function validateArchive(archive, target) {
  const issues = [];
  const identities = [archive?.identity?.package, archive?.identity?.vsixManifest];
  for (const [index, identity] of identities.entries()) {
    const label = index === 0 ? 'extension/package.json' : 'extension.vsixmanifest';
    for (const field of ['name', 'publisher', 'version']) {
      if (identity?.[field] !== target[field === 'name' ? 'extensionName' : field]) {
        issues.push(`${label} ${field} does not match the Marketplace target`);
      }
    }
  }
  if (!SHA256_PATTERN.test(archive?.artifact?.sha256 ?? '')) issues.push('VSIX SHA-256 is missing or malformed');
  if (!Number.isSafeInteger(archive?.artifact?.bytes) || archive.artifact.bytes <= 0) issues.push('VSIX byte count is missing or invalid');
  return issues;
}

export function validateProvenance(provenance, archive, target) {
  const issues = [];
  const artifact = provenance?.artifact ?? {};
  if (artifact.sha256?.toLowerCase() !== archive?.artifact?.sha256?.toLowerCase()) issues.push('provenance artifact SHA-256 differs from the exact VSIX');
  if (artifact.bytes !== archive?.artifact?.bytes) issues.push('provenance artifact byte count differs from the exact VSIX');
  const identity = provenance?.archiveIdentity;
  for (const source of [identity?.package, identity?.vsixManifest]) {
    for (const field of ['name', 'publisher', 'version']) {
      const expected = field === 'name' ? target.extensionName : target[field];
      if (source?.[field] !== expected) issues.push('provenance archive identity differs from the Marketplace target');
    }
  }
  if (provenance?.releaseTarget?.extensionId?.toLowerCase() !== target.extensionId.toLowerCase()) {
    issues.push('provenance release target differs from the Marketplace extension ID');
  }
  return [...new Set(issues)];
}

export function validatePreflight(preflight, archive, target) {
  const issues = [];
  if (preflight?.mode !== 'public-release') issues.push('preflight mode is not public-release');
  if (preflight?.ok !== true) issues.push('preflight is not green');
  const check = preflight?.checks?.vsixCandidate;
  if (check?.integrity !== true) issues.push('preflight did not verify the exact VSIX integrity');
  if (check?.actualSha256?.toLowerCase() !== archive?.artifact?.sha256?.toLowerCase()) issues.push('preflight VSIX SHA-256 differs from the exact VSIX');
  if (check?.actualBytes !== archive?.artifact?.bytes) issues.push('preflight VSIX byte count differs from the exact VSIX');
  if (check?.target?.extensionId?.toLowerCase() !== target.extensionId.toLowerCase()) issues.push('preflight target differs from the Marketplace extension ID');
  return [...new Set(issues)];
}

export function buildGalleryStatus(result, version) {
  return {
    extensionFound: result.extensionFound,
    versionPresent: result.versions.some((candidate) => candidate.toLowerCase() === version.toLowerCase()),
    versions: result.versions,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const marketplaceUrl = normalizeMarketplaceUrl(options.marketplaceUrl);
  const archivePath = resolve(options.vsix);
  assertExternalPath(archivePath, 'VSIX');
  const archive = await inspectVsixArchive(archivePath);
  const target = buildTarget(options.publisher, options.extensionName, archive.identity.package.version);
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    operation: options.mode,
    target,
    artifact: { file: basename(archivePath), bytes: archive.artifact.bytes, sha256: archive.artifact.sha256 },
    preconditions: { archive: validateArchive(archive, target) },
    writeAttempted: false,
    retryPolicy: 'No automatic retry after a write error; query the public gallery and review the evidence first.',
  };
  if (options.provenance !== undefined) {
    assertExternalPath(resolve(options.provenance), 'provenance');
    report.preconditions.provenance = validateProvenance(await readJson(options.provenance), archive, target);
  }
  if (options.preflight !== undefined) {
    assertExternalPath(resolve(options.preflight), 'preflight');
    report.preconditions.preflight = validatePreflight(await readJson(options.preflight), archive, target);
  }
  const issues = Object.values(report.preconditions).flat();
  if (issues.length > 0) return finish(report, 'blocked', issues, options.out);

  const before = buildGalleryStatus(await queryGallery({ marketplaceUrl, publisher: target.publisher, name: target.extensionName }), target.version);
  report.galleryBefore = before;
  if (before.versionPresent) return finish(report, 'already-present', ['The exact version already exists; public metadata cannot prove artifact digest, so no republish was attempted.'], options.out);
  if (options.mode === 'plan') return finish(report, 'ready-for-authorization', [], options.out);
  const pat = process.env.VSCE_PAT?.trim();
  if (!pat) return finish(report, 'blocked', ['VSCE_PAT is required for --publish and is never accepted as a CLI argument.'], options.out);
  if (options.confirmTarget !== target.confirmation) return finish(report, 'blocked', [`--confirm-target must exactly equal ${target.confirmation}`], options.out);

  report.writeAttempted = true;
  try {
    await publishVSIX(archivePath, { pat, skipDuplicate: false });
  } catch (error) {
    const observed = await safeQuery({ marketplaceUrl, publisher: target.publisher, name: target.extensionName, version: target.version });
    report.galleryAfterError = observed;
    const status = observed?.versionPresent ? 'published-readback' : 'ambiguous';
    return finish(report, status, [safeError(error).message], options.out);
  }
  const after = await pollGalleryVersion({ marketplaceUrl, publisher: target.publisher, name: target.extensionName, version: target.version, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs });
  report.galleryAfter = buildGalleryStatus(after, target.version);
  return finish(report, report.galleryAfter.versionPresent ? 'published-readback' : 'ambiguous', report.galleryAfter.versionPresent ? [] : ['Publish returned, but the exact version was not visible before the readback deadline.'], options.out);
}

async function finish(report, status, issues, outputPath) {
  const result = { ...report, status, ok: !['blocked', 'ambiguous'].includes(status), issues };
  if (outputPath !== undefined) {
    const path = resolve(outputPath);
    assertExternalPath(path, 'report');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function safeQuery(input) {
  try {
    return buildGalleryStatus(await queryGallery(input), input.version);
  } catch (error) {
    return { error: safeError(error) };
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read JSON evidence ${basename(path)}: ${errorMessage(error)}`);
  }
}

function assertExternalPath(path, label) {
  const relativePath = relative(root, path);
  if (relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))) {
    throw new Error(`${label} must be outside the product checkout`);
  }
}

function nextValue(args, index, option) {
  const value = args[index];
  if (value === undefined || value === '--' || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseBoundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`numeric option must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

function safeError(error) {
  return { name: error?.name || 'Error', message: errorMessage(error), ...(error?.status === undefined ? {} : { status: error.status }) };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}
