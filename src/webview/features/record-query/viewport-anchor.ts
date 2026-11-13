import type { RecordRef, RowProjection, RowSort } from '@shared/types';

export const GRID_ROW_HEIGHT = 30;
export const GRID_HEADER_HEIGHT = 30;

export function rowHeight(index: number, heights?: readonly number[]): number {
  return heights?.[index] ?? GRID_ROW_HEIGHT;
}

export function rowOffset(index: number, heights?: readonly number[]): number {
  if (!heights) return index * GRID_ROW_HEIGHT;
  let offset = 0;
  for (let current = 0; current < index; current++) offset += rowHeight(current, heights);
  return offset;
}

export interface ViewportAnchor {
  sessionId: string;
  ref: RecordRef;
  offset: number;
}

// Append generations may change while the physical record remains the same.
export function physicalRowKey(ref: RecordRef): string {
  return JSON.stringify([ref.ordinal, ref.byteStart, ref.byteEndExclusive,
    ref.contentByteLength, ref.delimiterByteLength]);
}

export function captureViewportAnchor(
  sessionId: string,
  rows: readonly RowProjection[],
  scrollTop: number,
  heights?: readonly number[],
): ViewportAnchor | undefined {
  if (!Number.isFinite(scrollTop) || rows.length === 0) return undefined;
  const top = Math.max(0, scrollTop);
  let index = 0;
  let offset = 0;
  while (index < rows.length - 1 && offset + rowHeight(index, heights) <= top) {
    offset += rowHeight(index, heights);
    index++;
  }
  const row = rows[index];
  return row ? { sessionId, ref: row.ref, offset: Math.min(rowHeight(index, heights) - 1, top - offset) } : undefined;
}

export function resolveViewportAnchor(
  anchor: ViewportAnchor | undefined,
  sessionId: string,
  rows: readonly RowProjection[],
  heights?: readonly number[],
): { scrollTop: number; anchor: ViewportAnchor } | undefined {
  if (!anchor || anchor.sessionId !== sessionId) return undefined;
  const key = physicalRowKey(anchor.ref);
  const index = rows.findIndex((row) => physicalRowKey(row.ref) === key);
  const row = rows[index];
  const offset = Math.min(anchor.offset, rowHeight(index, heights) - 1);
  return row ? { scrollTop: rowOffset(index, heights) + offset, anchor: { ...anchor, offset, ref: row.ref } } : undefined;
}

export function latestRowIndex(
  rows: readonly RowProjection[],
  latestGeneration: string | undefined,
  latestSeq: string | undefined,
  sort: RowSort | undefined,
): number {
  if (!latestGeneration || !latestSeq || !/^\d+$/.test(latestSeq)
    || (sort && sort.columnId !== '__ordinal')) return -1;
  const count = BigInt(latestSeq);
  if (count === 0n || rows.length === 0) return -1;
  const index = sort?.direction === 'desc' ? 0 : rows.length - 1;
  const ref = rows[index]?.ref;
  return ref?.generation === latestGeneration && ref.ordinal === (count - 1n).toString() ? index : -1;
}

export function isRowVisible(index: number, scrollTop: number, clientHeight: number, heights?: readonly number[]): boolean {
  const height = rowHeight(index, heights);
  if (index < 0 || !Number.isFinite(scrollTop) || clientHeight < GRID_HEADER_HEIGHT + height) return false;
  const top = GRID_HEADER_HEIGHT + rowOffset(index, heights);
  return top >= scrollTop + GRID_HEADER_HEIGHT - 1
    && top + height <= scrollTop + clientHeight + 1;
}
