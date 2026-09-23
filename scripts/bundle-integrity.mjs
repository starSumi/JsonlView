import { createHash } from 'node:crypto';
import { cp, lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DISTRIBUTION_FILES = ['extension.cjs', 'webview.css', 'webview.js'];
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * Inventory the exact production bundle shared by npm and VSIX candidates.
 * Extra files, source maps, links, and changing files are rejected so a
 * release manifest describes a small, immutable byte set.
 */
export async function inventoryFrozenBundle(directory) {
  const root = resolve(directory);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error('frozen dist must be a regular directory');
  }
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(stableCompare);
  if (JSON.stringify(names) !== JSON.stringify(DISTRIBUTION_FILES)) {
    throw new Error(`frozen dist must contain exactly ${DISTRIBUTION_FILES.join(', ')}`);
  }

  const files = [];
  let totalBytes = 0;
  for (const name of DISTRIBUTION_FILES) {
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`frozen dist entry is not a regular file: ${name}`);
    const path = resolve(root, name);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error(`frozen dist entry size is outside the release boundary: ${name}`);
    }
    const contents = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (!sameStat(before, after) || BigInt(contents.byteLength) !== before.size) {
      throw new Error(`frozen dist entry changed while hashing: ${name}`);
    }
    totalBytes += contents.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) throw new Error('frozen dist exceeds the release boundary');
    files.push({
      path: name,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }
  return { files, bytes: totalBytes, sha256: bundleInventoryDigest(files) };
}

export async function copyFrozenBundle(source, destination) {
  const before = await inventoryFrozenBundle(source);
  for (const file of before.files) await cp(resolve(source, file.path), resolve(destination, file.path));
  const after = await inventoryFrozenBundle(destination);
  const issues = compareBundleInventories(before, after);
  if (issues.length > 0) throw new Error(`staged dist differs from the frozen bundle: ${issues.join(', ')}`);
  return after;
}

export function compareBundleInventories(...inventories) {
  const issues = [];
  if (inventories.length === 0) return ['bundle inventory evidence is missing'];
  for (const [index, inventory] of inventories.entries()) {
    if (inventory === undefined) {
      issues.push(`bundle inventory ${index + 1} is missing`);
      continue;
    }
    if (!isSha256(inventory?.sha256)) issues.push(`bundle inventory ${index + 1} has no valid digest`);
    if (!Array.isArray(inventory?.files) || inventory.files.length !== DISTRIBUTION_FILES.length) {
      issues.push(`bundle inventory ${index + 1} has an invalid file set`);
      continue;
    }
    const files = [...inventory.files].sort((left, right) => stableCompare(left?.path, right?.path));
    if (JSON.stringify(files.map((file) => file?.path)) !== JSON.stringify([...DISTRIBUTION_FILES].sort(stableCompare))) {
      issues.push(`bundle inventory ${index + 1} has an unexpected file set`);
      continue;
    }
    if (files.some((file) => !Number.isSafeInteger(file?.bytes) || file.bytes <= 0 || !isSha256(file?.sha256))) {
      issues.push(`bundle inventory ${index + 1} has an invalid file entry`);
      continue;
    }
    if (isSha256(inventory.sha256) && bundleInventoryDigest(files) !== inventory.sha256.toLowerCase()) {
      issues.push(`bundle inventory ${index + 1} digest does not match its files`);
    }
  }
  const digests = inventories.map((value) => value?.sha256).filter(isSha256).map((value) => value.toLowerCase());
  if (new Set(digests).size > 1) issues.push('bundle inventory digests differ');
  return issues;
}

/** Build a bundle inventory from a candidate-wide file inventory. */
export function bundleFromCandidateInventory(files, prefix = 'dist/') {
  if (!Array.isArray(files)) return undefined;
  const normalizedPrefix = prefix.replaceAll('\\', '/');
  const selected = files
    .map((file) => ({ ...file, path: file?.path?.replaceAll('\\', '/') }))
    .filter((file) => typeof file.path === 'string' && file.path.startsWith(normalizedPrefix))
    .map((file) => ({ path: file.path.slice(normalizedPrefix.length), bytes: file.bytes, sha256: file.sha256 }))
    .sort((left, right) => stableCompare(left.path, right.path));
  if (JSON.stringify(selected.map((file) => file.path)) !== JSON.stringify([...DISTRIBUTION_FILES].sort(stableCompare))) {
    return undefined;
  }
  return {
    files: selected,
    bytes: selected.reduce((sum, file) => sum + (Number.isSafeInteger(file.bytes) ? file.bytes : 0), 0),
    sha256: bundleInventoryDigest(selected),
  };
}

export function bundleInventoryDigest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => stableCompare(left.path, right.path))) {
    hash.update(`${file.path}\0${String(file.bytes)}\0${String(file.sha256).toLowerCase()}\n`);
  }
  return hash.digest('hex');
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
