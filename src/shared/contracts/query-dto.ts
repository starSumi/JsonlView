import type { RowSort, ScanTruncationReason } from './query';
import { isQueryAstV1, type QueryAstV1 } from './query-ast';

/** Stable wire discriminator for the bounded query request/result DTO. */
export const QUERY_DTO_SCHEMA = 'jsonlview.query-dto.v1' as const;
export const QUERY_DTO_VERSION = 1 as const;

export const QUERY_DTO_LIMITS: Readonly<{
  maxSourceIdLength: number;
  maxDocumentIdLength: number;
  maxGenerationLength: number;
  maxFingerprintLength: number;
  maxRequestIdLength: number;
  maxLimit: number;
  maxSortWindow: number;
  maxExaminedRecords: number;
  maxBytes: number;
  maxExaminedBytes: number;
  maxBudgetAheadMs: number;
  maxDecimalLength: number;
}> = Object.freeze({
  maxSourceIdLength: 256,
  maxDocumentIdLength: 256,
  maxGenerationLength: 256,
  maxFingerprintLength: 256,
  maxRequestIdLength: 128,
  maxLimit: 500,
  maxSortWindow: 2_048,
  maxExaminedRecords: 1_000_000,
  maxBytes: 512 * 1024 * 1024,
  maxExaminedBytes: 512 * 1024 * 1024,
  maxBudgetAheadMs: 60_000,
  maxDecimalLength: 20,
});

/** Source identity is resolved by the Host; no filesystem path crosses this DTO. */
export interface QuerySourceIdentityV1 {
  readonly sourceId: string;
  readonly documentId: string;
  readonly generation: string;
  readonly epoch?: number;
  /** Optional snapshot fingerprint for stale-source rejection. */
  readonly fingerprint?: string;
}

/** Physical cursor and logical sort are mutually constrained by the consumer. */
export interface QueryCursorV1 {
  readonly anchorOrdinal?: string;
  readonly direction?: 'forward' | 'backward';
  readonly sort?: RowSort;
  readonly sortOffset?: string;
}

/**
 * Explicit execution allowance. `maxBytes` bounds returned record bytes;
 * optional examined limits carry the existing sparse-predicate scan budget.
 * The absolute deadline is intentionally a number, never a timer or signal.
 */
export interface QueryBudgetV1 {
  readonly limit: number;
  readonly maxBytes: string;
  readonly deadlineEpochMs: number;
  readonly maxExaminedRecords?: number;
  readonly maxExaminedBytes?: string;
}

/** Cancellation is correlated by request id; an AbortSignal is host-local. */
export interface QueryCancellationV1 {
  readonly requestId: string;
}

export interface QueryRequestDtoV1 {
  readonly schema: typeof QUERY_DTO_SCHEMA;
  readonly version: typeof QUERY_DTO_VERSION;
  /** Correlates the request and settlement in the Host transport. */
  readonly requestId: string;
  readonly source: QuerySourceIdentityV1;
  readonly ast: QueryAstV1;
  readonly cursor: QueryCursorV1;
  readonly budget: QueryBudgetV1;
  readonly cancellation: QueryCancellationV1;
}

export type QueryDtoV1 = QueryRequestDtoV1;
export type QueryRequestV1 = QueryRequestDtoV1;
export type QueryExecutionRequestDtoV1 = QueryRequestDtoV1;

export type QueryExecutionStatusV1 =
  | 'completed'
  | 'truncated'
  | 'cancelled'
  | 'stale'
  | 'unsupported'
  | 'failed';

export type QueryErrorCodeV1 =
  | 'invalid-request'
  | 'source-not-authorized'
  | 'source-changed'
  | 'cancelled'
  | 'deadline-exceeded'
  | 'budget-exceeded'
  | 'unsupported-query'
  | 'native-unavailable'
  | 'native-failed'
  | 'io-failed';

export interface QueryErrorV1 {
  readonly code: QueryErrorCodeV1;
  readonly recoverable: boolean;
}

export interface QueryTruncationV1 {
  readonly reason: ScanTruncationReason | 'page-limit' | 'max-bytes';
  readonly nextOrdinal?: string;
}

/** Metadata-only settlement used by future adapters; row projection stays owned by the portable engine. */
export interface QuerySettlementDtoV1 {
  readonly schema: typeof QUERY_DTO_SCHEMA;
  readonly version: typeof QUERY_DTO_VERSION;
  readonly source: QuerySourceIdentityV1;
  readonly requestId: string;
  readonly status: QueryExecutionStatusV1;
  readonly truncation?: QueryTruncationV1;
  readonly error?: QueryErrorV1;
}

export type QueryResultDtoV1 = QuerySettlementDtoV1;
export type QueryResponseDtoV1 = QuerySettlementDtoV1;

/**
 * Fail-closed settlement guard for adapters that exchange only operation
 * metadata. A terminal status must carry exactly the metadata that explains
 * that status; this prevents a partial/native response from being mistaken
 * for a completed query.
 */
export function isQuerySettlementDtoV1(value: unknown): value is QuerySettlementDtoV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schema', 'version', 'source', 'requestId', 'status', 'truncation', 'error'])
    || value.schema !== QUERY_DTO_SCHEMA
    || value.version !== QUERY_DTO_VERSION
    || !isSourceIdentity(value.source)
    || !isBoundedString(value.requestId, QUERY_DTO_LIMITS.maxRequestIdLength)
    || !isQueryExecutionStatus(value.status)
    || (value.truncation !== undefined && !isTruncation(value.truncation))
    || (value.error !== undefined && !isQueryError(value.error))) {
    return false;
  }
  switch (value.status) {
    case 'completed':
      return value.truncation === undefined && value.error === undefined;
    case 'truncated':
      return value.truncation !== undefined && value.error === undefined;
    case 'cancelled':
      return value.truncation === undefined && value.error?.code === 'cancelled';
    case 'stale':
      return value.truncation === undefined
        && (value.error?.code === 'source-changed' || value.error?.code === 'source-not-authorized');
    case 'unsupported':
      return value.truncation === undefined
        && (value.error?.code === 'unsupported-query' || value.error?.code === 'native-unavailable');
    case 'failed':
      return value.truncation === undefined
        && value.error !== undefined
        && (value.error.code === 'invalid-request'
          || value.error.code === 'deadline-exceeded'
          || value.error.code === 'budget-exceeded'
          || value.error.code === 'native-failed'
          || value.error.code === 'io-failed');
    default:
      return false;
  }
}

export function serializeQuerySettlementDtoV1(value: QuerySettlementDtoV1): string {
  if (!isQuerySettlementDtoV1(value)) throw new TypeError('Invalid query settlement DTO v1.');
  return JSON.stringify(value);
}

export function parseQuerySettlementDtoV1(value: string): QuerySettlementDtoV1 | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isQuerySettlementDtoV1(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isQueryRequestDtoV1(value: unknown, nowEpochMs: number = Date.now()): value is QueryRequestDtoV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['schema', 'version', 'requestId', 'source', 'ast', 'cursor', 'budget', 'cancellation'])
    || value.schema !== QUERY_DTO_SCHEMA
    || value.version !== QUERY_DTO_VERSION
    || !isBoundedString(value.requestId, QUERY_DTO_LIMITS.maxRequestIdLength)
    || !isSourceIdentity(value.source)
    || !isQueryAstV1(value.ast)
    || !isBudget(value.budget, nowEpochMs)
    || !isCancellation(value.cancellation)) {
    return false;
  }
  return isCursor(value.cursor, value.budget.limit)
    && value.requestId === value.cancellation.requestId;
}

export function serializeQueryRequestDtoV1(value: QueryRequestDtoV1, nowEpochMs: number = Date.now()): string {
  if (!isQueryRequestDtoV1(value, nowEpochMs)) throw new TypeError('Invalid query DTO v1.');
  return JSON.stringify(value);
}

export function parseQueryRequestDtoV1(value: string, nowEpochMs: number = Date.now()): QueryRequestDtoV1 | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isQueryRequestDtoV1(parsed, nowEpochMs) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isSourceIdentity(value: unknown): value is QuerySourceIdentityV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['sourceId', 'documentId', 'generation', 'epoch', 'fingerprint'])
    || !isBoundedString(value.sourceId, QUERY_DTO_LIMITS.maxSourceIdLength)
    || !isBoundedString(value.documentId, QUERY_DTO_LIMITS.maxDocumentIdLength)
    || !isBoundedString(value.generation, QUERY_DTO_LIMITS.maxGenerationLength)) {
    return false;
  }
  return (value.epoch === undefined || isNonNegativeSafeInteger(value.epoch))
    && (value.fingerprint === undefined || isBoundedString(value.fingerprint, QUERY_DTO_LIMITS.maxFingerprintLength));
}

function isCursor(value: unknown, limit: number): value is QueryCursorV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['anchorOrdinal', 'direction', 'sort', 'sortOffset'])
    || (value.anchorOrdinal !== undefined && !isDecimal(value.anchorOrdinal))
    || (value.direction !== undefined && value.direction !== 'forward' && value.direction !== 'backward')
    || (value.sort !== undefined && !isRowSort(value.sort))
    || (value.sortOffset !== undefined && !isDecimal(value.sortOffset))) return false;
  if (value.sort !== undefined
    && (value.anchorOrdinal !== undefined || value.direction !== undefined)
    && ((value.sort.columnId !== '__ordinal' && value.sort.columnId !== '$ordinal')
      || value.sortOffset !== undefined)) return false;
  if (value.sortOffset !== undefined
    && (value.sort === undefined
      || (value.sort.columnId !== '__ordinal' && value.sort.columnId !== '$ordinal')
      && BigInt(value.sortOffset) + BigInt(limit) > BigInt(QUERY_DTO_LIMITS.maxSortWindow))) return false;
  return true;
}

function isBudget(value: unknown, nowEpochMs: number): value is QueryBudgetV1 {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['limit', 'maxBytes', 'deadlineEpochMs', 'maxExaminedRecords', 'maxExaminedBytes'])
    || !Number.isSafeInteger(value.limit)
    || Number(value.limit) < 1
    || Number(value.limit) > QUERY_DTO_LIMITS.maxLimit
    || !isDecimal(value.maxBytes)
    || BigInt(value.maxBytes) < 1n
    || BigInt(value.maxBytes) > BigInt(QUERY_DTO_LIMITS.maxBytes)
    || !Number.isSafeInteger(value.deadlineEpochMs)
    || Number(value.deadlineEpochMs) < 0
    || Number(value.deadlineEpochMs) > nowEpochMs + QUERY_DTO_LIMITS.maxBudgetAheadMs) {
    return false;
  }
  if (value.maxExaminedRecords !== undefined
    && (!Number.isSafeInteger(value.maxExaminedRecords)
      || Number(value.maxExaminedRecords) < 1
      || Number(value.maxExaminedRecords) > QUERY_DTO_LIMITS.maxExaminedRecords)) return false;
  return value.maxExaminedBytes === undefined
    || (isDecimal(value.maxExaminedBytes)
      && BigInt(value.maxExaminedBytes) >= 1n
      && BigInt(value.maxExaminedBytes) <= BigInt(QUERY_DTO_LIMITS.maxExaminedBytes));
}

function isCancellation(value: unknown): value is QueryCancellationV1 {
  return isRecord(value)
    && hasOnlyKeys(value, ['requestId'])
    && isBoundedString(value.requestId, QUERY_DTO_LIMITS.maxRequestIdLength);
}

function isQueryExecutionStatus(value: unknown): value is QueryExecutionStatusV1 {
  return value === 'completed' || value === 'truncated' || value === 'cancelled'
    || value === 'stale' || value === 'unsupported' || value === 'failed';
}

function isQueryError(value: unknown): value is QueryErrorV1 {
  return isRecord(value)
    && hasOnlyKeys(value, ['code', 'recoverable'])
    && isQueryErrorCode(value.code)
    && typeof value.recoverable === 'boolean';
}

function isQueryErrorCode(value: unknown): value is QueryErrorCodeV1 {
  return value === 'invalid-request' || value === 'source-not-authorized'
    || value === 'source-changed' || value === 'cancelled'
    || value === 'deadline-exceeded' || value === 'budget-exceeded'
    || value === 'unsupported-query' || value === 'native-unavailable'
    || value === 'native-failed' || value === 'io-failed';
}

function isTruncation(value: unknown): value is QueryTruncationV1 {
  return isRecord(value)
    && hasOnlyKeys(value, ['reason', 'nextOrdinal'])
    && (value.reason === 'record_limit' || value.reason === 'byte_limit'
      || value.reason === 'time_limit' || value.reason === 'hydration_limit'
      || value.reason === 'uninspectable_record' || value.reason === 'page-limit'
      || value.reason === 'max-bytes')
    && (value.nextOrdinal === undefined || isDecimal(value.nextOrdinal));
}

function isRowSort(value: unknown): value is RowSort {
  return isRecord(value)
    && isBoundedString(value.columnId, QUERY_DTO_LIMITS.maxDocumentIdLength)
    && (value.direction === 'asc' || value.direction === 'desc');
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= QUERY_DTO_LIMITS.maxDecimalLength
    && /^(0|[1-9][0-9]*)$/.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
