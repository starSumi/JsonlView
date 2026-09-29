import { basename, dirname, resolve } from 'node:path';
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { publishVSIX } from '@vscode/vsce';
import { inspectVsixArchive } from './vsix-archive-integrity.mjs';
import { normalizeMarketplaceUrl, pollGalleryVersion, queryGallery } from './marketplace-gallery.mjs';
import { getExtensionTarget } from './release-targets.mjs';
import { assertOutsideTree, assertPathsDoNotOverlap } from './path-boundary.mjs';

const root = resolve(import.meta.dirname, '..');
const MARKETPLACE_TARGET = getExtensionTarget('marketplace');
const OFFICIAL_MARKETPLACE_URL = 'https://marketplace.visualstudio.com';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 10_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

if (isMainModule()) await main().catch((error) => {
  console.error(JSON.stringify({ schemaVersion: 1, ok: false, error: safeError(error) }, null, 2));
  process.exitCode = 1;
});

export function parseArgs(args) {
  if (process.env.JSONLVIEW_MARKETPLACE_PUBLISHER?.trim() && process.env.JSONLVIEW_MARKETPLACE_PUBLISHER.trim() !== MARKETPLACE_TARGET.publisher) {
    throw new Error('JSONLVIEW_MARKETPLACE_PUBLISHER cannot override the pinned Marketplace identity');
  }
  if (process.env.JSONLVIEW_MARKETPLACE_EXTENSION_NAME?.trim() && process.env.JSONLVIEW_MARKETPLACE_EXTENSION_NAME.trim() !== MARKETPLACE_TARGET.name) {
    throw new Error('JSONLVIEW_MARKETPLACE_EXTENSION_NAME cannot override the pinned Marketplace identity');
  }
  const parsed = {
    mode: 'plan',
    vsix: undefined,
    provenance: undefined,
    preflight: undefined,
    publisher: MARKETPLACE_TARGET.publisher,
    extensionName: MARKETPLACE_TARGET.name,
    marketplaceUrl: process.env.VSCE_MARKETPLACE_URL?.trim() || OFFICIAL_MARKETPLACE_URL,
    confirmTarget: undefined,
    out: undefined,
    timeoutMs: parseBoundedNumber(process.env.JSONLVIEW_MARKETPLACE_READBACK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 900_000),
    intervalMs: parseBoundedNumber(process.env.JSONLVIEW_MARKETPLACE_READBACK_INTERVAL_MS, DEFAULT_INTERVAL_MS, 1_000, 60_000),
  };
  const options = args[0] === '--' ? args.slice(1) : args;
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index];
    if (arg === '--publish') parsed.mode = 'publish';
    else if (arg === '--vsix') parsed.vsix = nextValue(options, ++index, arg);
    else if (arg === '--provenance') parsed.provenance = nextValue(options, ++index, arg);
    else if (arg === '--preflight') parsed.preflight = nextValue(options, ++index, arg);
    else if (arg === '--publisher' || arg === '--extension-name') throw new Error('Marketplace identity is pinned in config/release-targets.json and cannot be overridden');
    else if (arg === '--marketplace-url') parsed.marketplaceUrl = nextValue(options, ++index, arg);
    else if (arg === '--confirm-target') parsed.confirmTarget = nextValue(options, ++index, arg);
    else if (arg === '--out') parsed.out = nextValue(options, ++index, arg);
    else if (arg === '--timeout-ms') parsed.timeoutMs = parseBoundedNumber(nextValue(options, ++index, arg), DEFAULT_TIMEOUT_MS, 5_000, 900_000);
    else if (arg === '--interval-ms') parsed.intervalMs = parseBoundedNumber(nextValue(options, ++index, arg), DEFAULT_INTERVAL_MS, 1_000, 60_000);
    else if (arg === '--pat') throw new Error('PATs must come from VSCE_PAT, never from command-line arguments');
    else if (arg === '--') throw new Error('Unexpected argument separator');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (parsed.vsix === undefined) throw new Error('--vsix <exact .vsix> is required');
  if (parsed.intervalMs > parsed.timeoutMs) throw new Error('--interval-ms cannot exceed --timeout-ms');
  if (parsed.mode === 'publish' && (parsed.provenance === undefined || parsed.preflight === undefined)) {
    throw new Error('--publish requires both --provenance and --preflight');
  }
  if (parsed.mode === 'publish' && parsed.out === undefined) {
    throw new Error('--publish requires --out <new external report path>');
  }
  if (parsed.mode === 'publish' && normalizeMarketplaceUrl(parsed.marketplaceUrl) !== OFFICIAL_MARKETPLACE_URL) {
    throw new Error('Marketplace publication readback requires the official Marketplace URL');
  }
  if (parsed.mode === 'publish' && process.env.VSCE_MARKETPLACE_URL !== undefined
    && normalizeMarketplaceUrl(process.env.VSCE_MARKETPLACE_URL) !== OFFICIAL_MARKETPLACE_URL) {
    throw new Error('VSCE_MARKETPLACE_URL must point to the official Marketplace before publication');
  }
  return parsed;
}

export function planReady(options) {
  return options.provenance !== undefined && options.preflight !== undefined
    && normalizeMarketplaceUrl(options.marketplaceUrl) === OFFICIAL_MARKETPLACE_URL;
}

export function galleryReadbackStatus(versionPresent) {
  return versionPresent ? 'version-visible-unverified' : 'ambiguous';
}

export async function postPublishReadback(report, options, poll = pollGalleryVersion) {
  try {
    const after = await poll({
      marketplaceUrl: options.marketplaceUrl,
      publisher: report.target.publisher,
      name: report.target.extensionName,
      version: report.target.version,
      timeoutMs: options.timeoutMs,
      intervalMs: options.intervalMs,
    });
    report.galleryAfter = buildGalleryStatus(after, report.target.version);
    return {
      status: galleryReadbackStatus(report.galleryAfter.versionPresent),
      issues: report.galleryAfter.versionPresent
        ? ['Public version visibility does not verify the uploaded artifact digest. Download and compare the registry artifact before confirming publication.']
        : ['Publish returned, but the exact version was not visible before the readback deadline.'],
    };
  } catch (error) {
    report.galleryReadbackError = safeError(error);
    return {
      status: 'ambiguous',
      issues: ['Publish returned, but Gallery readback failed. Do not retry without inspecting the public Gallery and exact artifact.'],
    };
  }
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
  if (target?.publisher !== MARKETPLACE_TARGET.publisher || target?.extensionName !== MARKETPLACE_TARGET.name || target?.extensionId !== MARKETPLACE_TARGET.publisher + '.' + MARKETPLACE_TARGET.name) {
    issues.push('Marketplace target differs from pinned release identity');
  }
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
  const reportInputs = [archivePath,
    ...(options.provenance === undefined ? [] : [resolve(options.provenance)]),
    ...(options.preflight === undefined ? [] : [resolve(options.preflight)])];
  if (options.out !== undefined) await assertReportOutput(options.out, reportInputs);
  await assertOutsideTree(root, archivePath, 'VSIX');
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
  let reservedReport;
  const finishReport = (status, issues) => finish(report, status, issues, options.out, reportInputs, reservedReport);
  if (options.provenance !== undefined) {
    await assertOutsideTree(root, resolve(options.provenance), 'provenance');
    report.preconditions.provenance = validateProvenance(await readJson(options.provenance), archive, target);
  }
  if (options.preflight !== undefined) {
    await assertOutsideTree(root, resolve(options.preflight), 'preflight');
    report.preconditions.preflight = validatePreflight(await readJson(options.preflight), archive, target);
  }
  const issues = Object.values(report.preconditions).flat();
  if (issues.length > 0) return finishReport('blocked', issues);

  if (options.mode === 'plan' && !planReady(options)) {
    return finishReport('diagnostic', ['A release-ready plan requires the official Marketplace URL, provenance, and preflight evidence.']);
  }

  const before = buildGalleryStatus(await queryGallery({ marketplaceUrl, publisher: target.publisher, name: target.extensionName }), target.version);
  report.galleryBefore = before;
  if (before.versionPresent) return finishReport('already-present', ['The exact version already exists; public metadata cannot prove artifact digest, so no republish was attempted.']);
  if (options.mode === 'plan') return finishReport('ready-for-authorization', []);
  const pat = process.env.VSCE_PAT?.trim();
  if (!pat) return finishReport('blocked', ['VSCE_PAT is required for --publish and is never accepted as a CLI argument.']);
  if (options.confirmTarget !== target.confirmation) return finishReport('blocked', [`--confirm-target must exactly equal ${target.confirmation}`]);

  let publishOutcome;
  try {
    publishOutcome = await publishWithReservation(archivePath, pat, options.out, reportInputs, report);
    reservedReport = publishOutcome.reportHandle;
  } catch (error) {
    report.reportReservationError = safeError(error);
    return finish(report, 'blocked', ['Report could not be reserved before publication; no upload was attempted.'], undefined);
  }
  if (publishOutcome.error !== undefined) {
    const observed = await safeQuery({ marketplaceUrl, publisher: target.publisher, name: target.extensionName, version: target.version });
    report.galleryAfterError = observed;
    const status = galleryReadbackStatus(observed?.versionPresent);
    return finishReport(status, [safeError(publishOutcome.error).message, ...(observed?.versionPresent ? ['Public version visibility does not verify the uploaded artifact digest.'] : [])]);
  }
  report.writeReturned = true;
  const readback = await postPublishReadback(report, { ...options, marketplaceUrl });
  return finishReport(readback.status, readback.issues);
}

export async function assertReportOutput(outputPath, inputPaths = []) {
  const path = await assertOutsideTree(root, resolve(outputPath), 'report');
  for (const inputPath of inputPaths) {
    assertPathsDoNotOverlap(path, resolve(inputPath), 'Report output cannot overlap VSIX, provenance, or preflight input');
  }
  return path;
}

export async function reservePublishReport(outputPath, inputPaths, report) {
  const path = await assertReportOutput(outputPath, inputPaths);
  await mkdir(dirname(path), { recursive: true });
  await assertReportOutput(path, inputPaths);
  const handle = await open(path, 'wx');
  try {
    await writeReservedReport(handle, {
      ...report,
      status: 'write-outcome-unknown',
      ok: false,
      writeAttempted: true,
      issues: ['An upload may have started. Inspect the public Gallery before any retry.'],
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function publishWithReservation(archivePath, pat, outputPath, inputPaths, report, publish = publishVSIX) {
  const reportHandle = await reservePublishReport(outputPath, inputPaths, report);
  report.writeAttempted = true;
  try {
    await publish(archivePath, { pat, skipDuplicate: false });
    return { reportHandle };
  } catch (error) {
    return { reportHandle, error };
  }
}

export async function finish(report, status, issues, outputPath, inputPaths = [], reservedReport) {
  const result = { ...report, status, ok: status === 'ready-for-authorization', issues };
  if (outputPath !== undefined) {
    try {
      if (reservedReport !== undefined) {
        try {
          await writeReservedReport(reservedReport, result);
        } finally {
          await reservedReport.close();
        }
      } else {
        const path = await assertReportOutput(outputPath, inputPaths);
        await mkdir(dirname(path), { recursive: true });
        await assertReportOutput(path, inputPaths);
        await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      }
    } catch (error) {
      result.reportWriteError = safeError(error);
      result.ok = false;
      result.issues = [...result.issues, 'Report could not be saved; retain this terminal output and do not retry a write.'];
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}

async function writeReservedReport(handle, report) {
  const contents = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  let written = 0;
  while (written < contents.length) {
    const result = await handle.write(contents, written, contents.length - written, written);
    if (result.bytesWritten === 0) throw new Error('Report write made no progress');
    written += result.bytesWritten;
  }
  await handle.truncate(contents.length);
  await handle.sync();
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
