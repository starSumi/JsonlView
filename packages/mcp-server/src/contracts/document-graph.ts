import type { GraphBuildResult } from './graph-model.js';
import type { RecordRef } from './types.js';
import type { RevealResultOutcome } from './protocol/reveal.js';

export const DOCUMENT_GRAPH_LIMIT = 100;
export const DOCUMENT_GRAPH_MAX_BYTES: number = 4 * 1024 * 1024;
export const DOCUMENT_GRAPH_DEADLINE_MS = 500;

/** Internal current-document projection. It never authorizes another source. */
export interface DocumentGraphReply {
  readonly version: 1;
  readonly status: 'ready' | 'empty' | 'partial' | 'stale' | 'unauthorized' | 'unavailable';
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileEpoch?: number;
  readonly scope: { readonly kind: 'physical-prefix'; readonly limit: 100; readonly examinedRecords: number };
  readonly missingRelations: number;
  readonly missingRefs: number;
  readonly graph: GraphBuildResult;
}

export interface GraphRevealRequest {
  readonly graphRequestId: string;
  readonly ref: RecordRef;
}

export interface GraphRevealReceipt extends GraphRevealRequest {
  readonly outcome: RevealResultOutcome;
}

export function sameGraphRecordRef(left: RecordRef, right: RecordRef): boolean {
  return left.generation === right.generation && left.ordinal === right.ordinal
    && left.byteStart === right.byteStart && left.byteEndExclusive === right.byteEndExclusive
    && left.contentByteLength === right.contentByteLength && left.delimiterByteLength === right.delimiterByteLength
    && left.parseState === right.parseState;
}
