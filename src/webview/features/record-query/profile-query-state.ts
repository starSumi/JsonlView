import type { ColumnSpec, RowFilter, RowSort } from '@shared/types';

export interface ReconciledProfileQueryState {
  sort?: RowSort;
  filter?: RowFilter;
}

function isOrdinalColumn(columnId: string): boolean {
  return columnId === '__ordinal' || columnId === '$ordinal';
}

function isEncodedRecordColumnId(columnId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(columnId);
    return Array.isArray(parsed) && parsed.length <= 32 && parsed.every((token) => {
      if (token === null || typeof token !== 'object' || Array.isArray(token)) return false;
      const candidate = token as Record<string, unknown>;
      return (candidate.kind === 'key' && typeof candidate.value === 'string')
        || (candidate.kind === 'index' && typeof candidate.value === 'number'
          && Number.isSafeInteger(candidate.value) && candidate.value >= 0);
    });
  } catch {
    return false;
  }
}

/**
 * Keep query state only when its column keeps the same meaning after a profile
 * switch. Record paths remain valid unless the new profile shadows the id;
 * profile fields must be explicitly present in the new profile columns.
 */
export function reconcileProfileQueryState(
  sort: RowSort | undefined,
  filter: RowFilter | undefined,
  currentColumns: readonly ColumnSpec[],
  nextColumns: readonly ColumnSpec[],
): ReconciledProfileQueryState {
  const currentById = new Map(currentColumns.map((column) => [column.id, column]));
  const nextById = new Map(nextColumns.map((column) => [column.id, column]));

  let nextSort: RowSort | undefined;
  if (sort !== undefined) {
    if (isOrdinalColumn(sort.columnId)) {
      nextSort = sort;
    } else {
      const currentColumn = currentById.get(sort.columnId);
      const nextColumn = nextById.get(sort.columnId);
      if (currentColumn?.source === 'record') {
        if (nextColumn === undefined || nextColumn.source === 'record') nextSort = sort;
      } else if (currentColumn !== undefined) {
        if (nextColumn?.source === currentColumn.source) nextSort = sort;
      } else if (nextColumn !== undefined || isEncodedRecordColumnId(sort.columnId)) {
        nextSort = sort;
      }
    }
  }

  let nextFilter: RowFilter | undefined;
  if (filter !== undefined) {
    const currentColumn = currentById.get(filter.columnId);
    const nextColumn = nextById.get(filter.columnId);
    const source = filter.source ?? currentColumn?.source;
    if (source === 'record') {
      if (nextColumn === undefined || nextColumn.source === 'record') nextFilter = filter;
    } else if (source === 'profile') {
      if (nextColumn?.source === 'profile') nextFilter = filter;
    } else if (currentColumn !== undefined) {
      if (nextColumn?.source === currentColumn.source) nextFilter = filter;
    } else if (nextColumn !== undefined) {
      nextFilter = filter;
    }
  }

  return {
    ...(nextSort === undefined ? {} : { sort: nextSort }),
    ...(nextFilter === undefined ? {} : { filter: nextFilter }),
  };
}
