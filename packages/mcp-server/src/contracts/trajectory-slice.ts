/** Additive semantic query contract; existing physical QueryAstV1 is unchanged. */
export const TRAJECTORY_REQUEST_SCHEMA = 'jsonlview.trajectory-slice.request.v1' as const;
export const TRAJECTORY_RESULT_SCHEMA = 'jsonlview.trajectory-slice.result.v1' as const;
export type TrajectoryActor = 'user' | 'assistant' | 'tool' | 'system';
export interface TrajectoryPredicate { readonly actor?: TrajectoryActor; readonly hasError?: boolean }
export interface TrajectorySliceRequest {
  readonly schema: typeof TRAJECTORY_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly sourceId: string;
  readonly predicate: TrajectoryPredicate;
  readonly limit: number;
  readonly maxOutputBytes: number;
  readonly maxExaminedBytes: number;
  readonly deadlineMs: number;
  readonly cursor?: string;
}
export interface TrajectoryRecord {
  readonly ordinal: string;
  readonly byteStart: string;
  readonly byteEnd: string;
  readonly actor: TrajectoryActor | 'unknown';
  readonly hasError: boolean | null;
  readonly text: string | null;
}
export type TrajectoryErrorCode = 'INVALID_ARGUMENT' | 'SOURCE_NOT_AUTHORIZED' | 'SOURCE_CHANGED' | 'STALE_CURSOR'
  | 'BUDGET_TOO_SMALL' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'UNSUPPORTED_PROFILE' | 'IO_FAILED' | 'INTERNAL';
export type TrajectoryPartialReason = 'record_limit' | 'scan_limit' | 'output_limit' | 'deadline';
export interface TrajectorySuccessBase {
  readonly schema: typeof TRAJECTORY_RESULT_SCHEMA;
  readonly requestId: string;
  readonly sourceId: string;
  readonly profile: { readonly id: string; readonly version: string };
  readonly snapshot: { readonly id: string; readonly guarantee: 'observed-metadata' };
  readonly records: readonly TrajectoryRecord[];
  readonly usage: { readonly examinedBytes: string; readonly examinedRecords: number; readonly returnedBytes: number };
}
export type TrajectorySliceResult =
  | (TrajectorySuccessBase & { readonly status: 'complete' })
  | (TrajectorySuccessBase & { readonly status: 'partial'; readonly reason: TrajectoryPartialReason; readonly cursor: string })
  | { readonly schema: typeof TRAJECTORY_RESULT_SCHEMA; readonly requestId: string; readonly status: 'error';
    readonly error: { readonly code: TrajectoryErrorCode; readonly recoverable: boolean } };

const ACTORS = new Set<string>(['user', 'assistant', 'tool', 'system']);
const RECOVERABLE = new Set<TrajectoryErrorCode>(['SOURCE_CHANGED', 'STALE_CURSOR', 'BUDGET_TOO_SMALL', 'CANCELLED', 'DEADLINE_EXCEEDED', 'IO_FAILED']);
const encoder = new TextEncoder();
export function trajectoryError(requestId: string, code: TrajectoryErrorCode): TrajectorySliceResult {
  return { schema: TRAJECTORY_RESULT_SCHEMA, requestId: validText(requestId, 128) ? requestId : 'invalid-request',
    status: 'error', error: { code, recoverable: RECOVERABLE.has(code) } };
}

/** Strict whitelist and defaults match the published v1 schema. */
export function parseTrajectoryRequest(value: unknown): TrajectorySliceRequest | undefined {
  if (!record(value) || !only(value, ['schema', 'requestId', 'sourceId', 'predicate', 'limit', 'maxOutputBytes', 'maxExaminedBytes', 'deadlineMs', 'cursor'])
    || value.schema !== TRAJECTORY_REQUEST_SCHEMA || !validText(value.requestId, 128) || !validText(value.sourceId, 256)
    || !record(value.predicate) || !only(value.predicate, ['actor', 'hasError']) || Object.keys(value.predicate).length === 0
    || (Object.hasOwn(value.predicate, 'actor') && (typeof value.predicate.actor !== 'string' || !ACTORS.has(value.predicate.actor)))
    || (Object.hasOwn(value.predicate, 'hasError') && typeof value.predicate.hasError !== 'boolean')) return undefined;
  const limit = integer(value.limit, 50, 1, 128);
  const maxOutputBytes = integer(value.maxOutputBytes, 262_144, 1024, 1_048_576);
  const maxExaminedBytes = integer(value.maxExaminedBytes, 8_388_608, 1024, 67_108_864);
  const deadlineMs = integer(value.deadlineMs, 5000, 100, 30_000);
  if (limit === undefined || maxOutputBytes === undefined || maxExaminedBytes === undefined || deadlineMs === undefined
    || (Object.hasOwn(value, 'cursor') && (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/u.test(value.cursor)))) return undefined;
  return { schema: TRAJECTORY_REQUEST_SCHEMA, requestId: value.requestId, sourceId: value.sourceId,
    predicate: { ...(value.predicate.actor === undefined ? {} : { actor: value.predicate.actor as TrajectoryActor }),
      ...(value.predicate.hasError === undefined ? {} : { hasError: value.predicate.hasError as boolean }) },
    limit, maxOutputBytes, maxExaminedBytes, deadlineMs,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}) };
}

/** Construct the documented field order, excluding accidental internal metadata. */
export function serializeTrajectoryResult(value: TrajectorySliceResult): string {
  if (value.status === 'error') return JSON.stringify({ schema: value.schema, requestId: value.requestId,
    status: value.status, error: { code: value.error.code, recoverable: RECOVERABLE.has(value.error.code) } });
  return JSON.stringify({ schema: value.schema, requestId: value.requestId, status: value.status, sourceId: value.sourceId,
    profile: { id: value.profile.id, version: value.profile.version }, snapshot: { id: value.snapshot.id, guarantee: value.snapshot.guarantee },
    records: value.records.map((r) => ({ ordinal: r.ordinal, byteStart: r.byteStart, byteEnd: r.byteEnd, actor: r.actor, hasError: r.hasError, text: r.text })),
    usage: { examinedBytes: value.usage.examinedBytes, examinedRecords: value.usage.examinedRecords, returnedBytes: value.usage.returnedBytes },
    ...(value.status === 'partial' ? { reason: value.reason, cursor: value.cursor } : {}) });
}

/** returnedBytes measures this serializer with the returnedBytes slot set to 0. */
export function measureTrajectoryResult(value: TrajectorySliceResult): { readonly result: TrajectorySliceResult; readonly json: string; readonly byteLength: number } {
  if (value.status === 'error') {
    const json = serializeTrajectoryResult(value);
    return { result: value, json, byteLength: encoder.encode(json).byteLength };
  }
  const returnedBytes = encoder.encode(serializeTrajectoryResult({ ...value, usage: { ...value.usage, returnedBytes: 0 } })).byteLength;
  const result: TrajectorySliceResult = { ...value, usage: { ...value.usage, returnedBytes } };
  const json = serializeTrajectoryResult(result);
  return { result, json, byteLength: encoder.encode(json).byteLength };
}

export function matchesTrajectory(record: Pick<TrajectoryRecord, 'actor' | 'hasError'>, predicate: TrajectoryPredicate): boolean {
  return (predicate.actor === undefined || record.actor === predicate.actor)
    && (predicate.hasError === undefined || record.hasError === predicate.hasError);
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function validText(value: unknown, max: number): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= max
  && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
function integer(value: unknown, fallback: number, min: number, max: number): number | undefined {
  return value === undefined ? fallback : typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}


