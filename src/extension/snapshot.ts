import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { SnapshotIdentity } from '../shared/types';

const PREFIX_BYTES = 64 * 1024;

export type SnapshotChange = 'unchanged' | 'append' | 'truncate' | 'replace';

export async function createLocalSnapshot(
  filePath: string,
  uri: string,
  documentId: string = randomUUID(),
): Promise<SnapshotIdentity> {
  const metadata = await stat(filePath, { bigint: true });
  if (!metadata.isFile()) {
    throw new Error('JsonlView can only open regular files.');
  }

  const prefixLength = Number(
    metadata.size < BigInt(PREFIX_BYTES) ? metadata.size : BigInt(PREFIX_BYTES),
  );
  const prefix = Buffer.allocUnsafe(prefixLength);
  const handle = await open(filePath, 'r');
  try {
    if (prefixLength > 0) {
      const { bytesRead } = await handle.read(prefix, {
        offset: 0,
        length: prefixLength,
        position: 0n,
      });
      if (bytesRead !== prefixLength) {
        throw new Error(`Short prefix read: expected ${prefixLength}, received ${bytesRead}.`);
      }
    }
  } finally {
    await handle.close();
  }

  return {
    documentId,
    generation: randomUUID(),
    uri,
    scheme: 'file',
    sizeBytes: metadata.size.toString(),
    mtimeMs: Number(metadata.mtimeMs),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    prefixFingerprint: createHash('sha256').update(prefix).digest('hex').slice(0, 32),
    observedAt: new Date().toISOString(),
  };
}

export function classifySnapshotChange(
  previous: SnapshotIdentity,
  current: SnapshotIdentity,
): SnapshotChange {
  const previousSize = BigInt(previous.sizeBytes);
  const currentSize = BigInt(current.sizeBytes);
  const stableIdentity =
    previous.device !== undefined &&
    previous.inode !== undefined &&
    current.device !== undefined &&
    current.inode !== undefined;

  if (
    stableIdentity &&
    (previous.device !== current.device || previous.inode !== current.inode)
  ) {
    return 'replace';
  }
  if (stableIdentity && currentSize < previousSize) {
    return 'truncate';
  }
  if (stableIdentity && currentSize > previousSize) {
    return 'append';
  }
  if (previous.prefixFingerprint !== current.prefixFingerprint) {
    return 'replace';
  }
  if (currentSize !== previousSize) {
    return 'replace';
  }
  return previous.mtimeMs === current.mtimeMs ? 'unchanged' : 'replace';
}
