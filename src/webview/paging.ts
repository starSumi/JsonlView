const MIN_PAGE = 1n;
const MAX_SORT_OFFSET_HISTORY = 2_048;

export interface RebuildRowsOptions {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  sortOffset?: string;
}

export interface ViewportIdentity {
  documentId: string;
  generation: string;
  epoch?: number;
  firstVisibleOrdinal?: string;
}

export interface PreviousSortOffset {
  offset: string;
  history: string[];
}

export interface SortPagePosition extends PreviousSortOffset {
  page: string;
}

function nonNegativeOffset(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  try {
    const offset = BigInt(value);
    return offset >= 0n ? offset : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeSortOffset(value: string | undefined): string {
  return (nonNegativeOffset(value) ?? 0n).toString();
}

export function pageFromSortOffset(offset: string | undefined, pageSize: number): string {
  const value = nonNegativeOffset(offset) ?? 0n;
  const size = BigInt(Math.max(1, Math.floor(pageSize)));
  return (value / size + 1n).toString();
}

export function normalizeSortPage(
  value: string | undefined,
  offset: string | undefined,
  pageSize: number,
): string {
  try {
    const page = value === undefined ? 0n : BigInt(value);
    if (page >= MIN_PAGE) return page.toString();
  } catch {
    // Fall back to the legacy offset-derived page during state migration.
  }
  return pageFromSortOffset(offset, pageSize);
}

/**
 * Sanitize the persisted back-stack and keep it bounded. Entries at or beyond
 * the current cursor cannot be predecessors, and non-increasing entries cannot
 * describe the forward path that produced the current continuation.
 */
export function normalizeSortOffsetHistory(
  values: readonly string[] | undefined,
  currentOffset?: string,
): string[] {
  if (!Array.isArray(values)) return [];
  const current = nonNegativeOffset(currentOffset);
  const normalized: string[] = [];
  let previous = -1n;
  for (const value of values) {
    const offset = nonNegativeOffset(value);
    if (offset === undefined || offset <= previous || (current !== undefined && offset >= current)) continue;
    normalized.push(offset.toString());
    previous = offset;
  }
  return normalized.slice(-MAX_SORT_OFFSET_HISTORY);
}

/** Record the actual cursor before following a potentially partial page. */
export function advanceSortOffsetHistory(
  history: readonly string[] | undefined,
  currentOffset: string,
  nextOffset: string,
): string[] {
  const current = nonNegativeOffset(currentOffset) ?? 0n;
  const next = nonNegativeOffset(nextOffset);
  if (next === undefined || next <= current) return [];
  const normalized = normalizeSortOffsetHistory(history, current.toString());
  if (normalized.at(-1) !== current.toString()) normalized.push(current.toString());
  return normalized.slice(-MAX_SORT_OFFSET_HISTORY);
}

/**
 * Pop the actual visited predecessor. A page-size fallback is used only for a
 * restored/corrupt state that has no usable cursor history.
 */
export function previousSortOffset(
  history: readonly string[] | undefined,
  currentOffset: string,
  pageSize: number,
): PreviousSortOffset {
  const current = nonNegativeOffset(currentOffset) ?? 0n;
  const normalized = normalizeSortOffsetHistory(history, current.toString());
  const predecessor = normalized.at(-1);
  if (predecessor !== undefined) {
    return { offset: predecessor, history: normalized.slice(0, -1) };
  }
  const size = BigInt(Math.max(1, Math.floor(pageSize)));
  const fallback = current > size ? current - size : 0n;
  return { offset: fallback.toString(), history: [] };
}

/** Advance the logical page independently from a partial continuation cursor. */
export function advanceSortPage(
  history: readonly string[] | undefined,
  currentOffset: string,
  currentPage: string,
  nextOffset: string,
  pageSize: number,
): SortPagePosition {
  const page = BigInt(normalizeSortPage(currentPage, currentOffset, pageSize)) + 1n;
  return {
    offset: normalizeSortOffset(nextOffset),
    history: advanceSortOffsetHistory(history, currentOffset, nextOffset),
    page: page.toString(),
  };
}

/** Return to the prior cursor and logical page as one navigation operation. */
export function previousSortPage(
  history: readonly string[] | undefined,
  currentOffset: string,
  currentPage: string,
  pageSize: number,
): SortPagePosition {
  const previous = previousSortOffset(history, currentOffset, pageSize);
  const page = BigInt(normalizeSortPage(currentPage, currentOffset, pageSize));
  return {
    ...previous,
    page: (page > MIN_PAGE ? page - 1n : MIN_PAGE).toString(),
  };
}

export function pageFromOrdinal(ordinal: string | undefined, pageSize: number): string {
  if (!ordinal) return '1';
  try {
    const value = BigInt(ordinal);
    const size = BigInt(Math.max(1, Math.floor(pageSize)));
    return (value / size + 1n).toString();
  } catch {
    return '1';
  }
}

/** Returns the exclusive cursor anchor needed to request a physical page. */
export function anchorForPage(pageText: string, pageSize: number): string | undefined {
  let page: bigint;
  try {
    page = BigInt(pageText.trim());
  } catch {
    return undefined;
  }
  if (page < MIN_PAGE) return undefined;
  if (page === MIN_PAGE) return undefined;
  const size = BigInt(Math.max(1, Math.floor(pageSize)));
  return ((page - 1n) * size - 1n).toString();
}

/**
 * Convert the first visible ordinal into the exclusive cursor immediately
 * before it. Row-page responses expose the last row as their forward anchor,
 * so a rebuild must use the predecessor of the first row to request the same
 * page again.
 */
export function anchorBeforeOrdinal(ordinal: string | undefined): string | undefined {
  if (ordinal === undefined) return undefined;
  try {
    const value = BigInt(ordinal);
    return value > 0n ? (value - 1n).toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Choose the first rows request after a generation-changing rebuild. */
export function rowsOptionsAfterRebuild(
  firstVisibleOrdinal: string | undefined,
  followMode: boolean,
): RebuildRowsOptions {
  if (followMode) return { direction: 'backward' };
  const anchorOrdinal = anchorBeforeOrdinal(firstVisibleOrdinal);
  return anchorOrdinal === undefined
    ? {}
    : { anchorOrdinal, direction: 'forward' };
}

/**
 * Build the first page request after a user-triggered rebuild. The physical
 * first-row ordinal is the strongest anchor; the visible page number is a
 * bounded fallback for the short interval where the latest row response was
 * cancelled before it could be recorded.
 */
export function rowsOptionsForViewport(
  firstVisibleOrdinal: string | undefined,
  pageText: string | undefined,
  pageSize: number,
  followMode: boolean,
  pendingOptions: RebuildRowsOptions | undefined = undefined,
): RebuildRowsOptions {
  if (followMode) return { direction: 'backward' };
  // A direct page request can still be in flight when the source changes. Its
  // exclusive anchor is a stronger expression of the user's intended page
  // than the last rendered row, which may belong to the previous page.
  if (pendingOptions !== undefined) {
    return { ...pendingOptions };
  }
  const byOrdinal = rowsOptionsAfterRebuild(firstVisibleOrdinal, false);
  if (byOrdinal.anchorOrdinal !== undefined) return byOrdinal;
  const pageAnchor = anchorForPage(pageText ?? '1', pageSize);
  return pageAnchor === undefined
    ? byOrdinal
    : { anchorOrdinal: pageAnchor, direction: 'forward' };
}

/**
 * Clamp a restored viewport after the source became shorter. A filtered view
 * uses the tail cursor so a match that still exists before the old anchor is
 * not presented as an unexplained blank page.
 */
export function rowsOptionsAfterEmptyRebuild(
  firstVisibleOrdinal: string | undefined,
  pageText: string | undefined,
  pageSize: number,
  totalRecords: string | undefined,
  query = '',
  sortOffset?: string,
  matchedRecords?: string,
  scanTruncated = false,
): RebuildRowsOptions | undefined {
  if (sortOffset !== undefined) {
    if (scanTruncated || matchedRecords === undefined) return undefined;
    let offset: bigint;
    let matched: bigint;
    try {
      offset = BigInt(sortOffset);
      matched = BigInt(matchedRecords);
    } catch {
      return undefined;
    }
    if (offset < 0n || matched < 0n) return undefined;
    const size = BigInt(Math.max(1, Math.floor(pageSize)));
    const clamped = matched === 0n
      ? 0n
      : offset < matched
        ? offset
        : ((matched - 1n) / size) * size;
    return { sortOffset: clamped.toString() };
  }
  if (totalRecords === undefined) return undefined;
  let total: bigint;
  try {
    total = BigInt(totalRecords);
  } catch {
    return undefined;
  }
  if (total <= 0n) return {};
  if (query.trim()) return { direction: 'backward' };

  const size = BigInt(Math.max(1, Math.floor(pageSize)));
  let desired: bigint | undefined;
  try {
    if (firstVisibleOrdinal !== undefined) desired = BigInt(firstVisibleOrdinal);
  } catch {
    desired = undefined;
  }
  if (desired === undefined) {
    try {
      const page = BigInt(pageText ?? '1');
      if (page > 0n) desired = (page - 1n) * size;
    } catch {
      desired = undefined;
    }
  }
  const clamped = desired === undefined
    ? 0n
    : desired < 0n
      ? 0n
      : desired < total ? desired : total - 1n;
  const pageStart = (clamped / size) * size;
  return pageStart === 0n
    ? {}
    : { anchorOrdinal: (pageStart - 1n).toString(), direction: 'forward' };
}

/**
 * Select a complete request intent after OPENED. An explicit resume object is
 * authoritative even when it is empty (page one); object spreading cannot
 * remove an anchor inherited from the old generation.
 */
export function rowsOptionsAfterOpenedRequest(
  openedRows: RebuildRowsOptions,
  resumeRows: RebuildRowsOptions | undefined,
  followMode: boolean,
): RebuildRowsOptions {
  if (followMode) return { direction: 'backward' };
  return resumeRows === undefined ? { ...openedRows } : { ...resumeRows };
}

/**
 * Return a rows request for a newly opened generation. A repeated OPENED for
 * the already displayed generation is a no-op so it cannot reset pagination.
 */
export function rowsOptionsAfterOpened(
  viewport: ViewportIdentity | undefined,
  opened: Pick<ViewportIdentity, 'documentId' | 'generation' | 'epoch'>,
  followMode: boolean,
): RebuildRowsOptions | undefined {
  if (viewport === undefined || viewport.documentId !== opened.documentId) {
    return rowsOptionsAfterRebuild(undefined, followMode);
  }
  const epochChanged = viewport.epoch !== undefined
    && opened.epoch !== undefined
    && viewport.epoch !== opened.epoch;
  if (viewport.generation === opened.generation && !epochChanged) return undefined;
  return rowsOptionsAfterRebuild(viewport.firstVisibleOrdinal, followMode);
}
