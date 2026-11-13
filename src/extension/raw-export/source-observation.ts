import { lstat, open } from 'node:fs/promises';
import type { DocumentSummary } from '@shared/types';
import type { RawExportIntent } from './intent';
import type { RawJsonlExportFileIdentity } from './jsonl';

export interface RawExportSourceObservation {
  readonly sourceUri: string;
  readonly identity: RawJsonlExportFileIdentity;
}

/** A restart cannot reuse random document/generation IDs. It must prove the same file version. */
export async function observeRawExportSource(sourcePath: string, intent: RawExportIntent): Promise<RawExportSourceObservation> {
  const handle = await open(sourcePath, 'r');
  try {
    const held = await handle.stat({ bigint: true });
    const path = await lstat(sourcePath, { bigint: true });
    const identity: RawJsonlExportFileIdentity = { device: held.dev.toString(), inode: held.ino.toString(), size: held.size.toString(),
      mtimeNs: held.mtimeNs.toString(), ctimeNs: held.ctimeNs.toString(), isFile: held.isFile(), isSymbolicLink: path.isSymbolicLink() };
    if (!held.isFile() || path.isSymbolicLink() || held.dev !== path.dev || held.ino !== path.ino || held.size !== path.size
      || held.mtimeNs !== path.mtimeNs || held.ctimeNs !== path.ctimeNs || held.size.toString() !== intent.binding.sizeBytes
      || Number(held.mtimeMs) !== intent.binding.mtimeMs
      || (intent.binding.device !== undefined && intent.binding.device !== identity.device)
      || (intent.binding.inode !== undefined && intent.binding.inode !== identity.inode)) throw new Error('Export source observation changed.');
    return { sourceUri: intent.binding.uri, identity };
  } finally { await handle.close(); }
}

export function sameRawExportObservation(left: RawExportSourceObservation, right: RawExportSourceObservation): boolean {
  const a = left.identity; const b = right.identity;
  return left.sourceUri === right.sourceUri && a.isFile && b.isFile && !a.isSymbolicLink && !b.isSymbolicLink
    && a.inode !== '0' && a.device === b.device && a.inode === b.inode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export function rawExportRecoverySummaryMatches(intent: RawExportIntent, summary: DocumentSummary): boolean {
  const binding = intent.binding; const snapshot = summary.snapshot;
  return binding.uri === snapshot.uri && binding.sizeBytes === snapshot.sizeBytes && binding.mtimeMs === snapshot.mtimeMs
    && binding.prefixFingerprint === snapshot.prefixFingerprint && binding.device === snapshot.device && binding.inode === snapshot.inode
    && binding.profileId === summary.profileId && binding.profileVersion === (summary.profileVersion ?? '');
}

export function isRawExportSourceObservation(value: unknown): value is RawExportSourceObservation {
  if (value === null || typeof value !== 'object') return false;
  const observation = value as RawExportSourceObservation;
  const identity = observation.identity;
  return typeof observation.sourceUri === 'string' && observation.sourceUri.length <= 32768
    && identity !== null && typeof identity === 'object' && identity.isFile === true && identity.isSymbolicLink === false
    && [identity.device, identity.inode, identity.size, identity.mtimeNs, identity.ctimeNs]
      .every((part) => typeof part === 'string' && /^\d{1,64}$/u.test(part)) && identity.inode !== '0';
}
