import { isGraphBuildResult, type GraphBuildResult, type GraphSnapshotV2 } from './graph';
import { isCurrentRecordRef, type RecordRef } from './record';
import type { RevealResultOutcome } from './reveal';

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

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

/** Reuse the bounded model at the renderer boundary; rejected rows cannot become reveal targets. */
export function isDocumentGraphReply(value: unknown, sourceId: string, generation: string): value is DocumentGraphReply {
  if (!object(value) || value.version !== 1 || !['ready', 'empty', 'partial', 'stale', 'unauthorized', 'unavailable'].includes(String(value.status))
    || !text(value.profileId, 128) || !text(value.profileVersion, 256)
    || (value.profileEpoch !== undefined && !count(value.profileEpoch, Number.MAX_SAFE_INTEGER))
    || !count(value.missingRelations, 200) || !count(value.missingRefs, 100) || !object(value.scope)
    || value.scope.kind !== 'physical-prefix' || value.scope.limit !== 100 || !count(value.scope.examinedRecords, 100)
    || !isGraphBuildResult(value.graph, { maxNodes: 100, maxEdges: 200, maxSourceGenerations: 1,
      requiredSource: { sourceId, generation } })) return false;
  const graph = value.graph;
  const snapshot: GraphSnapshotV2 = graph.snapshot;
  if (snapshot.schema !== 'jsonlview.graph.v2' || snapshot.version !== 2
    || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return false;
  if (['stale', 'unauthorized', 'unavailable'].includes(String(value.status)) && (snapshot.nodes.length > 0 || snapshot.edges.length > 0)) return false;
  return true;
}

export function isGraphRevealReceipt(value: unknown, generation: string): value is GraphRevealReceipt {
  return object(value) && Object.keys(value).length === 3 && text(value.graphRequestId, 128)
    && isCurrentRecordRef(value.ref, generation)
    && ['shown', 'filtered-out', 'not-found', 'stale', 'no-view', 'timeout', 'superseded', 'cancelled', 'out-of-range', 'unauthorized'].includes(String(value.outcome));
}
