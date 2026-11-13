import type { RecordRef } from './types';
import type { RevealResultOutcome } from './contracts/reveal';

export type { DocumentGraphReply, GraphRevealReceipt, GraphRevealRequest } from './contracts/document-graph';

export const DOCUMENT_GRAPH_LIMIT = 100;
export const DOCUMENT_GRAPH_MAX_BYTES: number = 4 * 1024 * 1024;
export const DOCUMENT_GRAPH_DEADLINE_MS = 500;

export function sameGraphRecordRef(left: RecordRef, right: RecordRef): boolean {
  return left.generation === right.generation && left.ordinal === right.ordinal
    && left.byteStart === right.byteStart && left.byteEndExclusive === right.byteEndExclusive
    && left.contentByteLength === right.contentByteLength && left.delimiterByteLength === right.delimiterByteLength
    && left.parseState === right.parseState;
}
