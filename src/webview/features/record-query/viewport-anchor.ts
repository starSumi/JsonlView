import type { RecordRef, RowProjection, RowSort } from '../../../shared/types';

export const GRID_ROW_HEIGHT = 30;
export const GRID_HEADER_HEIGHT = 30;

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
): ViewportAnchor | undefined {
  if (!Number.isFinite(scrollTop) || rows.length === 0) return undefined;
  const top = Math.max(0, scrollTop);
  const index = Math.min(rows.length - 1, Math.floor(top / GRID_ROW_HEIGHT));
  const row = rows[index];
  return row ? { sessionId, ref: row.ref, offset: Math.min(GRID_ROW_HEIGHT - 1, top - index * GRID_ROW_HEIGHT) } : undefined;
}

export function resolveViewportAnchor(
  anchor: ViewportAnchor | undefined,
  sessionId: string,
  rows: readonly RowProjection[],
): { scrollTop: number; anchor: ViewportAnchor } | undefined {
  if (!anchor || anchor.sessionId !== sessionId) return undefined;
  const key = physicalRowKey(anchor.ref);
  const index = rows.findIndex((row) => physicalRowKey(row.ref) === key);
  const row = rows[index];
  return row ? { scrollTop: index * GRID_ROW_HEIGHT + anchor.offset, anchor: { ...anchor, ref: row.ref } } : undefined;
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

export function isRowVisible(index: number, scrollTop: number, clientHeight: number): boolean {
  if (index < 0 || !Number.isFinite(scrollTop) || clientHeight < GRID_HEADER_HEIGHT + GRID_ROW_HEIGHT) return false;
  const top = GRID_HEADER_HEIGHT + index * GRID_ROW_HEIGHT;
  return top >= scrollTop + GRID_HEADER_HEIGHT - 1
    && top + GRID_ROW_HEIGHT <= scrollTop + clientHeight + 1;
}
