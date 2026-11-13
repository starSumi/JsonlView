import type { SnapshotIdentity } from '@shared/types';
import {
  exportRawJsonl, fingerprintRawJsonlSource, RawJsonlExportError,
  type RawJsonlExportResult, type RawJsonlAuthorizedSource,
} from './jsonl';

/** A source opened by the user; closing its last panel revokes this operation. */
export interface OpenRawJsonlSource {
  readonly sourcePath: string;
  currentIdentity(): SnapshotIdentity | undefined;
  isUnchanged(signal?: AbortSignal): Promise<boolean>;
}

/** Exports the complete physical source, independent of table filters and sort. */
export async function exportOpenRawJsonl(
  source: OpenRawJsonlSource,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<RawJsonlExportResult> {
  const initial = source.currentIdentity();
  if (initial === undefined || initial.scheme !== 'file') throw new RawJsonlExportError('source-not-authorized');
  const expected = { ...initial };
  const isCurrent = (): boolean => sameIdentity(expected, source.currentIdentity());
  if (!await source.isUnchanged(signal) || !isCurrent()) throw new RawJsonlExportError('source-changed');
  const fingerprint = await fingerprintRawJsonlSource(source.sourcePath, signal);
  if (fingerprint.byteLength !== expected.sizeBytes || !isCurrent()) throw new RawJsonlExportError('source-changed');
  const authorized: RawJsonlAuthorizedSource = {
    authorization: 'authorized', sourcePath: source.sourcePath,
    snapshot: {
      sourceId: expected.documentId, documentId: expected.documentId,
      generation: expected.generation, authorizationEpoch: String(expected.epoch ?? 0),
      ...fingerprint,
    },
  };
  return exportRawJsonl({ source: authorized.snapshot, destinationPath, ...(signal === undefined ? {} : { signal }) }, {
    authorizeAndResolveSource: async (sourceId) => {
      if (sourceId !== expected.documentId || !isCurrent()) return undefined;
      if (!await source.isUnchanged(signal) || !isCurrent()) return undefined;
      return authorized;
    },
  });
}

function sameIdentity(expected: SnapshotIdentity, actual: SnapshotIdentity | undefined): boolean {
  return actual !== undefined && expected.documentId === actual.documentId
    && expected.generation === actual.generation && expected.epoch === actual.epoch
    && expected.uri === actual.uri && expected.scheme === actual.scheme
    && expected.sizeBytes === actual.sizeBytes && expected.mtimeMs === actual.mtimeMs
    && expected.device === actual.device && expected.inode === actual.inode
    && expected.prefixFingerprint === actual.prefixFingerprint;
}
