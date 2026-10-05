import type {
  ColumnSpec,
  FieldStats,
  JsonKind,
  Predicate,
  RowFilter,
  RowFilterOperator,
  RowScanBudget,
  RowSort,
  ScanTruncationReason,
  WebviewRequest,
} from '../../../shared/types';
import { MAX_TABLE_COLUMNS } from '../../../shared/types';
import { schemaRecordColumns } from '../../format';
import { combinePredicates, parseFilterLiteral, predicateForFilter } from '../../query';

export const SORT_WINDOW_LIMIT = 2_048n;
export const SCHEMA_PAGE_SIZE = 250;

const FILTER_SCAN_MAX_RECORDS = 100_000;
const FILTER_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const FILTER_SCAN_MAX_MILLISECONDS = 5_000;

export type RowsRequestPayload = Extract<WebviewRequest, { type: 'GET_ROWS' }>['payload'];

export interface RecordQueryRequestOptions {
  limit: number;
  query?: string;
  filter?: RowFilter;
  filterColumns: readonly ColumnSpec[];
  columns?: readonly ColumnSpec[];
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  sort?: RowSort;
  sortOffset?: string;
  now?: number;
}

export interface StructuredFilterDraft {
  columnId: string;
  operator: RowFilterOperator;
  value: string;
  caseSensitive: boolean;
  selectedColumn?: ColumnSpec | undefined;
  filterColumns: readonly ColumnSpec[];
}

export function recordColumnCandidates(columns: readonly ColumnSpec[], schema: readonly FieldStats[]): ColumnSpec[] {
  const candidates = new Map<string, ColumnSpec>();
  for (const column of columns) {
    if (column.source === 'record' && column.path !== undefined
      && column.id === JSON.stringify(column.path.tokens)) candidates.set(column.id, column);
  }
  for (const column of schemaRecordColumns(schema, SCHEMA_PAGE_SIZE)) {
    if (!candidates.has(column.id)) candidates.set(column.id, column);
  }
  return [...candidates.values()];
}

export function recordColumnOptions(columns: readonly ColumnSpec[], schema: readonly FieldStats[]): ColumnSpec[] {
  return [
    ...columns.filter((column) => column.id !== '__ordinal' && column.id !== '$ordinal' && column.source !== 'record'),
    ...recordColumnCandidates(columns, schema),
  ];
}

export function selectedRecordColumns(
  columns: readonly ColumnSpec[],
  schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>>,
): ColumnSpec[] | undefined {
  const currentRecords = new Set(columns.filter((column) => column.source === 'record').map((column) => column.id));
  const candidates = recordColumnCandidates(columns, schema);
  if (candidates.length === 0) return undefined;
  // Schema may arrive before the initial row projection. No record selection
  // exists yet in that state; sending [] would hide the engine's defaults.
  // Explicit false selections still represent the user's all-hidden choice.
  if (currentRecords.size === 0
    && !candidates.some((column) => visibility[column.id] !== undefined)) return undefined;
  const profileCount = columns.filter((column) => column.source === 'profile').length;
  return candidates.filter((column) => visibility[column.id] === true
    || (visibility[column.id] !== false && currentRecords.has(column.id)))
    .slice(0, Math.max(0, MAX_TABLE_COLUMNS - profileCount));
}

export function buildStructuredFilter(draft: StructuredFilterDraft): RowFilter | undefined {
  if (!draft.columnId) return undefined;
  const needsValue = draft.operator !== 'exists' && draft.operator !== 'is_null';
  const kindValue = draft.value.trim();
  const filterBase: RowFilter = {
    columnId: draft.columnId,
    operator: draft.operator,
    ...(draft.selectedColumn?.source === 'profile'
      ? { source: 'profile' as const }
      : draft.selectedColumn?.path === undefined
        ? {}
        : { source: 'record' as const, path: draft.selectedColumn.path }),
    ...(needsValue ? { value: parseFilterLiteral(draft.value) } : {}),
    ...(draft.operator === 'contains' || draft.operator === 'starts_with' || draft.operator === 'ends_with'
      ? { caseSensitive: draft.caseSensitive }
      : {}),
  };
  const filter: RowFilter = draft.operator === 'kind_is' && kindValue.length > 0
    ? { ...filterBase, kind: kindValue as JsonKind }
    : filterBase;
  return predicateForFilter(filter, draft.filterColumns) === undefined ? undefined : filter;
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
    ...(options.columns === undefined ? {} : { columns: [...options.columns] }),
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
