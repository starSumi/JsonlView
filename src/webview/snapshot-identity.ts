import type { SnapshotIdentity } from '../shared/types';

export type AcceptedSnapshotIdentity = Readonly<Pick<SnapshotIdentity, 'documentId' | 'generation' | 'epoch'>>;

/** Compare accepted payload snapshots; the message client owns admission and epoch ordering. */
export function snapshotIdentityChanged(
  previous: AcceptedSnapshotIdentity | undefined,
  next: AcceptedSnapshotIdentity,
): boolean {
  return previous === undefined
    || previous.documentId !== next.documentId
    || previous.generation !== next.generation
    || (previous.epoch !== undefined && next.epoch !== undefined && previous.epoch !== next.epoch);
}
