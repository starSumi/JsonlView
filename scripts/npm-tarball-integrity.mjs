import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Parser } from 'tar';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * Inspect one immutable npm tarball snapshot. The archive bytes are read once,
 * hashed, and parsed from memory so identity, inventory, and artifact digest
 * cannot describe different filesystem reads.
 */
export async function inspectNpmTarball(tarballPath) {
  const path = resolve(tarballPath);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > BigInt(MAX_ARCHIVE_BYTES)) {
    throw new Error('npm tarball is not a bounded regular file');
  }
  const archive = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (!sameStat(before, after) || BigInt(archive.byteLength) !== before.size) {
    throw new Error('npm tarball changed while reading');
  }

  const files = [];
  const seen = new Set();
  const seenFolded = new Set();
  const entryPromises = [];
  let expandedBytes = 0;
  let packageJsonBytes;
  let fatal;

  const parser = new Parser({
    strict: true,
    noResume: true,
    onReadEntry(entry) {
      if (fatal !== undefined) {
        entry.resume();
        return;
      }
      try {
        if (seen.size >= MAX_ENTRIES) throw new Error('npm tarball contains too many entries');
        const path = normalizeTarPath(entry.path, entry.type === 'Directory');
        if (path === undefined) {
          entry.resume();
          return;
        }
        const folded = path.toLowerCase();
        if (seen.has(path) || seenFolded.has(folded)) throw new Error(`npm tarball contains an ambiguous duplicate path: ${path}`);
        seen.add(path);
        seenFolded.add(folded);
        if (entry.type === 'Directory') {
          entry.resume();
          return;
        }
        if (entry.type !== 'File' && entry.type !== 'OldFile') throw new Error(`npm tarball contains unsupported entry type ${entry.type}: ${path}`);
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ENTRY_BYTES) {
          throw new Error(`npm tarball entry size is outside the release boundary: ${path}`);
        }
        expandedBytes += entry.size;
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('npm tarball expanded size exceeds the release boundary');

        const chunks = [];
        const digest = createHash('sha256');
        let bytes = 0;
        const done = new Promise((resolveEntry, rejectEntry) => {
          entry.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > entry.size || bytes > MAX_ENTRY_BYTES) {
              entry.destroy(new Error(`npm tarball entry exceeded its declared size: ${path}`));
              return;
            }
            digest.update(chunk);
            if (path === 'package.json') chunks.push(Buffer.from(chunk));
          });
          entry.on('error', rejectEntry);
          entry.on('end', () => {
            if (bytes !== entry.size) return rejectEntry(new Error(`npm tarball entry byte count differs from its header: ${path}`));
            if (path === 'package.json') {
              if (bytes > MAX_PACKAGE_JSON_BYTES) return rejectEntry(new Error('npm package.json exceeds the release boundary'));
              packageJsonBytes = Buffer.concat(chunks, bytes);
            }
            files.push({ path, bytes, sha256: digest.digest('hex') });
            resolveEntry();
          });
        });
        entryPromises.push(done);
        entry.resume();
      } catch (error) {
        fatal = error;
        entry.resume();
      }
    },
  });

  await new Promise((resolveParser, rejectParser) => {
    parser.on('error', rejectParser);
    parser.on('end', resolveParser);
    parser.end(archive);
  });
  await Promise.all(entryPromises);
  if (fatal !== undefined) throw fatal;
  if (packageJsonBytes === undefined) throw new Error('npm tarball is missing package/package.json');

  let packageJson;
  try {
    packageJson = JSON.parse(packageJsonBytes.toString('utf8'));
  } catch (error) {
    throw new Error('npm tarball package/package.json is invalid JSON', { cause: error });
  }
  files.sort((left, right) => stableCompare(left.path, right.path));
  return {
    artifact: {
      bytes: archive.byteLength,
      sha256: createHash('sha256').update(archive).digest('hex'),
    },
    expandedBytes,
    inventorySha256: npmInventoryDigest(files),
    files,
    packageJson,
  };
}

/** Compare complete npm package inventories, not just selected release files. */
export function compareNpmFileInventories(...inventories) {
  const issues = [];
  if (inventories.length === 0) return ['npm file inventory evidence is missing'];
  const normalized = inventories.map((inventory, index) => {
    if (!Array.isArray(inventory) || inventory.length === 0) {
      issues.push(`npm file inventory ${index + 1} is missing or empty`);
      return undefined;
    }
    const paths = new Set();
    const files = [];
    for (const file of inventory) {
      if (typeof file?.path !== 'string' || file.path.length === 0
        || !Number.isSafeInteger(file?.bytes) || file.bytes < 0
        || typeof file?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
        issues.push(`npm file inventory ${index + 1} contains an invalid entry`);
        return undefined;
      }
      const path = file.path.replaceAll('\\', '/');
      if (path.startsWith('/') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        issues.push(`npm file inventory ${index + 1} contains an invalid path`);
        return undefined;
      }
      if (paths.has(path.toLowerCase())) {
        issues.push(`npm file inventory ${index + 1} contains an ambiguous duplicate path`);
        return undefined;
      }
      paths.add(path.toLowerCase());
      files.push({ path, bytes: file.bytes, sha256: file.sha256.toLowerCase() });
    }
    return files.sort((left, right) => stableCompare(left.path, right.path));
  });
  const digests = normalized.filter(Boolean).map(npmInventoryDigest);
  if (new Set(digests).size > 1) issues.push('npm file inventories differ');
  return issues;
}

export function npmInventoryDigest(files) {
  const inventory = createHash('sha256');
  for (const file of [...files].sort((left, right) => stableCompare(left.path, right.path))) {
    inventory.update(`${file.path}\0${String(file.bytes)}\0${String(file.sha256).toLowerCase()}\n`);
  }
  return inventory.digest('hex');
}

function normalizeTarPath(value, directory) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    throw new Error('npm tarball contains an invalid entry path');
  }
  const path = directory ? value.replace(/\/$/, '') : value;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`npm tarball contains an absolute path: ${path}`);
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`npm tarball contains a traversal or ambiguous path: ${path}`);
  }
  if (segments[0] !== 'package') throw new Error(`npm tarball entry is outside package/: ${path}`);
  if (segments.length === 1) {
    if (directory) return undefined;
    throw new Error(`npm tarball entry is outside package/: ${path}`);
  }
  return segments.slice(1).join('/');
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
