import type {
  ColumnSpec,
  Predicate,
  RowFilter,
  RowScanBudget,
  RowSort,
  ScanTruncationReason,
  WebviewRequest,
} from '../../../shared/types';
import { combinePredicates, predicateForFilter } from '../../query';

export const SORT_WINDOW_LIMIT = 2_048n;

const FILTER_SCAN_MAX_RECORDS = 100_000;
const FILTER_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const FILTER_SCAN_MAX_MILLISECONDS = 5_000;

export type RowsRequestPayload = Extract<WebviewRequest, { type: 'GET_ROWS' }>['payload'];

export interface RecordQueryRequestOptions {
  limit: number;
  query?: string;
  filter?: RowFilter;
  filterColumns: readonly ColumnSpec[];
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  sort?: RowSort;
  sortOffset?: string;
  now?: number;
}

export function textPredicate(query: string): Predicate | undefined {
  const value = query.trim();
  return value ? { op: 'text_search', value, caseSensitive: false } : undefined;
}

export function createFilterScanBudget(now = Date.now()): RowScanBudget {
  return {
    maxExaminedRecords: FILTER_SCAN_MAX_RECORDS,
    maxExaminedBytes: String(FILTER_SCAN_MAX_BYTES),
    deadlineEpochMs: now + FILTER_SCAN_MAX_MILLISECONDS,
  };
}

export function isPhysicalOrdinalSort(sort: RowSort | undefined): boolean {
  return sort?.columnId === '__ordinal' || sort?.columnId === '$ordinal';
}

export function canRequestSortedPage(
  sort: RowSort | undefined,
  offset: bigint,
  pageSize: number,
): boolean {
  return isPhysicalOrdinalSort(sort) || offset + BigInt(pageSize) <= SORT_WINDOW_LIMIT;
}

export function buildRecordQueryRequest(options: RecordQueryRequestOptions): RowsRequestPayload {
  const predicate = combinePredicates(
    textPredicate(options.query ?? ''),
    predicateForFilter(options.filter, options.filterColumns),
  );
  const sort = options.sort;
  return {
    limit: options.limit,
    ...(sort === undefined && options.anchorOrdinal ? { anchorOrdinal: options.anchorOrdinal } : {}),
    ...(sort === undefined && options.direction ? { direction: options.direction } : {}),
    ...(predicate ? { predicate, scanBudget: createFilterScanBudget(options.now) } : {}),
    ...(sort === undefined ? {} : { sort }),
    ...(sort === undefined || options.sortOffset === undefined ? {} : { sortOffset: options.sortOffset }),
  };
}

export function formatScanLimit(reason: ScanTruncationReason): string {
  switch (reason) {
    case 'record_limit': return 'record limit';
    case 'byte_limit': return 'byte limit';
    case 'time_limit': return 'time limit';
    case 'hydration_limit': return 'page hydration limit';
    case 'uninspectable_record': return 'uninspectable record';
    default: return 'scan limit';
  }
}
