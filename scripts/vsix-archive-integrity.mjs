import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleInventoryDigest, DISTRIBUTION_FILES } from './bundle-integrity.mjs';
import { RELEASE_NOTICE_PREFIX, REQUIRED_RELEASE_LEGAL_FILES } from './release-legal-integrity.mjs';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

export const VSIX_CONTENT_TYPES_ENTRY = '[Content_Types].xml';
export const VSIX_MANIFEST_ENTRY = 'extension.vsixmanifest';
export const VSIX_PACKAGE_ENTRY = 'extension/package.json';
export const VSIX_NATIVE_ENTRY = 'extension/native/jsonl-core/jsonl_core.win32-x64-msvc.node';
export const VSIX_DIST_PREFIX = 'extension/dist/';
export const VSIX_LEGAL_PREFIX = 'extension/';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_NATIVE_BYTES = 64 * 1024 * 1024;
const MAX_DIST_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIST_BYTES = 64 * 1024 * 1024;
const MAX_LEGAL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_OTHER_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

const DIST_ENTRIES = new Map(DISTRIBUTION_FILES.map((name) => [`${VSIX_DIST_PREFIX}${name}`, name]));
const REQUIRED_ENTRIES = new Set([
  VSIX_CONTENT_TYPES_ENTRY,
  VSIX_MANIFEST_ENTRY,
  VSIX_PACKAGE_ENTRY,
  VSIX_NATIVE_ENTRY,
  ...REQUIRED_RELEASE_LEGAL_FILES.map((name) => `${VSIX_LEGAL_PREFIX}${name}`),
  ...DIST_ENTRIES.keys(),
]);

/**
 * Inspect a finished VSIX through one file descriptor and one central-directory
 * traversal. The returned artifact, native, and dist digests therefore refer
 * to the same stable archive snapshot.
 */
export async function inspectVsixArchive(vsixPath) {
  const path = resolve(vsixPath);
  const pathBefore = await lstat(path, { bigint: true });
  assertRegularArchive(pathBefore);

  const handle = await open(path, 'r');
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    assertRegularArchive(descriptorBefore);
    if (!sameFileStat(pathBefore, descriptorBefore)) {
      throw new Error('VSIX archive changed before inspection began');
    }
    if (descriptorBefore.size <= 0n || descriptorBefore.size > BigInt(MAX_ARCHIVE_BYTES)) {
      throw new Error('VSIX archive size is outside the release boundary');
    }

    const snapshot = await readFileHandleSnapshot(handle, Number(descriptorBefore.size));
    const artifact = {
      bytes: snapshot.byteLength,
      sha256: createHash('sha256').update(snapshot).digest('hex'),
    };
    const contents = await scanCentralDirectory(snapshot);

    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (!sameFileStat(descriptorBefore, descriptorAfter) || !sameFileStat(descriptorAfter, pathAfter)) {
      throw new Error('VSIX archive changed while it was being inspected');
    }

    return { artifact, ...contents };
  } finally {
    await handle.close();
  }
}

/** Compare both embedded identity surfaces with a root or sidecar package. */
export function compareVsixArchiveIdentity(archiveIdentity, expectedPackage, label = 'expected package') {
  const issues = [];
  if (!isRecord(expectedPackage)) return [`${label} identity is missing`];
  for (const surface of ['package', 'vsixManifest']) {
    const actual = archiveIdentity?.[surface];
    if (!isRecord(actual)) {
      issues.push(`VSIX ${surface} identity is missing`);
      continue;
    }
    const fields = surface === 'package'
      ? ['name', 'publisher', 'version', 'private', 'license', 'repository']
      : ['name', 'publisher', 'version'];
    for (const field of fields) {
      const matches = field === 'repository'
        ? sameRepositoryIdentity(actual[field], expectedPackage[field])
        : sameIdentityValue(actual[field], expectedPackage[field]);
      if (!matches) {
        issues.push(`VSIX ${surface} ${field} differs from ${label}`);
      }
    }
  }
  return issues;
}

/** Compare a recorded sidecar identity with the identity read from the archive. */
export function compareVsixArchiveIdentityEvidence(actualIdentity, expectedIdentity) {
  const issues = [];
  if (!isRecord(expectedIdentity)) return ['VSIX sidecar archive identity is missing'];
  for (const surface of ['package', 'vsixManifest']) {
    const actual = actualIdentity?.[surface];
    const expected = expectedIdentity?.[surface];
    if (!isRecord(actual) || !isRecord(expected)) {
      issues.push(`VSIX ${surface} identity evidence is missing`);
      continue;
    }
    const fields = surface === 'package'
      ? ['name', 'publisher', 'version', 'private', 'license', 'repository']
      : ['name', 'publisher', 'version'];
    for (const field of fields) {
      const matches = field === 'repository'
        ? sameRepositoryIdentity(actual[field], expected[field])
        : sameIdentityValue(actual[field], expected[field]);
      if (!matches) {
        issues.push(`VSIX ${surface} ${field} differs from the sidecar archive identity`);
      }
    }
  }
  return issues;
}

async function readFileHandleSnapshot(handle, expectedBytes) {
  const snapshot = Buffer.allocUnsafe(expectedBytes);
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(1024 * 1024, expectedBytes - position);
    const { bytesRead } = await handle.read(snapshot, position, length, position);
    if (bytesRead === 0) throw new Error('VSIX archive ended while hashing the artifact');
    position += bytesRead;
  }
  return snapshot;
}

function scanCentralDirectory(snapshot) {
  return new Promise((resolveResult, reject) => {
    yauzl.fromBuffer(snapshot, {
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error('VSIX central directory could not be opened'));
        return;
      }

      const names = new Set();
      const portableNames = new Map();
      const payloads = new Map();
      let entryCount = 0;
      let totalUncompressedBytes = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipfile.on('error', fail);
      zipfile.on('entry', (entry) => {
        if (settled) return;
        let name;
        try {
          entryCount += 1;
          if (entryCount > MAX_ENTRIES) throw new Error('VSIX contains too many central-directory entries');
          name = validateEntryName(entry.fileName);
          if (names.has(name)) throw new Error(`VSIX contains duplicate archive entry: ${name}`);
          names.add(name);
          const portableName = name.toLowerCase();
          const collision = portableNames.get(portableName);
          if (collision !== undefined) {
            throw new Error(`VSIX contains case-colliding archive entries: ${collision}, ${name}`);
          }
          portableNames.set(portableName, name);

          if (name.startsWith(VSIX_DIST_PREFIX)
            && name !== VSIX_DIST_PREFIX
            && !DIST_ENTRIES.has(name)) {
            throw new Error(`VSIX contains unexpected production bundle entry: ${name}`);
          }

          const limit = payloadLimit(name);
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            throw new Error(`VSIX entry has an invalid uncompressed size: ${name}`);
          }
          const isDirectory = name.endsWith('/');
          const entryLimit = limit ?? MAX_OTHER_ENTRY_BYTES;
          if (!isDirectory && entry.uncompressedSize > entryLimit) {
            throw new Error(`VSIX entry exceeds the uncompressed size boundary: ${name}`);
          }
          totalUncompressedBytes += entry.uncompressedSize;
          if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
            throw new Error('VSIX total uncompressed size exceeds the release boundary');
          }

          if (isDirectory) {
            zipfile.readEntry();
            return;
          }
          if (limit !== undefined && (!Number.isSafeInteger(entry.uncompressedSize)
            || entry.uncompressedSize <= 0 || entry.uncompressedSize > limit)) {
            throw new Error(`VSIX critical entry size is outside the release boundary: ${name}`);
          }
        } catch (error) {
          fail(error);
          return;
        }

        readEntry(
          zipfile,
          entry,
          payloadLimit(name) ?? MAX_OTHER_ENTRY_BYTES,
          name === VSIX_PACKAGE_ENTRY || name === VSIX_MANIFEST_ENTRY,
        )
          .then((payload) => {
            if (settled) return;
            payloads.set(name, payload);
            zipfile.readEntry();
          }, fail);
      });

      zipfile.on('end', () => {
        if (settled) return;
        try {
          const missing = [...REQUIRED_ENTRIES].filter((name) => !names.has(name));
          if (missing.length > 0) throw new Error(`VSIX is missing critical archive entries: ${missing.join(', ')}`);

          const packageIdentity = parsePackageIdentity(payloads.get(VSIX_PACKAGE_ENTRY)?.contents);
          const vsixManifestIdentity = parseVsixManifestIdentity(payloads.get(VSIX_MANIFEST_ENTRY)?.contents);
          for (const field of ['name', 'publisher', 'version']) {
            if (packageIdentity[field] !== vsixManifestIdentity[field]) {
              throw new Error(`VSIX embedded identity mismatch for ${field}`);
            }
          }

          const nativePayload = payloads.get(VSIX_NATIVE_ENTRY);
          const archiveFiles = [...payloads]
            .map(([path, payload]) => ({ path, bytes: payload.bytes, sha256: payload.sha256 }))
            .sort((left, right) => stableCompare(left.path, right.path));
          const files = [...DIST_ENTRIES].map(([entryName, path]) => {
            const payload = payloads.get(entryName);
            return { path, bytes: payload.bytes, sha256: payload.sha256 };
          });
          const bundleBytes = files.reduce((sum, file) => sum + file.bytes, 0);
          if (bundleBytes > MAX_DIST_BYTES) throw new Error('VSIX production bundle exceeds the release boundary');

          const legalFiles = [...payloads]
            .filter(([name]) => isLegalEntry(name))
            .map(([name, payload]) => ({
              path: name.slice(VSIX_LEGAL_PREFIX.length),
              bytes: payload.bytes,
              sha256: payload.sha256,
            }))
            .sort((left, right) => stableCompare(left.path, right.path));
          if (!legalFiles.some((file) => file.path.startsWith(RELEASE_NOTICE_PREFIX))) {
            throw new Error('VSIX is missing bundled third-party license texts');
          }

          const result = {
            identity: {
              package: packageIdentity,
              vsixManifest: vsixManifestIdentity,
            },
            native: {
              entry: VSIX_NATIVE_ENTRY,
              bytes: nativePayload.bytes,
              sha256: nativePayload.sha256,
            },
            bundle: {
              files,
              bytes: bundleBytes,
              sha256: bundleInventoryDigest(files),
            },
            legal: { files: legalFiles },
            files: archiveFiles,
            entries: { count: entryCount, uncompressedBytes: totalUncompressedBytes },
          };
          settled = true;
          zipfile.close();
          resolveResult(result);
        } catch (error) {
          fail(error);
        }
      });

      zipfile.readEntry();
    });
  });
}

function readEntry(zipfile, entry, limit, capture) {
  return new Promise((resolveResult, reject) => {
    zipfile.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) {
        reject(streamError ?? new Error(`VSIX critical entry could not be read: ${entry.fileName}`));
        return;
      }
      const digest = createHash('sha256');
      const chunks = capture ? [] : undefined;
      let bytes = 0;
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limit) {
          stream.destroy(new Error(`VSIX critical entry exceeded the release boundary: ${entry.fileName}`));
          return;
        }
        digest.update(chunk);
        chunks?.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => {
        if (bytes !== entry.uncompressedSize) {
          reject(new Error(`VSIX critical entry byte count differs from its central-directory record: ${entry.fileName}`));
          return;
        }
        resolveResult({
          bytes,
          sha256: digest.digest('hex'),
          ...(capture ? { contents: Buffer.concat(chunks, bytes) } : {}),
        });
      });
    });
  });
}

function validateEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error('VSIX contains an invalid empty or NUL archive path');
  }
  if (name.includes('\\')) throw new Error(`VSIX contains a backslash archive path: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) {
    throw new Error(`VSIX contains an absolute archive path: ${name}`);
  }
  const segments = name.split('/');
  const directory = segments.at(-1) === '';
  const pathSegments = directory ? segments.slice(0, -1) : segments;
  if (pathSegments.length === 0 || pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`VSIX contains an empty or traversal archive path segment: ${name}`);
  }
  return name;
}

function payloadLimit(name) {
  if (name === VSIX_CONTENT_TYPES_ENTRY || name === VSIX_PACKAGE_ENTRY || name === VSIX_MANIFEST_ENTRY) return MAX_METADATA_BYTES;
  if (name === VSIX_NATIVE_ENTRY) return MAX_NATIVE_BYTES;
  if (DIST_ENTRIES.has(name)) return MAX_DIST_FILE_BYTES;
  if (isLegalEntry(name)) return MAX_LEGAL_FILE_BYTES;
  return undefined;
}

function isLegalEntry(name) {
  if (!name.startsWith(VSIX_LEGAL_PREFIX) || name.endsWith('/')) return false;
  const relative = name.slice(VSIX_LEGAL_PREFIX.length);
  return REQUIRED_RELEASE_LEGAL_FILES.includes(relative) || relative.startsWith(RELEASE_NOTICE_PREFIX);
}

function parsePackageIdentity(contents) {
  if (!Buffer.isBuffer(contents)) throw new Error(`VSIX ${VSIX_PACKAGE_ENTRY} could not be read`);
  let value;
  try {
    value = JSON.parse(decodeUtf8(contents).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`VSIX ${VSIX_PACKAGE_ENTRY} is not valid UTF-8 JSON: ${errorMessage(error)}`);
  }
  return {
    ...validateIdentity(value, VSIX_PACKAGE_ENTRY),
    private: value.private,
    license: value.license,
    repository: value.repository,
  };
}

function parseVsixManifestIdentity(contents) {
  if (!Buffer.isBuffer(contents)) throw new Error(`VSIX ${VSIX_MANIFEST_ENTRY} could not be read`);
  const text = decodeUtf8(contents);
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(text)) throw new Error('VSIX manifest must not contain a DTD or entity declaration');
  const matches = [...text.matchAll(/<Identity\b([^>]*)>/g)];
  if (matches.length !== 1) throw new Error('VSIX manifest must contain exactly one Identity element');
  const attributes = parseXmlAttributes(matches[0][1]);
  return validateIdentity({
    name: attributes.Id,
    publisher: attributes.Publisher,
    version: attributes.Version,
  }, VSIX_MANIFEST_ENTRY);
}

function parseXmlAttributes(source) {
  const body = source.replace(/\/\s*$/, '');
  const attributes = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    if (body.slice(cursor, match.index).trim() !== '') throw new Error('VSIX manifest Identity attributes are malformed');
    if (Object.hasOwn(attributes, match[1])) throw new Error(`VSIX manifest Identity repeats attribute ${match[1]}`);
    attributes[match[1]] = match[2] ?? match[3];
    cursor = match.index + match[0].length;
  }
  if (body.slice(cursor).trim() !== '') throw new Error('VSIX manifest Identity attributes are malformed');
  return attributes;
}

function validateIdentity(value, source) {
  const identity = isRecord(value) ? value : {};
  if (typeof identity.name !== 'string' || !PACKAGE_NAME_PATTERN.test(identity.name)) {
    throw new Error(`VSIX ${source} has an invalid extension name`);
  }
  if (typeof identity.publisher !== 'string' || !PUBLISHER_PATTERN.test(identity.publisher)) {
    throw new Error(`VSIX ${source} has an invalid publisher`);
  }
  if (typeof identity.version !== 'string' || !SEMVER_PATTERN.test(identity.version)) {
    throw new Error(`VSIX ${source} has an invalid version`);
  }
  return { name: identity.name, publisher: identity.publisher, version: identity.version };
}

function decodeUtf8(contents) {
  try {
    return decoder.decode(contents);
  } catch (error) {
    throw new Error(`VSIX metadata is not valid UTF-8: ${errorMessage(error)}`);
  }
}

function assertRegularArchive(details) {
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('VSIX archive must be a regular file, not a link');
}

function sameFileStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameIdentityValue(left, right) {
  if (left === right) return true;
  if ((isRecord(left) || Array.isArray(left)) && (isRecord(right) || Array.isArray(right))) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function sameRepositoryIdentity(left, right) {
  const leftIdentity = normalizeRepositoryIdentity(left);
  const rightIdentity = normalizeRepositoryIdentity(right);
  return leftIdentity !== undefined && leftIdentity === rightIdentity;
}

function normalizeRepositoryIdentity(value) {
  const input = isRecord(value) ? value.url : value;
  if (typeof input !== 'string' || input.trim().length === 0) return undefined;
  let source = input.trim().replace(/^git\+/i, '');
  const scp = source.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) source = `https://${scp[1]}/${scp[2]}`;
  if (/^[A-Za-z0-9.-]+\/.+/.test(source)) source = `https://${source}`;
  let parsed;
  try { parsed = new URL(source); } catch { return undefined; }
  if (parsed.username || parsed.password || !['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return undefined;
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!parsed.hostname || !path) return undefined;
  return `${parsed.hostname.toLowerCase()}/${path.toLowerCase()}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
