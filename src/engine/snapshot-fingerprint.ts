import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

export interface SourceFingerprint {
  length: number;
  hash: string;
}

export interface FullSourceFingerprint {
  length: bigint;
  hash: string;
}

export async function fingerprintRange(
  handle: FileHandle,
  start: bigint,
  length: number,
): Promise<SourceFingerprint> {
  if (length === 0) return { length: 0, hash: createHash('sha256').digest('hex') };
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + BigInt(offset));
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return {
    length: offset,
    hash: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex'),
  };
}

export async function fingerprintStableRange(
  handle: FileHandle,
  length: bigint,
  baselineMtimeNs: bigint,
  baselineCtimeNs: bigint,
  signal?: AbortSignal,
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
    const fingerprint = await fingerprintWholeRange(handle, length, signal);
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
      const { bytesRead } = await handle.read(
        chunk,
        filled,
        requested - filled,
        offset + BigInt(filled),
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
