import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { JsonlEngineError } from './errors';

export interface SourceFingerprint {
  length: number;
  hash: string;
}

export interface FullSourceFingerprint {
  length: bigint;
  hash: string;
}

/** Completed-read diagnostics, optionally paired with a caller-owned pre-read allowance. */
export interface ReadWaitObserver {
  (elapsedMs: number, bytesRead: number): void;
  /** Runs before a read attempt. It may shorten the request or refuse it. */
  limitRead?(requestedLength: number): number;
}

export async function readFileHandle(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | bigint | null,
  onReadWait?: ReadWaitObserver,
): Promise<number> {
  length = onReadWait?.limitRead?.(length) ?? length;
  if (onReadWait === undefined) {
    return (await handle.read(buffer, offset, length, position)).bytesRead;
  }

  const startedAt = performance.now();
  let bytesRead = 0;
  try {
    bytesRead = (await handle.read(buffer, offset, length, position)).bytesRead;
    return bytesRead;
  } finally {
    try {
      onReadWait(performance.now() - startedAt, bytesRead);
    } catch {
      // Completed-read diagnostics must never replace the read result/error.
    }
  }
}

export async function fingerprintRange(
  handle: FileHandle,
  start: bigint,
  length: number,
  onReadWait?: ReadWaitObserver,
): Promise<SourceFingerprint> {
  if (length === 0) return { length: 0, hash: createHash('sha256').digest('hex') };
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = await readFileHandle(
      handle,
      buffer,
      offset,
      length - offset,
      start + BigInt(offset),
      onReadWait,
    );
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return {
    length: offset,
    hash: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex'),
  };
}

/** Fixed original boundary checks; never grows into a whole-source scan. */
export async function assertBoundaryFingerprints(
  handle: FileHandle, fileSize: bigint, prefix: SourceFingerprint, tail: SourceFingerprint, guard: () => void,
): Promise<void> {
  for (const [start, expected] of [[0n, prefix], [fileSize - BigInt(tail.length), tail]] as const) {
    guard();
    const observed = await fingerprintRange(handle, start, expected.length);
    guard();
    if (observed.length !== expected.length || observed.hash !== expected.hash) {
      throw new JsonlEngineError('SOURCE_CHANGED', 'The source boundary bytes changed before the text handoff.');
    }
  }
}

export async function fingerprintStableRange(
  handle: FileHandle,
  length: bigint,
  baselineMtimeNs: bigint,
  baselineCtimeNs: bigint,
  signal?: AbortSignal,
  onReadWait?: ReadWaitObserver,
): Promise<FullSourceFingerprint | undefined> {
  try {
    const before = await handle.stat({ bigint: true });
    // Do not establish a baseline after a writer has already moved the file.
    // The original bytes are then unknowable without a separate snapshot.
    if (
      !before.isFile()
      || before.size !== length
      || before.mtimeNs !== baselineMtimeNs
      || before.ctimeNs !== baselineCtimeNs
    ) return undefined;
    const fingerprint = await fingerprintWholeRange(handle, length, signal, undefined, onReadWait);
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== length
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || fingerprint.length !== length
    ) {
      // A concurrent append/rewrite invalidates this one-shot baseline. The
      // caller must open a new generation once the writer is quiescent.
      return undefined;
    }
    return fingerprint;
  } catch {
    return undefined;
  }
}

export async function fingerprintWholeRange(
  handle: FileHandle,
  length: bigint,
  signal?: AbortSignal,
  guard?: () => void,
  onReadWait?: ReadWaitObserver,
): Promise<FullSourceFingerprint> {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0n;
  while (offset < length) {
    guard?.();
    if (signal?.aborted) throw new Error('fingerprint aborted');
    const remaining = length - offset;
    const requested = Number(remaining < BigInt(chunk.length) ? remaining : BigInt(chunk.length));
    let filled = 0;
    while (filled < requested) {
      const bytesRead = await readFileHandle(
        handle,
        chunk,
        filled,
        requested - filled,
        offset + BigInt(filled),
        onReadWait,
      );
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    if (filled === 0) break;
    hash.update(chunk.subarray(0, filled));
    offset += BigInt(filled);
  }
  guard?.();
  return { length: offset, hash: hash.digest('hex') };
}

export function formatFingerprint(fingerprint: SourceFingerprint): string {
  return `sha256:${fingerprint.hash}:${String(fingerprint.length)}`;
}
