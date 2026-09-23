import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const REQUIRED_RELEASE_LEGAL_FILES = ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'];
export const RELEASE_NOTICE_PREFIX = 'third_party/licenses/';

/** Inventory the exact legal payload that every public archive must ship. */
export async function inventorySourceLegalFiles(sourceRoot) {
  const root = resolve(sourceRoot);
  const paths = [...REQUIRED_RELEASE_LEGAL_FILES];
  await collectNoticePaths(resolve(root, 'third_party/licenses'), 'third_party/licenses', paths);
  const files = [];
  for (const path of paths.sort(stableCompare)) {
    const absolute = resolve(root, path);
    const before = await lstat(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n) {
      throw new Error(`release legal input must be a non-empty regular file: ${path}`);
    }
    const contents = await readFile(absolute);
    const after = await lstat(absolute, { bigint: true });
    if (!sameFileStat(before, after) || BigInt(contents.byteLength) !== before.size) {
      throw new Error(`release legal input changed while hashing: ${path}`);
    }
    files.push({
      path: path.replaceAll('\\', '/'),
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }
  if (!files.some((file) => file.path.startsWith(RELEASE_NOTICE_PREFIX))) {
    throw new Error('release legal payload has no bundled third-party license texts');
  }
  return files;
}

/** Select and normalize legal files from an npm or VSIX-wide inventory. */
export function selectReleaseLegalInventory(files, prefix = '') {
  if (!Array.isArray(files)) return [];
  const normalizedPrefix = prefix.replaceAll('\\', '/');
  return files
    .map((file) => ({ ...file, path: typeof file?.path === 'string' ? file.path.replaceAll('\\', '/') : undefined }))
    .filter((file) => typeof file.path === 'string' && file.path.startsWith(normalizedPrefix))
    .map((file) => ({ ...file, path: file.path.slice(normalizedPrefix.length) }))
    .filter((file) => REQUIRED_RELEASE_LEGAL_FILES.includes(file.path) || file.path.startsWith(RELEASE_NOTICE_PREFIX))
    .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    .sort((left, right) => stableCompare(left.path, right.path));
}

/** Require the candidate to contain exactly the reviewed legal payload bytes. */
export function compareReleaseLegalInventories(expected, actual, label = 'candidate') {
  const issues = [];
  const normalizedExpected = normalizeInventory(expected, 'source legal inventory', issues);
  const normalizedActual = normalizeInventory(actual, `${label} legal inventory`, issues);
  if (normalizedExpected === undefined || normalizedActual === undefined) return issues;

  for (const required of REQUIRED_RELEASE_LEGAL_FILES) {
    if (!normalizedActual.some((file) => file.path === required)) issues.push(`${label} is missing ${required}`);
  }
  if (!normalizedActual.some((file) => file.path.startsWith(RELEASE_NOTICE_PREFIX))) {
    issues.push(`${label} has no bundled third-party license texts`);
  }

  const expectedByPath = new Map(normalizedExpected.map((file) => [file.path, file]));
  const actualByPath = new Map(normalizedActual.map((file) => [file.path, file]));
  for (const [path, expectedFile] of expectedByPath) {
    const actualFile = actualByPath.get(path);
    if (actualFile === undefined) {
      issues.push(`${label} is missing reviewed legal file ${path}`);
    } else if (actualFile.bytes !== expectedFile.bytes || actualFile.sha256 !== expectedFile.sha256) {
      issues.push(`${label} legal file differs from source: ${path}`);
    }
  }
  for (const path of actualByPath.keys()) {
    if (!expectedByPath.has(path)) issues.push(`${label} contains an unreviewed legal file: ${path}`);
  }
  return issues;
}

async function collectNoticePaths(directory, relativeDirectory, output) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('third_party/licenses must be a regular directory');
  }
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => stableCompare(left.name, right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`release legal input must not be a symlink: ${relativeDirectory}/${entry.name}`);
    const childRelative = `${relativeDirectory}/${entry.name}`;
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectNoticePaths(child, childRelative, output);
    else if (entry.isFile()) output.push(childRelative);
    else throw new Error(`release legal input has an unsupported file type: ${childRelative}`);
  }
}

function normalizeInventory(files, label, issues) {
  if (!Array.isArray(files) || files.length === 0) {
    issues.push(`${label} is missing or empty`);
    return undefined;
  }
  const paths = new Set();
  const result = [];
  for (const file of files) {
    const path = typeof file?.path === 'string' ? file.path.replaceAll('\\', '/') : undefined;
    if (path === undefined || path.length === 0 || path.startsWith('/')
      || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
      || !Number.isSafeInteger(file?.bytes) || file.bytes <= 0
      || typeof file?.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(file.sha256)) {
      issues.push(`${label} contains an invalid entry`);
      return undefined;
    }
    const portablePath = path.toLowerCase();
    if (paths.has(portablePath)) {
      issues.push(`${label} contains an ambiguous duplicate path`);
      return undefined;
    }
    paths.add(portablePath);
    result.push({ path, bytes: file.bytes, sha256: file.sha256.toLowerCase() });
  }
  return result.sort((left, right) => stableCompare(left.path, right.path));
}

function sameFileStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
