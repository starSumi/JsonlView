import type {
  ColumnSpec,
  FieldStats,
  FieldPath,
  JsonKind,
  RowFilter,
  RowFilterOperator,
  RowScanBudget,
  RowSort,
  RowProjectionPlan,
  ScanTruncationReason,
  WebviewRequest,
} from '@shared/types';
import { MAX_TABLE_COLUMNS } from '@shared/types';
import { recordColumnForPath, schemaRecordColumns } from '@webview/format';
import { parseFilterLiteral, predicateForFilter } from '@webview/query';
import type { RowTypeSelection } from './query-selection';
import { compileQueryCondition } from './query-condition';

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
  filters?: readonly RowFilter[];
  rowTypes?: RowTypeSelection;
  filterColumns: readonly ColumnSpec[];
  columns?: readonly ColumnSpec[];
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  sort?: RowSort;
  sortOffset?: string;
  scanBudget?: RowScanBudget;
  projection?: RowProjectionPlan;
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

function savedRecordColumn(id: string): ColumnSpec | undefined {
  if (id.length > 256) return undefined;
  try {
    const tokens: unknown = JSON.parse(id);
    if (!Array.isArray(tokens)) return undefined;
    const column = recordColumnForPath({ tokens } as FieldPath);
    return column?.id === id ? column : undefined;
  } catch {
    // Profile ids and malformed saved values are not record fields.
    return undefined;
  }
}

export function recordColumnCandidates(columns: readonly ColumnSpec[], schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>> = {}): ColumnSpec[] {
  const candidates = new Map<string, ColumnSpec>();
  for (const column of columns) {
    if (column.source === 'record' && column.path !== undefined
      && recordColumnForPath(column.path, column.label)?.id === column.id) candidates.set(column.id, column);
  }
  for (const column of schemaRecordColumns(schema, SCHEMA_PAGE_SIZE)) {
    if (!candidates.has(column.id)) candidates.set(column.id, column);
  }
  // A saved explicit field must not depend on its path appearing in a bounded
  // schema page. Only canonical encoded paths can restore record columns.
  for (const [id, visible] of Object.entries(visibility)) {
    if (visible !== true || candidates.has(id)) continue;
    const column = savedRecordColumn(id);
    if (column !== undefined) candidates.set(id, column);
  }
  return [...candidates.values()];
}

export function recordColumnOptions(columns: readonly ColumnSpec[], schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>> = {}): ColumnSpec[] {
  return [
    ...columns.filter((column) => column.id !== '__ordinal' && column.id !== '$ordinal' && column.source !== 'record'),
    ...recordColumnCandidates(columns, schema, visibility),
  ];
}

/** Keep configured intent available to the chooser, including projection overflow. */
export function configuredRecordColumns(
  columns: readonly ColumnSpec[],
  schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>>,
): ColumnSpec[] | undefined {
  const currentRecords = new Set(columns.filter((column) => column.source === 'record').map((column) => column.id));
  const candidates = recordColumnCandidates(columns, schema, visibility);
  if (candidates.length === 0) {
    return Object.entries(visibility).some(([id, visible]) => visible === false && savedRecordColumn(id) !== undefined)
      ? [] : undefined;
  }
  // Schema may arrive before the initial row projection. No record selection
  // exists yet in that state; sending [] would hide the engine's defaults.
  // Explicit false selections still represent the user's all-hidden choice.
  if (currentRecords.size === 0
    && !candidates.some((column) => visibility[column.id] !== undefined)
    && !Object.entries(visibility).some(([id, visible]) => visible === false && savedRecordColumn(id) !== undefined)) return undefined;
  return candidates.filter((column) => visibility[column.id] === true
    || (visibility[column.id] !== false && currentRecords.has(column.id)));
}

export function selectedRecordColumns(
  columns: readonly ColumnSpec[],
  schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>>,
): ColumnSpec[] | undefined {
  const profileCount = columns.filter((column) => column.source === 'profile').length;
  return configuredRecordColumns(columns, schema, visibility)
    ?.slice(0, Math.max(0, MAX_TABLE_COLUMNS - profileCount));
}

/** Replace semantic columns while retaining only selected record projections. */
export function columnsAfterProfileChange(current: readonly ColumnSpec[], next: readonly ColumnSpec[],
  visibility: Readonly<Record<string, boolean>>): ColumnSpec[] {
  const records = configuredRecordColumns(current, [], visibility) ?? [];
  const candidates = new Map(next.map((column) => [column.id, column]));
  for (const column of records) if (!candidates.has(column.id)) candidates.set(column.id, column);
  return [...candidates.values()].slice(0, MAX_TABLE_COLUMNS);
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
    ...(needsValue ? { value: draft.operator === 'contains' || draft.operator === 'starts_with' || draft.operator === 'ends_with'
      ? draft.value : parseFilterLiteral(draft.value) } : {}),
    ...(draft.operator === 'contains' || draft.operator === 'starts_with' || draft.operator === 'ends_with'
      ? { caseSensitive: draft.caseSensitive }
      : {}),
  };
  const filter: RowFilter = draft.operator === 'kind_is' && kindValue.length > 0
    ? { ...filterBase, kind: kindValue as JsonKind }
    : filterBase;
  return predicateForFilter(filter, draft.filterColumns) === undefined ? undefined : filter;
}

export function createFilterScanBudget(now = Date.now()): Required<RowScanBudget> {
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
  const predicate = compileQueryCondition({
    query: options.query ?? '',
    filters: options.filters ?? (options.filter === undefined ? [] : [options.filter]),
    ...(options.rowTypes === undefined ? {} : { rowTypes: options.rowTypes }),
    filterColumns: options.filterColumns,
  });
  const sort = options.sort;
  const physicalCursor = sort === undefined || (isPhysicalOrdinalSort(sort)
    && (options.anchorOrdinal !== undefined || options.direction !== undefined));
  return {
    limit: options.limit,
    ...(physicalCursor && options.anchorOrdinal !== undefined ? { anchorOrdinal: options.anchorOrdinal } : {}),
    ...(physicalCursor && options.direction !== undefined ? { direction: options.direction } : {}),
    ...(predicate ? { predicate } : {}),
    ...(options.scanBudget === undefined
      ? predicate ? { scanBudget: createFilterScanBudget(options.now) } : {}
      : { scanBudget: options.scanBudget }),
    ...(options.columns === undefined ? {} : { columns: [...options.columns] }),
    ...(options.projection === undefined ? {} : { projection: { ...options.projection } }),
    ...(sort === undefined ? {} : { sort }),
    ...(sort === undefined || physicalCursor || options.sortOffset === undefined ? {} : { sortOffset: options.sortOffset }),
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
