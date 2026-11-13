import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { CatalogSnapshot } from './catalog-model';

/** The small Result contract used by this application boundary. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type CatalogPersistenceErrorCode =
  | 'serialize'
  | 'temp-create'
  | 'write'
  | 'verify'
  | 'rename'
  | 'cleanup';

export class CatalogPersistenceError extends Error {
  public readonly code: CatalogPersistenceErrorCode;
  public override readonly cause: unknown;

  public constructor(code: CatalogPersistenceErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CatalogPersistenceError';
    this.code = code;
    this.cause = cause;
  }
}

export interface PersistenceOptions {
  /** Read the bytes back from the write target before committing. */
  readonly verifyAfterWrite?: boolean;
  /** Use a same-directory temporary file and rename it into place. */
  readonly atomicWrite?: boolean;
  /** Filesystem seam for deterministic fault injection in focused tests. */
  readonly fileSystem?: CatalogPersistenceFileSystem;
}

export interface CatalogPersistenceFileSystem {
  readonly open: (path: string, flags: 'wx') => Promise<FileHandle>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
}

const nodeFileSystem: CatalogPersistenceFileSystem = {
  open: (path, flags) => fs.open(path, flags),
  writeFile: (path, contents) => fs.writeFile(path, contents, 'utf8'),
  readFile: (path) => fs.readFile(path),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  remove: (path) => fs.rm(path, { force: true }),
};

const MAX_TEMP_CREATE_ATTEMPTS = 8;
const EMPTY_RESULT: Result<void, Error> = { ok: true, value: undefined };

/**
 * Serialize snapshots with sorted object keys so equivalent snapshots have the
 * same bytes and therefore the same checksum regardless of producer key order.
 * Array order remains significant because entity and relation order is part of
 * the catalog projection contract.
 */
export function serializeCatalogSnapshot(snapshot: CatalogSnapshot): string {
  try {
    const serialized = JSON.stringify(sortJsonValue(snapshot));
    if (serialized === undefined) throw new Error('Catalog snapshot is not JSON serializable.');
    return serialized;
  } catch (error) {
    throw new CatalogPersistenceError('serialize', 'Catalog snapshot could not be serialized.', error);
  }
}

/** Return the SHA-256 digest of the canonical serialized snapshot bytes. */
export function computeCatalogChecksum(snapshot: CatalogSnapshot): string {
  return createHash('sha256').update(serializeCatalogSnapshot(snapshot), 'utf8').digest('hex');
}

/**
 * Persist a metadata-only catalog snapshot. A failed operation leaves the
 * previous target untouched when `atomicWrite` is enabled and never removes a
 * pre-existing collision file.
 */
export async function persistCatalog(
  snapshot: CatalogSnapshot,
  path: string,
  options: PersistenceOptions = {},
): Promise<Result<void, Error>> {
  const verifyAfterWrite = options.verifyAfterWrite ?? true;
  const atomicWrite = options.atomicWrite ?? true;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const serialized = serializeCatalogSnapshot(snapshot);
  const expectedChecksum = checksum(serialized);

  if (!atomicWrite) {
    let writeCompleted = false;
    try {
      await fileSystem.writeFile(path, serialized);
      writeCompleted = true;
      if (verifyAfterWrite) await verifyBytes(fileSystem, path, expectedChecksum);
      return EMPTY_RESULT;
    } catch (error) {
      return { ok: false, error: normalizePersistenceError(error, writeCompleted ? 'verify' : 'write', path) };
    }
  }

  let temporaryPath: string | undefined;
  let handle: FileHandle | undefined;
  let writeCompleted = false;
  try {
    ({ path: temporaryPath, handle } = await createTemporaryFile(fileSystem, path));
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    writeCompleted = true;

    if (verifyAfterWrite) await verifyBytes(fileSystem, temporaryPath, expectedChecksum);
    await fileSystem.rename(temporaryPath, path);
    temporaryPath = undefined;
    return EMPTY_RESULT;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const cleanupError = temporaryPath === undefined ? undefined : await removeTemporaryFile(fileSystem, temporaryPath);
    if (cleanupError !== undefined) {
      return {
        ok: false,
        error: new CatalogPersistenceError(
          'cleanup',
          `Catalog persistence failed and its temporary file could not be removed: ${temporaryPath}.`,
          { operation: error, cleanup: cleanupError },
        ),
      };
    }
    return { ok: false, error: normalizePersistenceError(error, writeCompleted ? 'rename' : 'write', path) };
  }
}

async function createTemporaryFile(fileSystem: CatalogPersistenceFileSystem, targetPath: string): Promise<{ readonly path: string; readonly handle: FileHandle }> {
  const basePath = `${targetPath}.tmp`;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TEMP_CREATE_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? basePath : `${basePath}.${randomUUID()}`;
    try {
      return { path: candidate, handle: await fileSystem.open(candidate, 'wx') };
    } catch (error) {
      lastError = error;
      if (!isErrorCode(error, 'EEXIST')) {
        throw new CatalogPersistenceError('temp-create', `Could not create catalog temporary file: ${candidate}.`, error);
      }
    }
  }
  throw new CatalogPersistenceError('temp-create', `Could not create a collision-free catalog temporary file for ${targetPath}.`, lastError);
}

async function verifyBytes(fileSystem: CatalogPersistenceFileSystem, path: string, expectedChecksum: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fileSystem.readFile(path);
  } catch (error) {
    throw new CatalogPersistenceError('verify', `Could not read the catalog write target for verification: ${path}.`, error);
  }
  const actualChecksum = checksum(bytes);
  if (actualChecksum !== expectedChecksum) {
    throw new CatalogPersistenceError('verify', `Catalog checksum mismatch after writing ${path}.`);
  }
}

async function removeTemporaryFile(fileSystem: CatalogPersistenceFileSystem, path: string): Promise<unknown | undefined> {
  try {
    await fileSystem.remove(path);
    return undefined;
  } catch (error) {
    return error;
  }
}

function checksum(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePersistenceError(error: unknown, fallbackCode: CatalogPersistenceErrorCode, path: string): Error {
  if (error instanceof CatalogPersistenceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CatalogPersistenceError(fallbackCode, `Could not persist catalog at ${path}: ${message}`, error);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJsonValue(record[key])]));
}
