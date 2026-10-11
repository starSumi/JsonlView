import type { ProblemPage, RowScanBudget } from '../../shared/types';

export const PROBLEM_PAGE_MAX_LIMIT = 200;

/** Request owned by the problem-page application use case. */
export interface ProblemPageRequest {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  limit: number;
  scanBudget?: RowScanBudget;
}

/** Read-only port implemented by the current session adapter. */
export interface ProblemPageReader {
  getProblems(request: ProblemPageRequest, signal: AbortSignal): Promise<ProblemPage>;
}

/**
 * Enforce invariants independently of the transport caller. The wire validator
 * remains responsible for decoding unknown input; this boundary protects any
 * future host or test caller that invokes the use case directly.
 */
export function assertProblemPageRequest(request: ProblemPageRequest): void {
  if (!isObject(request)) fail('Problem page request must be an object.');
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > PROBLEM_PAGE_MAX_LIMIT) {
    fail(`Problem page limit must be between 1 and ${String(PROBLEM_PAGE_MAX_LIMIT)}.`);
  }
  if (request.anchorOrdinal !== undefined && !isDecimalString(request.anchorOrdinal)) {
    fail('Problem page anchor must be a non-negative decimal string.');
  }
  if (request.direction !== undefined && request.direction !== 'forward' && request.direction !== 'backward') {
    fail('Problem page direction is invalid.');
  }
  if (request.scanBudget !== undefined && !isScanBudget(request.scanBudget)) {
    fail('Problem page scan budget is invalid or over budget.');
  }
}

function isScanBudget(value: RowScanBudget): boolean {
  if (!isObject(value)) return false;
  const hasRecords = value.maxExaminedRecords !== undefined;
  const hasBytes = value.maxExaminedBytes !== undefined;
  const hasDeadline = value.deadlineEpochMs !== undefined;
  if (!hasRecords && !hasBytes && !hasDeadline) return false;
  if (hasRecords && (!Number.isSafeInteger(value.maxExaminedRecords)
    || Number(value.maxExaminedRecords) < 1 || Number(value.maxExaminedRecords) > 1_000_000)) return false;
  if (hasBytes) {
    let bytes: bigint;
    try {
      bytes = typeof value.maxExaminedBytes === 'bigint'
        ? value.maxExaminedBytes
        : isDecimalString(value.maxExaminedBytes) ? BigInt(value.maxExaminedBytes) : -1n;
    } catch {
      return false;
    }
    if (bytes < 1n || bytes > 512n * 1024n * 1024n) return false;
  }
  if (hasDeadline && (!Number.isSafeInteger(value.deadlineEpochMs)
    || Number(value.deadlineEpochMs) < 0 || Number(value.deadlineEpochMs) > Date.now() + 60_000)) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function fail(message: string): never {
  throw new ProblemPageRequestError(message);
}

export class ProblemPageRequestError extends Error {
  public readonly code = 'INVALID_ARGUMENT' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'ProblemPageRequestError';
  }
}
