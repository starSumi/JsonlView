const MIN_PAGE = 1n;

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
