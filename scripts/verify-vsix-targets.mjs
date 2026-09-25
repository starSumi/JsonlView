import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inspectVsixArchive, VSIX_MANIFEST_ENTRY, VSIX_PACKAGE_ENTRY } from './vsix-archive-integrity.mjs';
import { resolveExtensionTarget } from './release-targets.mjs';

const IDENTITY_ENTRIES = new Set([VSIX_MANIFEST_ENTRY, VSIX_PACKAGE_ENTRY]);

if (isMainModule()) await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [openVsx, marketplace, openVsxTarget, marketplaceTarget] = await Promise.all([
    inspectVsixArchive(options.openVsx),
    inspectVsixArchive(options.marketplace),
    resolveExtensionTarget('open-vsx'),
    resolveExtensionTarget('marketplace'),
  ]);
  const result = verifyVsixTargetEvidence({ openVsx, marketplace }, { openVsxTarget, marketplaceTarget });
  if (options.out !== undefined) {
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

/** Prove that target VSIX files differ only in their declared registry identity. */
export function verifyVsixTargetEvidence({ openVsx, marketplace }, { openVsxTarget, marketplaceTarget }) {
  const failures = [];
  validateIdentity(openVsx?.identity?.package, openVsxTarget, 'Open VSX', failures);
  validateIdentity(marketplace?.identity?.package, marketplaceTarget, 'Marketplace', failures);

  const openVersion = openVsx?.identity?.package?.version;
  const marketplaceVersion = marketplace?.identity?.package?.version;
  if (openVersion !== marketplaceVersion) failures.push('extension versions differ between target VSIX files');

  compareTargetMetadata(openVsx, marketplace, failures);
  const openFiles = comparableFileMap(openVsx?.files);
  const marketplaceFiles = comparableFileMap(marketplace?.files);
  const paths = [...new Set([...openFiles.keys(), ...marketplaceFiles.keys()])].sort();
  for (const path of paths) {
    const left = openFiles.get(path);
    const right = marketplaceFiles.get(path);
    if (left === undefined || right === undefined) {
      failures.push(`non-identity archive entry is missing from one target: ${path}`);
    } else if (left.bytes !== right.bytes || left.sha256.toLowerCase() !== right.sha256.toLowerCase()) {
      failures.push(`non-identity archive entry differs between targets: ${path}`);
    }
  }

  const evidence = {
    schemaVersion: 1,
    ok: failures.length === 0,
    failures,
    version: openVersion ?? null,
    targets: {
      openVsx: targetSummary(openVsx, openVsxTarget),
      marketplace: targetSummary(marketplace, marketplaceTarget),
    },
    sharedPayload: {
      files: paths.length,
      nativeSha256: openVsx?.native?.sha256 ?? null,
      bundleSha256: openVsx?.bundle?.sha256 ?? null,
    },
    allowedIdentityDifferences: [...IDENTITY_ENTRIES],
  };
  return { ...evidence, pairSha256: computeVsixPairSha256(evidence) };
}

/** Return the exact cross-target evidence covered by the pair fingerprint. */
export function canonicalVsixPairEvidence(value) {
  return {
    schemaVersion: value?.schemaVersion,
    ok: value?.ok,
    version: value?.version,
    targets: value?.targets,
    sharedPayload: value?.sharedPayload,
    allowedIdentityDifferences: value?.allowedIdentityDifferences,
  };
}

/** Bind both target identities and artifact digests into one stable fingerprint. */
export function computeVsixPairSha256(value) {
  return createHash('sha256')
    .update(canonicalJson(canonicalVsixPairEvidence(value)))
    .digest('hex');
}

function validateIdentity(identity, target, label, failures) {
  if (identity?.name !== target?.name) failures.push(`${label} extension name differs from the release target contract`);
  if (identity?.displayName !== target?.displayName) failures.push(`${label} display name differs from the release target contract`);
  if (identity?.publisher !== target?.publisher) failures.push(`${label} publisher differs from the release target contract`);
}

function comparableFileMap(files) {
  return new Map((Array.isArray(files) ? files : [])
    .filter((file) => !IDENTITY_ENTRIES.has(file.path))
    .map((file) => [file.path, file]));
}

function compareTargetMetadata(openVsx, marketplace, failures) {
  const openPackage = parseJsonMetadata(openVsx?.metadata?.packageJson, 'Open VSX package.json', failures);
  const marketplacePackage = parseJsonMetadata(marketplace?.metadata?.packageJson, 'Marketplace package.json', failures);
  if (openPackage !== undefined && marketplacePackage !== undefined) {
    const normalizedOpen = normalizePackage(openPackage);
    const normalizedMarketplace = normalizePackage(marketplacePackage);
    if (canonicalJson(normalizedOpen) !== canonicalJson(normalizedMarketplace)) {
      failures.push('extension/package.json differs outside allowed registry identity fields');
    }
  }
  const normalizedOpenManifest = normalizeVsixManifest(openVsx?.metadata?.vsixManifest, failures, 'Open VSX');
  const normalizedMarketplaceManifest = normalizeVsixManifest(marketplace?.metadata?.vsixManifest, failures, 'Marketplace');
  if (normalizedOpenManifest !== undefined && normalizedMarketplaceManifest !== undefined
    && normalizedOpenManifest !== normalizedMarketplaceManifest) {
    failures.push('extension.vsixmanifest differs outside allowed registry identity fields');
  }
}

function parseJsonMetadata(value, label, failures) {
  if (typeof value !== 'string') {
    failures.push(`${label} metadata is missing`);
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    failures.push(`${label} metadata is invalid JSON`);
    return undefined;
  }
}

function normalizePackage(value) {
  const clone = structuredClone(value);
  delete clone.name;
  delete clone.displayName;
  return clone;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function normalizeVsixManifest(value, failures, label) {
  if (typeof value !== 'string') {
    failures.push(`${label} extension.vsixmanifest metadata is missing`);
    return undefined;
  }
  const identityMatches = [...value.matchAll(/<Identity\b([^>]*)>/g)];
  const displayNameMatches = [...value.matchAll(/<DisplayName>[^<]*<\/DisplayName>/g)];
  if (identityMatches.length !== 1 || displayNameMatches.length !== 1) {
    failures.push(`${label} extension.vsixmanifest identity surface is ambiguous`);
    return undefined;
  }
  const normalizedIdentity = identityMatches[0][0].replace(/\sId=(?:"[^"]*"|'[^']*')/, ' Id="<registry-name>"');
  return value
    .replace(identityMatches[0][0], normalizedIdentity)
    .replace(displayNameMatches[0][0], '<DisplayName>&lt;registry-display-name&gt;</DisplayName>')
    .replace(/\r\n/g, '\n');
}

function targetSummary(archive, target) {
  return {
    key: target?.key ?? null,
    registry: target?.registry ?? null,
    extensionId: target === undefined ? null : `${target.publisher}.${target.name}`,
    name: archive?.identity?.package?.name ?? null,
    displayName: archive?.identity?.package?.displayName ?? null,
    publisher: archive?.identity?.package?.publisher ?? null,
    version: archive?.identity?.package?.version ?? null,
    sha256: archive?.artifact?.sha256 ?? null,
    preservesUpdateChain: target?.preservesUpdateChain ?? null,
  };
}

export function parseArgs(args) {
  const input = args[0] === '--' ? args.slice(1) : [...args];
  const parsed = { openVsx: undefined, marketplace: undefined, out: undefined };
  for (let index = 0; index < input.length; index += 1) {
    const key = input[index];
    const value = input[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key === '--open-vsx') parsed.openVsx = resolve(value);
    else if (key === '--marketplace') parsed.marketplace = resolve(value);
    else if (key === '--out') parsed.out = resolve(value);
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  if (parsed.openVsx === undefined || parsed.marketplace === undefined) {
    throw new Error('--open-vsx and --marketplace are required');
  }
  return parsed;
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}
