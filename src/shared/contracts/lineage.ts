import type { RecordRef, RowProjection } from './record';

export type LineageLookupRelation = 'parent' | 'tool-partner' | 'span-context';

export const LINEAGE_LOOKUP_MAX_RECORDS = 500;
export const LINEAGE_LOOKUP_MAX_BYTES = 1_048_576;
export const LINEAGE_LOOKUP_DEADLINE_MS = 1500;
export const LINEAGE_LOOKUP_RETAINED_ROWS = 16;

export interface LineageLookupRequest {
  readonly sourceRef: RecordRef;
  readonly relation: LineageLookupRelation;
}

export interface LineageLookupReply extends LineageLookupRequest {
  readonly status: 'found' | 'not-observed' | 'ambiguous' | 'budget-exceeded' | 'timed-out' | 'stale' | 'unavailable';
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileEpoch?: number;
  readonly scope: {
    readonly kind: 'physical-window';
    readonly startOrdinal: string;
    readonly endOrdinalExclusive: string;
    readonly examinedRecords: number;
    readonly examinedBytes: string;
    /** Content-read requests, including index reconstruction; failed/short reads are not refunded. */
    readonly requestedBytes: number;
    readonly complete: boolean;
  };
  readonly match?: RowProjection;
}
