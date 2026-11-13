import type { RowFilter } from '@shared/types';

export const MAX_QUERY_HISTORY_ENTRIES = 10;
const MAX_QUERY_LENGTH = 1_024;
const MAX_FILTER_PATH_LENGTH = 256;
const MAX_FILTER_VALUE_LENGTH = 512;
const MAX_ENTRY_BYTES = 4_096;

export interface QueryHistoryEntry {
  readonly id: string;
  readonly query: string;
  readonly filters: readonly RowFilter[];
  readonly label: string;
}

function stableFilter(filter: RowFilter): RowFilter {
  return {
    columnId: filter.columnId.slice(0, MAX_FILTER_PATH_LENGTH),
    operator: filter.operator,
    ...(filter.value === undefined ? {} : {
      value: typeof filter.value === 'string' ? filter.value.slice(0, MAX_FILTER_VALUE_LENGTH) : filter.value,
    }),
    ...(filter.caseSensitive === undefined ? {} : { caseSensitive: filter.caseSensitive }),
    ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    ...(filter.source === undefined ? {} : { source: filter.source }),
    ...(filter.path === undefined ? {} : {
      path: { tokens: filter.path.tokens.slice(0, 64).map((token) => ({
        kind: token.kind,
        value: typeof token.value === 'string' ? token.value.slice(0, MAX_FILTER_PATH_LENGTH) : token.value,
      })) },
    }),
  };
}

function canonicalEntry(query: string, filters: readonly RowFilter[]): string {
  return JSON.stringify({
    query: query.slice(0, MAX_QUERY_LENGTH),
    filters: filters.map(stableFilter),
  });
}

function compareCanonical(left: RowFilter, right: RowFilter): number {
  const leftKey = JSON.stringify(left);
  const rightKey = JSON.stringify(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

export function addQueryHistory(
  current: readonly QueryHistoryEntry[],
  query: string,
  filters: readonly RowFilter[],
): readonly QueryHistoryEntry[] {
  const normalizedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  const normalizedFilters = filters.map(stableFilter).slice(0, 16)
    .sort(compareCanonical);
  if (normalizedQuery.trim() === '' && normalizedFilters.length === 0) return current;
  const canonical = canonicalEntry(normalizedQuery, normalizedFilters);
  if (new TextEncoder().encode(canonical).byteLength > MAX_ENTRY_BYTES) return current;
  const entry: QueryHistoryEntry = {
    id: hash(canonical),
    query: normalizedQuery,
    filters: normalizedFilters,
    label: normalizedQuery.trim() || `${normalizedFilters.length} field filter${normalizedFilters.length === 1 ? '' : 's'}`,
  };
  return [entry, ...current.filter((candidate) => candidate.id !== entry.id)].slice(0, MAX_QUERY_HISTORY_ENTRIES);
}
