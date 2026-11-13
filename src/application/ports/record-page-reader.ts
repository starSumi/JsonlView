import type {
  ColumnSpec,
  Predicate,
  RowPage,
  RowProjectionPlan,
  RowScanBudget,
  RowSort,
} from '@shared/types';
import { isRowProjectionPlan } from '@shared/row-projection';

export const RECORD_PAGE_MAX_LIMIT = 500;
export const RECORD_PAGE_MAX_SORT_WINDOW = 2_048n;
export const RECORD_PAGE_MAX_SCAN_RECORDS = 1_000_000;
export const RECORD_PAGE_MAX_SCAN_BYTES = 512n * 1024n * 1024n;
export const RECORD_PAGE_MAX_RESULT_BYTES = 512n * 1024n * 1024n;
export const RECORD_PAGE_MAX_SCAN_AHEAD_MS = 60_000;

export type RecordPageQueueBlocker =
  | 'none'
  | 'index_more'
  | 'finish_indexing'
  | 'get_rows'
  | 'inspect_rows'
  | 'get_problems'
  | 'get_detail'
  | 'get_schema'
  | 'classify_refresh';

/** Internal timing side channel; it is not part of the Webview query DTO or ROWS page. */
export interface RecordPageExecutionTiming {
  readonly queueWaitMs: number;
  readonly engineExecMs: number;
  readonly queueBlockedBy: RecordPageQueueBlocker;
  readonly indexWorkMs: number;
  readonly readWaitMs: number;
  /** Optional complete diagnostics group; older in-process readers may omit all three. */
  readonly readCalls?: number;
  readonly readBytes?: number;
  readonly readMaxWaitMs?: number;
  readonly parseMs: number;
  readonly projectionMs: number;
  readonly snapshotCheckMs: number;
}

export type RecordPageTimingObserver = (timing: RecordPageExecutionTiming) => void;

/** Request owned by the record-page application use case, independent of VS Code transport. */
export interface RecordPageRequest {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  limit: number;
  predicate?: Predicate;
  columns?: ColumnSpec[];
  projection?: RowProjectionPlan;
  /** Maximum UTF-8 bytes retained in the returned page. */
  maxReturnedBytes?: string;
  sort?: RowSort;
  sortOffset?: string;
  scanBudget?: RowScanBudget;
  /** Host-local diagnostics only; omitted from versioned query and Webview payloads. */
  onTiming?: RecordPageTimingObserver;
}

/** Read-only port implemented by the current session adapter. */
export interface RecordPageReader {
  getRows(request: RecordPageRequest, signal: AbortSignal): Promise<RowPage>;
}

/**
 * Enforce invariants that apply to every application caller, including callers
 * that do not arrive through the Webview envelope validator. Predicate shape
 * remains owned by the transport and engine because it is a shared AST.
 */
export function assertRecordPageRequest(request: RecordPageRequest): void {
  if (!isObject(request)) fail('Record page request must be an object.');
  if (request.onTiming !== undefined && typeof request.onTiming !== 'function') {
    fail('Record page timing observer must be a function.');
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > RECORD_PAGE_MAX_LIMIT) {
    fail(`Record page limit must be between 1 and ${String(RECORD_PAGE_MAX_LIMIT)}.`);
  }
  if (request.anchorOrdinal !== undefined && !isDecimalString(request.anchorOrdinal)) {
    fail('Record page anchor must be a non-negative decimal string.');
  }
  if (request.direction !== undefined && request.direction !== 'forward' && request.direction !== 'backward') {
    fail('Record page direction is invalid.');
  }
  if (request.sort !== undefined && !isRowSort(request.sort)) {
    fail('Record page sort is invalid.');
  }
  if (request.sort !== undefined && (request.anchorOrdinal !== undefined || request.direction !== undefined)
    && ((request.sort.columnId !== '__ordinal' && request.sort.columnId !== '$ordinal')
      || request.sortOffset !== undefined)) {
    fail('Physical cursors require ordinal order and cannot include a sorted offset.');
  }
  if (request.sortOffset !== undefined && !isDecimalString(request.sortOffset)) {
    fail('Record page sort offset must be a non-negative decimal string.');
  }
  if (request.sortOffset !== undefined && request.sort === undefined) {
    fail('Record page sort offset requires a sort descriptor.');
  }
  if (request.sortOffset !== undefined && request.sort !== undefined
    && request.sort.columnId !== '__ordinal' && request.sort.columnId !== '$ordinal'
    && BigInt(request.sortOffset) + BigInt(request.limit) > RECORD_PAGE_MAX_SORT_WINDOW) {
    fail('Record page sort offset plus limit is outside the bounded result window.');
  }
  if (request.columns !== undefined && !isColumns(request.columns)) {
    fail('Record page columns are invalid or over budget.');
  }
  if (request.projection !== undefined && !isRowProjectionPlan(request.projection)) {
    fail('Record page projection plan is invalid.');
  }
  if (request.maxReturnedBytes !== undefined && !isDecimalString(request.maxReturnedBytes)) {
    fail('Record page result byte budget is invalid.');
  }
  if (request.maxReturnedBytes !== undefined && (BigInt(request.maxReturnedBytes) < 1n
    || BigInt(request.maxReturnedBytes) > RECORD_PAGE_MAX_RESULT_BYTES)) {
    fail('Record page result byte budget is outside the bounded result window.');
  }
  if (request.scanBudget !== undefined && !isScanBudget(request.scanBudget)) {
    fail('Record page scan budget is invalid or over budget.');
  }
}

function isRowSort(value: RowSort): boolean {
  return isObject(value)
    && isBoundedString(value.columnId, 256)
    && (value.direction === 'asc' || value.direction === 'desc');
}

function isColumns(value: unknown): value is ColumnSpec[] {
  return Array.isArray(value) && value.length <= 64 && value.every((column: unknown) => (
    isObject(column)
    && isBoundedString(column.id, 256)
    && isBoundedString(column.label, 256)
    && (column.source === 'record' || column.source === 'profile' || column.source === 'system')
    && (column.width === undefined
      || (typeof column.width === 'number'
        && Number.isFinite(column.width)
        && column.width >= 1
        && column.width <= 2_000))
  ));
}

function isScanBudget(value: RowScanBudget): boolean {
  if (!isObject(value)) return false;
  const maxExaminedRecords = value.maxExaminedRecords;
  const maxExaminedBytes = value.maxExaminedBytes;
  const deadlineEpochMs = value.deadlineEpochMs;
  const hasRecords = maxExaminedRecords !== undefined;
  const hasBytes = maxExaminedBytes !== undefined;
  const hasDeadline = deadlineEpochMs !== undefined;
  if (!hasRecords && !hasBytes && !hasDeadline) return false;
  if (hasRecords && (!Number.isSafeInteger(maxExaminedRecords)
    || Number(maxExaminedRecords) < 1 || Number(maxExaminedRecords) > RECORD_PAGE_MAX_SCAN_RECORDS)) return false;
  if (hasBytes) {
    let bytes: bigint;
    try {
      bytes = typeof maxExaminedBytes === 'bigint'
        ? maxExaminedBytes
        : isDecimalString(maxExaminedBytes) ? BigInt(maxExaminedBytes) : -1n;
    } catch {
      return false;
    }
    if (bytes < 1n || bytes > RECORD_PAGE_MAX_SCAN_BYTES) return false;
  }
  if (hasDeadline && (!Number.isSafeInteger(deadlineEpochMs)
    || Number(deadlineEpochMs) < 0 || Number(deadlineEpochMs) > Date.now() + RECORD_PAGE_MAX_SCAN_AHEAD_MS)) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function fail(message: string): never {
  throw new RecordPageRequestError(message);
}

export class RecordPageRequestError extends Error {
  public readonly code = 'INVALID_ARGUMENT' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'RecordPageRequestError';
  }
}
