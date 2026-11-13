/** Verified, byte-preserving export of one currently authorized JSONL source. */

import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const RAW_JSONL_EXPORT_RECEIPT_SCHEMA = 'jsonlview.raw-jsonl-export-receipt.v1' as const;
export const RAW_JSONL_EXPORT_MAX_BYTES = 1n * 1024n * 1024n * 1024n;
export const RAW_JSONL_EXPORT_CHUNK_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 256;

export interface RawJsonlSourceSnapshot {
  readonly sourceId: string;
  readonly documentId: string;
  readonly generation: string;
  readonly authorizationEpoch: string;
  readonly byteLength: string;
  readonly sha256: string;
}

export interface RawJsonlAuthorizedSource {
  readonly authorization: 'authorized';
  readonly sourcePath: string;
  readonly snapshot: RawJsonlSourceSnapshot;
}

export interface RawJsonlExportRequest {
  /** The immutable Host snapshot that the user authorized for this export. */
  readonly source: RawJsonlSourceSnapshot;
  /** Destination selected by the user; never replaced if it already exists. */
  readonly destinationPath: string;
  /** Optional tighter per-call byte budget. It cannot raise the hard ceiling. */
  readonly maxBytes?: bigint;
  readonly signal?: AbortSignal;
}

export interface RawJsonlExportReceiptV1 {
  readonly schema: typeof RAW_JSONL_EXPORT_RECEIPT_SCHEMA;
  readonly version: 1;
  readonly sourceId: string;
  readonly documentId: string;
  readonly generation: string;
  readonly authorizationEpoch: string;
  readonly byteLength: string;
  readonly sha256: string;
  readonly destinationPath: string;
  readonly verification: 'source-and-temp-sha256';
  readonly commit: 'same-directory-hard-link-no-replace';
}

export type RawJsonlExportResult =
  | { readonly status: 'committed'; readonly receipt: RawJsonlExportReceiptV1 }
  | {
    readonly status: 'commit-unknown';
    readonly sourceId: string;
    readonly generation: string;
    readonly byteLength: string;
    readonly sha256: string;
    readonly destinationPath: string;
  };

export type RawJsonlExportErrorCode =
  | 'invalid-request'
  | 'source-not-authorized'
  | 'source-changed'
  | 'source-unavailable'
  | 'source-too-large'
  | 'destination-invalid'
  | 'destination-exists'
  | 'temporary-create-failed'
  | 'filesystem-unsupported'
  | 'source-read-failed'
  | 'write-failed'
  | 'verification-failed'
  | 'cancelled'
  | 'commit-failed';

export class RawJsonlExportError extends Error {
  public readonly code: RawJsonlExportErrorCode;

  public constructor(code: RawJsonlExportErrorCode) {
    super(errorMessage(code));
    this.name = 'RawJsonlExportError';
    this.code = code;
  }
}

export interface RawJsonlExportFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface RawJsonlExportFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;
  stat(): Promise<RawJsonlExportFileIdentity>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Injectable OS boundary for race and fault tests. Paths are canonical local paths. */
export interface RawJsonlExportFileSystem {
  open(path: string, flags: 'r' | 'wx', mode?: number): Promise<RawJsonlExportFileHandle>;
  lstat(path: string): Promise<RawJsonlExportFileIdentity>;
  realpath(path: string): Promise<string>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface RawJsonlExportDependencies {
  /** Reauthorizes the source and resolves its current Host-owned file snapshot. */
  readonly authorizeAndResolveSource: (sourceId: string) => Promise<RawJsonlAuthorizedSource | undefined>;
  readonly fileSystem?: RawJsonlExportFileSystem;
  /** Injected only for deterministic temporary-name tests. Must be unique and opaque. */
  readonly createTemporaryId?: () => string;
  /** Durable scoped-operation intent, persisted before publication can start. */
  readonly onPrepared?: (prepared: RawJsonlPreparedCommit) => Promise<void>;
  /** The journal owner releases this file only after settling its durable receipt. */
  readonly retainPreparedTemporary?: boolean;
}

export interface RawJsonlPreparedCommit {
  readonly temporaryPath: string;
  readonly destinationPath: string;
  readonly identity: RawJsonlExportFileIdentity;
  readonly byteLength: string;
  readonly sha256: string;
}

/**
 * Copies bytes verbatim into an owned sibling temporary file, verifies both
 * source and temporary SHA-256, reauthorizes the source immediately before
 * commit, then publishes with a same-directory hard link. There is deliberately
 * no rename/copy fallback: rename overwrites, and Node documents no atomicity
 * guarantee for copyFile. If the filesystem does not support hard links, the
 * export fails closed. Node v24 documents fs.link as creating a link using POSIX
 * link(2) semantics; destination conflicts therefore remain no-replace.
 */
export async function exportRawJsonl(
  request: RawJsonlExportRequest,
  dependencies: RawJsonlExportDependencies,
): Promise<RawJsonlExportResult> {
  const sourceSnapshot = validateRequest(request, dependencies);
  throwIfCancelled(request.signal);
  const fileSystem = dependencies.fileSystem ?? nodeRawJsonlExportFileSystem;
  const makeTemporaryId = dependencies.createTemporaryId ?? randomUUID;
  const budget = request.maxBytes === undefined
    ? RAW_JSONL_EXPORT_MAX_BYTES
    : request.maxBytes > RAW_JSONL_EXPORT_MAX_BYTES ? RAW_JSONL_EXPORT_MAX_BYTES : request.maxBytes;
  if (budget < 0n || BigInt(sourceSnapshot.byteLength) > budget) throw new RawJsonlExportError('source-too-large');

  const destination = await resolveDestination(fileSystem, request.destinationPath);
  const firstAuthorization = await reauthorize(dependencies, sourceSnapshot);
  const firstSourcePath = await resolveCurrentSourcePath(fileSystem, firstAuthorization, sourceSnapshot);

  let sourceHandle: RawJsonlExportFileHandle | undefined;
  let temporaryHandle: RawJsonlExportFileHandle | undefined;
  let temporaryPath: string | undefined;
  let temporaryIdentity: RawJsonlExportFileIdentity | undefined;
  let temporaryCreated = false;
  let retainTemporary = false;
  let sourceIdentity: RawJsonlExportFileIdentity | undefined;
  const sourceDigest = createHash('sha256');
  let copiedBytes = 0n;
  const expectedDigest = sourceSnapshot.sha256.slice('sha256:'.length);
  const expectedBytes = BigInt(sourceSnapshot.byteLength);

  try {
    sourceHandle = await fileSystem.open(firstSourcePath, 'r');
    sourceIdentity = await sourceHandle.stat();
    assertRegularFile(sourceIdentity, 'source-unavailable');
    if (sourceIdentity.size !== sourceSnapshot.byteLength) throw new RawJsonlExportError('source-changed');

    temporaryPath = join(destination.directory, `.jsonlview-export-${makeTemporaryId()}.tmp`);
    try {
      temporaryHandle = await fileSystem.open(temporaryPath, 'wx', 0o600);
      temporaryCreated = true;
      temporaryIdentity = await temporaryHandle.stat();
      assertRegularFile(temporaryIdentity, 'temporary-create-failed');
      if (!hasFileIdentity(temporaryIdentity)) throw new RawJsonlExportError('filesystem-unsupported');
    } catch (error) {
      if (error instanceof RawJsonlExportError) throw error;
      if (isFileSystemError(error, 'EEXIST')) throw new RawJsonlExportError('temporary-create-failed');
      throw new RawJsonlExportError('temporary-create-failed');
    }

    const buffer = new Uint8Array(RAW_JSONL_EXPORT_CHUNK_BYTES);
    let sourcePosition = 0;
    while (true) {
      throwIfCancelled(request.signal);
      let bytesRead: number;
      try {
        const remaining = Number(expectedBytes - copiedBytes);
        bytesRead = await sourceHandle.read(buffer, 0, Math.min(buffer.byteLength, remaining + 1), sourcePosition);
      } catch {
        throw new RawJsonlExportError('source-read-failed');
      }
      if (bytesRead === 0) break;
      copiedBytes += BigInt(bytesRead);
      if (copiedBytes > expectedBytes) throw new RawJsonlExportError('source-changed');
      if (copiedBytes > budget || copiedBytes > RAW_JSONL_EXPORT_MAX_BYTES) throw new RawJsonlExportError('source-too-large');
      const chunk = buffer.subarray(0, bytesRead);
      sourceDigest.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        let bytesWritten: number;
        try {
          bytesWritten = await temporaryHandle!.write(chunk, written, bytesRead - written, Number(copiedBytes - BigInt(bytesRead)) + written);
        } catch {
          throw new RawJsonlExportError('write-failed');
        }
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytesRead - written) throw new RawJsonlExportError('write-failed');
        written += bytesWritten;
      }
      sourcePosition += bytesRead;
    }
    const copiedSha256 = sourceDigest.digest('hex');
    if (copiedBytes.toString() !== sourceSnapshot.byteLength || copiedSha256 !== expectedDigest) {
      throw new RawJsonlExportError('source-changed');
    }
    await temporaryHandle!.sync();
    await temporaryHandle!.close();
    temporaryHandle = undefined;

    const temporaryVerification = await verifyFile(fileSystem, temporaryPath, temporaryIdentity, copiedBytes, request.signal);
    if (temporaryVerification.byteLength !== copiedBytes || temporaryVerification.sha256 !== copiedSha256) {
      throw new RawJsonlExportError('verification-failed');
    }

    const finalSourceIdentity = await sourceHandle.stat();
    if (!sameFileVersion(sourceIdentity, finalSourceIdentity)) throw new RawJsonlExportError('source-changed');
    const finalAuthorization = await reauthorize(dependencies, sourceSnapshot);
    const finalSourcePath = await resolveCurrentSourcePath(fileSystem, finalAuthorization, sourceSnapshot);
    if (finalSourcePath !== firstSourcePath) throw new RawJsonlExportError('source-changed');
    if (!sameFileVersion(sourceIdentity, await fileSystem.lstat(finalSourcePath))) throw new RawJsonlExportError('source-changed');

    await sourceHandle.close();
    sourceHandle = undefined;
    throwIfCancelled(request.signal);
    if (dependencies.onPrepared !== undefined) {
      const preparedIdentity = await fileSystem.lstat(temporaryPath);
      if (!sameFileIdentity(preparedIdentity, temporaryIdentity) || preparedIdentity.size !== copiedBytes.toString()) {
        throw new RawJsonlExportError('verification-failed');
      }
      retainTemporary = dependencies.retainPreparedTemporary === true;
      await dependencies.onPrepared(Object.freeze({ temporaryPath, destinationPath: destination.path,
        identity: Object.freeze({ ...preparedIdentity }), byteLength: copiedBytes.toString(), sha256: `sha256:${copiedSha256}` }));
      throwIfCancelled(request.signal);
      const commitAuthorization = await reauthorize(dependencies, sourceSnapshot);
      if (await resolveCurrentSourcePath(fileSystem, commitAuthorization, sourceSnapshot) !== firstSourcePath
        || !sameFileVersion(sourceIdentity, await fileSystem.lstat(firstSourcePath))) throw new RawJsonlExportError('source-changed');
      throwIfCancelled(request.signal);
    }
    try {
      await fileSystem.link(temporaryPath, destination.path);
    } catch (error) {
      if (isFileSystemError(error, 'EEXIST')) throw new RawJsonlExportError('destination-exists');
      const commitProbe = await proveDestination(fileSystem, destination.path, temporaryIdentity, copiedBytes, copiedSha256);
      if (commitProbe === 'owned-and-verified') return committedReceipt(sourceSnapshot, destination.path, copiedBytes, copiedSha256);
      if (commitProbe === 'absent') throw new RawJsonlExportError('filesystem-unsupported');
      return Object.freeze({
        status: 'commit-unknown',
        sourceId: sourceSnapshot.sourceId,
        generation: sourceSnapshot.generation,
        byteLength: copiedBytes.toString(),
        sha256: `sha256:${copiedSha256}`,
        destinationPath: destination.path,
      });
    }

    const committed = await proveDestination(fileSystem, destination.path, temporaryIdentity, copiedBytes, copiedSha256);
    if (committed !== 'owned-and-verified') {
      return Object.freeze({
        status: 'commit-unknown',
        sourceId: sourceSnapshot.sourceId,
        generation: sourceSnapshot.generation,
        byteLength: copiedBytes.toString(),
        sha256: `sha256:${copiedSha256}`,
        destinationPath: destination.path,
      });
    }
    return committedReceipt(sourceSnapshot, destination.path, copiedBytes, copiedSha256);
  } catch (error) {
    if (error instanceof RawJsonlExportError) throw error;
    throw new RawJsonlExportError('write-failed');
  } finally {
    await closeQuietly(temporaryHandle);
    await closeQuietly(sourceHandle);
    if (!retainTemporary && temporaryCreated && temporaryPath !== undefined && temporaryIdentity !== undefined) {
      await removeOwnedTemporary(fileSystem, temporaryPath, temporaryIdentity);
    }
  }
}

function validateRequest(request: RawJsonlExportRequest, dependencies: RawJsonlExportDependencies): RawJsonlSourceSnapshot {
  if (!isRecord(request) || !isRecord(request.source) || typeof request.destinationPath !== 'string'
    || request.destinationPath.trim().length === 0 || typeof dependencies?.authorizeAndResolveSource !== 'function'
    || (request.maxBytes !== undefined && typeof request.maxBytes !== 'bigint')) {
    throw new RawJsonlExportError('invalid-request');
  }
  const source = request.source;
  if (!boundedId(source.sourceId) || !boundedId(source.documentId) || !boundedId(source.generation)
    || !isDecimal(source.authorizationEpoch) || !isDecimal(source.byteLength)
    || typeof source.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(source.sha256)) {
    throw new RawJsonlExportError('invalid-request');
  }
  return Object.freeze({
    sourceId: source.sourceId,
    documentId: source.documentId,
    generation: source.generation,
    authorizationEpoch: source.authorizationEpoch,
    byteLength: source.byteLength,
    sha256: source.sha256,
  });
}

async function reauthorize(
  dependencies: RawJsonlExportDependencies,
  expected: RawJsonlSourceSnapshot,
): Promise<RawJsonlAuthorizedSource> {
  let current: RawJsonlAuthorizedSource | undefined;
  try {
    current = await dependencies.authorizeAndResolveSource(expected.sourceId);
  } catch {
    throw new RawJsonlExportError('source-not-authorized');
  }
  if (current === undefined || current.authorization !== 'authorized') throw new RawJsonlExportError('source-not-authorized');
  if (!sameSnapshot(current.snapshot, expected)) throw new RawJsonlExportError('source-changed');
  if (typeof current.sourcePath !== 'string' || current.sourcePath.length === 0) throw new RawJsonlExportError('source-unavailable');
  return current;
}

async function resolveCurrentSourcePath(
  fileSystem: RawJsonlExportFileSystem,
  source: RawJsonlAuthorizedSource,
  expected: RawJsonlSourceSnapshot,
): Promise<string> {
  if (!sameSnapshot(source.snapshot, expected)) throw new RawJsonlExportError('source-changed');
  let path: string;
  try {
    path = await fileSystem.realpath(source.sourcePath);
  } catch {
    throw new RawJsonlExportError('source-unavailable');
  }
  return path;
}

async function resolveDestination(
  fileSystem: RawJsonlExportFileSystem,
  requestedPath: string,
): Promise<{ readonly directory: string; readonly path: string }> {
  let absolute: string;
  try {
    absolute = resolve(requestedPath);
    const directory = await fileSystem.realpath(dirname(absolute));
    const name = basename(absolute);
    if (name.length === 0 || name === '.' || name === '..') throw new Error('Invalid destination filename.');
    return { directory, path: join(directory, name) };
  } catch {
    throw new RawJsonlExportError('destination-invalid');
  }
}

async function verifyFile(
  fileSystem: RawJsonlExportFileSystem,
  path: string,
  expectedIdentity: RawJsonlExportFileIdentity,
  expectedBytes: bigint,
  signal?: AbortSignal,
): Promise<{ readonly byteLength: bigint; readonly sha256: string }> {
  let handle: RawJsonlExportFileHandle;
  try {
    handle = await fileSystem.open(path, 'r');
  } catch {
    throw new RawJsonlExportError('verification-failed');
  }
  try {
    const identity = await handle.stat();
    assertRegularFile(identity, 'verification-failed');
    if (!sameFileIdentity(identity, expectedIdentity) || identity.size !== expectedBytes.toString()) throw new RawJsonlExportError('verification-failed');
    const digest = createHash('sha256');
    const buffer = new Uint8Array(RAW_JSONL_EXPORT_CHUNK_BYTES);
    let position = 0;
    let bytes = 0n;
    while (true) {
      throwIfCancelled(signal);
      let read: number;
      try {
        read = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(expectedBytes - bytes) + 1), position);
      } catch {
        throw new RawJsonlExportError('verification-failed');
      }
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      position += read;
      bytes += BigInt(read);
      if (bytes > expectedBytes) throw new RawJsonlExportError('verification-failed');
      if (bytes > RAW_JSONL_EXPORT_MAX_BYTES) throw new RawJsonlExportError('verification-failed');
    }
    return { byteLength: bytes, sha256: digest.digest('hex') };
  } finally {
    await closeQuietly(handle);
  }
}

type DestinationProof = 'owned-and-verified' | 'absent' | 'different-or-unverifiable';

/** Inspection never writes or removes the destination, even when bytes match. */
export async function inspectRawJsonlCommit(prepared: RawJsonlPreparedCommit): Promise<DestinationProof> {
  return proveDestination(nodeRawJsonlExportFileSystem, prepared.destinationPath, prepared.identity,
    BigInt(prepared.byteLength), prepared.sha256.slice(7));
}

/** Explicit retry uses the same verified inode and no-replace publication primitive. */
export async function retryRawJsonlCommit(prepared: RawJsonlPreparedCommit, authorize: () => Promise<boolean>, signal?: AbortSignal): Promise<DestinationProof> {
  const existing = await inspectRawJsonlCommit(prepared);
  if (existing !== 'absent') return existing;
  throwIfCancelled(signal);
  const verified = await verifyFile(nodeRawJsonlExportFileSystem, prepared.temporaryPath, prepared.identity, BigInt(prepared.byteLength), signal);
  if (`sha256:${verified.sha256}` !== prepared.sha256 || !await authorize()) throw new RawJsonlExportError('source-not-authorized');
  throwIfCancelled(signal);
  try { await nodeRawJsonlExportFileSystem.link(prepared.temporaryPath, prepared.destinationPath); }
  catch { /* Every outcome is inspected; a conflict never permits replacement. */ }
  return inspectRawJsonlCommit(prepared);
}

export async function releaseRawJsonlTemporary(prepared: RawJsonlPreparedCommit): Promise<void> {
  await removeOwnedTemporary(nodeRawJsonlExportFileSystem, prepared.temporaryPath, prepared.identity);
}

async function proveDestination(
  fileSystem: RawJsonlExportFileSystem,
  destinationPath: string,
  ownedTemporaryIdentity: RawJsonlExportFileIdentity,
  byteLength: bigint,
  sha256: string,
): Promise<DestinationProof> {
  let destinationIdentity: RawJsonlExportFileIdentity;
  try {
    destinationIdentity = await fileSystem.lstat(destinationPath);
  } catch (error) {
    return isFileSystemError(error, 'ENOENT') ? 'absent' : 'different-or-unverifiable';
  }
  if (!destinationIdentity.isFile || destinationIdentity.isSymbolicLink
    || !sameFileIdentity(destinationIdentity, ownedTemporaryIdentity)) return 'different-or-unverifiable';
  try {
    const verified = await verifyFile(fileSystem, destinationPath, ownedTemporaryIdentity, byteLength);
    return verified.byteLength === byteLength && verified.sha256 === sha256 ? 'owned-and-verified' : 'different-or-unverifiable';
  } catch {
    return 'different-or-unverifiable';
  }
}

function committedReceipt(
  source: RawJsonlSourceSnapshot,
  destinationPath: string,
  byteLength: bigint,
  sha256: string,
): RawJsonlExportResult {
  return Object.freeze({
    status: 'committed',
    receipt: Object.freeze({
      schema: RAW_JSONL_EXPORT_RECEIPT_SCHEMA,
      version: 1,
      sourceId: source.sourceId,
      documentId: source.documentId,
      generation: source.generation,
      authorizationEpoch: source.authorizationEpoch,
      byteLength: byteLength.toString(),
      sha256: `sha256:${sha256}`,
      destinationPath,
      verification: 'source-and-temp-sha256',
      commit: 'same-directory-hard-link-no-replace',
    }),
  });
}

async function removeOwnedTemporary(
  fileSystem: RawJsonlExportFileSystem,
  temporaryPath: string,
  expectedIdentity: RawJsonlExportFileIdentity,
): Promise<void> {
  try {
    const current = await fileSystem.lstat(temporaryPath);
    if (current.isFile && !current.isSymbolicLink && sameFileIdentity(current, expectedIdentity)) {
      await fileSystem.unlink(temporaryPath);
    }
  } catch {
    // Temporary cleanup is best-effort. Never broaden deletion to another path.
  }
}

async function closeQuietly(handle: RawJsonlExportFileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try { await handle.close(); } catch { /* Preserve the primary result. */ }
}

function assertRegularFile(identity: RawJsonlExportFileIdentity, code: RawJsonlExportErrorCode): void {
  if (!identity.isFile || identity.isSymbolicLink || !isDecimal(identity.size)) throw new RawJsonlExportError(code);
}

function hasFileIdentity(identity: RawJsonlExportFileIdentity): boolean {
  return isDecimal(identity.device) && isDecimal(identity.inode) && identity.inode !== '0';
}

function sameFileIdentity(left: RawJsonlExportFileIdentity, right: RawJsonlExportFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameFileVersion(left: RawJsonlExportFileIdentity, right: RawJsonlExportFileIdentity): boolean {
  return sameFileIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.isFile === right.isFile && left.isSymbolicLink === right.isSymbolicLink;
}

function sameSnapshot(left: RawJsonlSourceSnapshot, right: RawJsonlSourceSnapshot): boolean {
  return isRecord(left)
    && left.sourceId === right.sourceId
    && left.documentId === right.documentId
    && left.generation === right.generation
    && left.authorizationEpoch === right.authorizationEpoch
    && left.byteLength === right.byteLength
    && left.sha256 === right.sha256;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0');
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^(?:0|[1-9]\d*)$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(code: RawJsonlExportErrorCode): string {
  switch (code) {
    case 'invalid-request': return 'Raw JSONL export request is invalid.';
    case 'source-not-authorized': return 'The source is no longer authorized for export.';
    case 'source-changed': return 'The source snapshot changed during export.';
    case 'source-unavailable': return 'The authorized source is unavailable.';
    case 'source-too-large': return 'The source exceeds the raw export byte budget.';
    case 'destination-invalid': return 'The selected destination is unavailable.';
    case 'destination-exists': return 'The selected destination already exists.';
    case 'temporary-create-failed': return 'A private export temporary file could not be created.';
    case 'filesystem-unsupported': return 'The filesystem cannot prove safe no-replace publication.';
    case 'source-read-failed': return 'The source could not be read completely.';
    case 'write-failed': return 'The export temporary file could not be written.';
    case 'verification-failed': return 'The exported bytes failed SHA-256 verification.';
    case 'cancelled': return 'Raw JSONL export was cancelled before publication.';
    case 'commit-failed': return 'The export could not be committed.';
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new RawJsonlExportError('cancelled');
}

/** Bounded fingerprint pass for a Host-selected open source, before export admission. */
export async function fingerprintRawJsonlSource(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<{ readonly byteLength: string; readonly sha256: string }> {
  throwIfCancelled(signal);
  const fileSystem = nodeRawJsonlExportFileSystem;
  let handle: RawJsonlExportFileHandle | undefined;
  try {
    handle = await fileSystem.open(await fileSystem.realpath(sourcePath), 'r');
    const before = await handle.stat();
    assertRegularFile(before, 'source-unavailable');
    if (BigInt(before.size) > RAW_JSONL_EXPORT_MAX_BYTES) throw new RawJsonlExportError('source-too-large');
    const digest = createHash('sha256');
    const buffer = new Uint8Array(RAW_JSONL_EXPORT_CHUNK_BYTES);
    let bytes = 0;
    while (true) {
      throwIfCancelled(signal);
      const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(BigInt(before.size)) - bytes + 1), bytes);
      if (read === 0) break;
      bytes += read;
      if (BigInt(bytes) > BigInt(before.size)) throw new RawJsonlExportError('source-changed');
      if (BigInt(bytes) > RAW_JSONL_EXPORT_MAX_BYTES) throw new RawJsonlExportError('source-too-large');
      digest.update(buffer.subarray(0, read));
    }
    if (!sameFileVersion(before, await handle.stat()) || String(bytes) !== before.size) throw new RawJsonlExportError('source-changed');
    throwIfCancelled(signal);
    return { byteLength: String(bytes), sha256: `sha256:${digest.digest('hex')}` };
  } catch (error) {
    if (error instanceof RawJsonlExportError) throw error;
    throw new RawJsonlExportError('source-read-failed');
  } finally {
    await closeQuietly(handle);
  }
}

/** Node filesystem adapter; hard-link publication is intentionally not emulated. */
export const nodeRawJsonlExportFileSystem: RawJsonlExportFileSystem = {
  async open(path, flags, mode) {
    let handle: FileHandle;
    try {
      handle = mode === undefined ? await open(path, flags) : await open(path, flags, mode);
    } catch (error) {
      throw error;
    }
    return {
      async read(buffer, offset, length, position) {
        const result = await handle.read(buffer, offset, length, position);
        return result.bytesRead;
      },
      async write(buffer, offset, length, position) {
        const result = await handle.write(buffer, offset, length, position);
        return result.bytesWritten;
      },
      async stat() { return fileIdentity(await handle.stat({ bigint: true })); },
      async sync() { await handle.sync(); },
      async close() { await handle.close(); },
    };
  },
  async lstat(path) { return fileIdentity(await lstat(path, { bigint: true })); },
  async realpath(path) { return realpath(path); },
  async link(existingPath, newPath) { await link(existingPath, newPath); },
  async unlink(path) { await unlink(path); },
};

function fileIdentity(stats: Awaited<ReturnType<FileHandle['stat']>>): RawJsonlExportFileIdentity {
  const values = stats as typeof stats & {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
    isSymbolicLink(): boolean;
  };
  return {
    device: values.dev.toString(),
    inode: values.ino.toString(),
    size: values.size.toString(),
    mtimeNs: values.mtimeNs.toString(),
    ctimeNs: values.ctimeNs.toString(),
    isFile: values.isFile(),
    isSymbolicLink: values.isSymbolicLink(),
  };
}
