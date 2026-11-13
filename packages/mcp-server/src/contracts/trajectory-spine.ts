import type { TrajectoryErrorCode, TrajectoryPartialReason, TrajectoryRecord, TrajectorySuccessBase } from './trajectory-slice.js';

export const TRAJECTORY_SPINE_REQUEST_SCHEMA = 'jsonlview.trajectory-spine.request.v1' as const;
export const TRAJECTORY_SPINE_RESULT_SCHEMA = 'jsonlview.trajectory-spine.result.v1' as const;

export interface TrajectorySpineRequest {
  readonly schema: typeof TRAJECTORY_SPINE_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly sourceId: string;
  readonly limit: number;
  readonly maxOutputBytes: number;
  readonly maxExaminedBytes: number;
  readonly deadlineMs: number;
  readonly cursor?: string;
}

export type TrajectorySpineSuccess = Omit<TrajectorySuccessBase, 'schema' | 'records'> & {
  readonly schema: typeof TRAJECTORY_SPINE_RESULT_SCHEMA;
  readonly entries: readonly TrajectoryRecord[];
  readonly omitted: { readonly invalidJson: number; readonly unknownActor: number; readonly toolPayloads: number; readonly textTruncated: number };
  readonly status: 'complete' | 'partial';
  readonly reason?: TrajectoryPartialReason;
  readonly cursor?: string;
};

export type TrajectorySpineResult = TrajectorySpineSuccess | {
  readonly schema: typeof TRAJECTORY_SPINE_RESULT_SCHEMA;
  readonly requestId: string;
  readonly status: 'error';
  readonly error: { readonly code: TrajectoryErrorCode; readonly recoverable: boolean };
};

/** Strict public request parser shared by both MCP surfaces. */
export function parseTrajectorySpineRequest(value: unknown): TrajectorySpineRequest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.schema !== TRAJECTORY_SPINE_REQUEST_SCHEMA
    || Object.keys(raw).some((key) => !['schema', 'requestId', 'sourceId', 'limit', 'maxOutputBytes', 'maxExaminedBytes', 'deadlineMs', 'cursor'].includes(key))
    || !validText(raw.requestId, 128) || !validText(raw.sourceId, 256)) return undefined;
  const limit = integer(raw.limit, 50, 1, 128);
  const maxOutputBytes = integer(raw.maxOutputBytes, 262_144, 1024, 1_048_576);
  const maxExaminedBytes = integer(raw.maxExaminedBytes, 8_388_608, 1024, 67_108_864);
  const deadlineMs = integer(raw.deadlineMs, 5000, 100, 30_000);
  if (limit === undefined || maxOutputBytes === undefined || maxExaminedBytes === undefined || deadlineMs === undefined
    || (Object.hasOwn(raw, 'cursor') && (typeof raw.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/u.test(raw.cursor)))) return undefined;
  return { schema: TRAJECTORY_SPINE_REQUEST_SCHEMA, requestId: raw.requestId, sourceId: raw.sourceId,
    limit, maxOutputBytes, maxExaminedBytes, deadlineMs, ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}) };
}

/** Stable wire serializer shared by both MCP surfaces. */
export function serializeTrajectorySpineResult(value: TrajectorySpineResult): string {
  if (value.status === 'error') return JSON.stringify({ schema: value.schema, requestId: value.requestId, status: value.status,
    error: { code: value.error.code, recoverable: value.error.recoverable } });
  return JSON.stringify({ schema: value.schema, requestId: value.requestId, status: value.status, sourceId: value.sourceId,
    profile: { id: value.profile.id, version: value.profile.version }, snapshot: { id: value.snapshot.id, guarantee: value.snapshot.guarantee },
    entries: value.entries.map((entry) => ({ ordinal: entry.ordinal, byteStart: entry.byteStart, byteEnd: entry.byteEnd,
      actor: entry.actor, hasError: entry.hasError, text: entry.text })),
    omitted: { invalidJson: value.omitted.invalidJson, unknownActor: value.omitted.unknownActor, toolPayloads: value.omitted.toolPayloads, textTruncated: value.omitted.textTruncated },
    usage: { examinedBytes: value.usage.examinedBytes, examinedRecords: value.usage.examinedRecords, returnedBytes: value.usage.returnedBytes },
    ...(value.status === 'partial' ? { reason: value.reason, cursor: value.cursor } : {}) });
}

export function measureTrajectorySpineResult(value: TrajectorySpineResult): { readonly result: TrajectorySpineResult; readonly json: string; readonly byteLength: number } {
  const byteLength = (json: string): number => new TextEncoder().encode(json).byteLength;
  if (value.status === 'error') {
    const json = serializeTrajectorySpineResult(value);
    return { result: value, json, byteLength: byteLength(json) };
  }
  const returnedBytes = byteLength(serializeTrajectorySpineResult({ ...value, usage: { ...value.usage, returnedBytes: 0 } }));
  const result: TrajectorySpineResult = { ...value, usage: { ...value.usage, returnedBytes } };
  const json = serializeTrajectorySpineResult(result);
  return { result, json, byteLength: byteLength(json) };
}

function validText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= max
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
function integer(value: unknown, fallback: number, min: number, max: number): number | undefined {
  return value === undefined ? fallback : typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}
