import type { ParseState } from '@shared/types';
import type { NewlineScanner, NewlineScannerDiagnostics } from './newline-scanner-types';

/**
 * Physical coordinates captured while scanning one JSONL record.
 *
 * The engine owns the values and their mutation. This module only keeps the
 * shape shared by the index facade and the query/hydration boundary.
 */
export interface InternalRecordRef {
  ordinal: bigint;
  byteStart: bigint;
  byteEndExclusive: bigint;
  contentByteLength: bigint;
  delimiterByteLength: 0 | 1 | 2;
  parseState: ParseState;
}

export interface SegmentMeta {
  id: number;
  firstOrdinal: bigint;
  recordCount: number;
  byteStart: bigint;
  physicalEndExclusive: bigint;
}

export interface SegmentLocation {
  segmentId: number;
  localIndex: number;
  segmentCapacity: number;
}

export interface SegmentIndexOptions {
  readChunkBytes: number;
  segmentTargetBytes: number;
  segmentTargetRecords: number;
  exactCacheSegments: number;
  maxRecordBytes: number;
  newlineScanner: NewlineScanner;
  validateSnapshot: () => Promise<void>;
}

export interface SegmentIndexDiagnostics {
  segmentCount: number;
  exactCachedSegments: number;
  pendingExactRecords: number;
  indexedBytes: string;
  indexedRecords: string;
  complete: boolean;
  newlineScanner: NewlineScannerDiagnostics;
}

export type OperationGuard = () => void;
