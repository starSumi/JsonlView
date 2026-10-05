import type { AgentRowProjection, ColumnSpec, PathToken, RowSort } from '../shared/types';
import { JsonlEngineError } from './errors';
import { jsonKindOf, resolveFieldPath } from './predicate';

interface SortCandidate {
  internal: { ordinal: bigint };
  key: unknown;
}

export function normalizeRowSort(value: RowSort | undefined): RowSort | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value.columnId !== 'string'
    || value.columnId.length === 0
    || value.columnId.length > 256
    || (value.direction !== 'asc' && value.direction !== 'desc')
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'sort must contain a bounded columnId and asc/desc direction.');
  }
  return { columnId: value.columnId, direction: value.direction };
}

export function isOrdinalSort(sort: RowSort): boolean {
  return sort.columnId === '__ordinal' || sort.columnId === '$ordinal';
}

export function sortValueForColumn(
  hydrated: { internal: { ordinal: bigint }; value?: unknown },
  column: ColumnSpec,
  profile: AgentRowProjection | undefined,
): unknown {
  if (column.source === 'system' || column.id === '__ordinal' || column.id === '$ordinal') {
    return hydrated.internal.ordinal;
  }
  if (column.source === 'profile') {
    if (profile === undefined) return undefined;
    if (Object.hasOwn(profile, column.id)) {
      return (profile as AgentRowProjection & Record<string, unknown>)[column.id];
    }
    return profile.derivedFields?.[column.id];
  }
  if (column.path === undefined || hydrated.value === undefined) return undefined;
  const resolved = resolveFieldPath(hydrated.value, column.path);
  return resolved.exists ? resolved.value : undefined;
}

export function sortColumnFromId(id: string): ColumnSpec | undefined {
  // Generic columns use the JSON-encoded FieldPath as their stable id. A
  // plain key is accepted as a compatibility convenience for callers that do
  // not yet have a schema projection.
  try {
    const parsed: unknown = JSON.parse(id);
    if (Array.isArray(parsed) && parsed.length <= 32) {
      const tokens = parsed.flatMap((token): PathToken[] => {
        if (token === null || typeof token !== 'object' || Array.isArray(token)) return [];
        const candidate = token as Record<string, unknown>;
        if (candidate.kind === 'key') {
          return typeof candidate.value === 'string' && candidate.value.length <= 256
            ? [{ kind: 'key', value: candidate.value }]
            : [];
        }
        if (candidate.kind === 'index') {
          return typeof candidate.value === 'number'
            && Number.isSafeInteger(candidate.value)
            && candidate.value >= 0
            ? [{ kind: 'index', value: candidate.value }]
            : [];
        }
        return [];
      });
      if (tokens.length === parsed.length) {
        return { id, label: id, path: { tokens }, source: 'record' };
      }
    }
  } catch {
    // Fall through to a bounded plain-key interpretation.
  }
  if (/^[A-Za-z_$][\w$]{0,127}$/.test(id)) {
    return { id, label: id, path: { tokens: [{ kind: 'key', value: id }] }, source: 'record' };
  }
  return undefined;
}

export function insertSortCandidate<T extends SortCandidate>(
  candidates: T[],
  candidate: T,
  direction: RowSort['direction'],
  limit: number,
): void {
  const comparator = (left: SortCandidate, right: SortCandidate): number =>
    compareSortCandidates(left, right, direction);
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (comparator(candidates[middle]!, candidate) <= 0) low = middle + 1;
    else high = middle;
  }
  candidates.splice(low, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}

function compareSortCandidates(
  left: SortCandidate,
  right: SortCandidate,
  direction: RowSort['direction'],
): number {
  const valueOrder = compareSortValues(left.key, right.key, direction);
  if (valueOrder !== 0) return valueOrder;
  if (left.internal.ordinal < right.internal.ordinal) return -1;
  if (left.internal.ordinal > right.internal.ordinal) return 1;
  return 0;
}

/** Missing/null values are placed last in either direction for scan stability. */
export function compareSortValues(left: unknown, right: unknown, direction: RowSort['direction']): number {
  const leftMissing = left === undefined || left === null;
  const rightMissing = right === undefined || right === null;
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    // Keep null/missing values at the end for both directions. This branch is
    // deliberately resolved before applying the asc/desc inversion below;
    // otherwise descending order would move them to the front.
    return leftMissing ? 1 : -1;
  }
  let result: number;
  if (typeof left === 'number' && typeof right === 'number') {
    result = left < right ? -1 : left > right ? 1 : 0;
  } else if (typeof left === 'string' && typeof right === 'string') {
    result = left < right ? -1 : left > right ? 1 : 0;
  } else if (typeof left === 'boolean' && typeof right === 'boolean') {
    result = left === right ? 0 : left ? 1 : -1;
  } else {
    const leftKind = jsonKindOf(left);
    const rightKind = jsonKindOf(right);
    if (leftKind !== rightKind) {
      result = leftKind < rightKind ? -1 : 1;
    } else {
      const leftText = searchableSortValue(left);
      const rightText = searchableSortValue(right);
      result = leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    }
  }
  return direction === 'asc' ? result : -result;
}

function searchableSortValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
