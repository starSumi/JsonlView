export type RevealAckOutcome = 'shown' | 'filtered-out' | 'not-found' | 'stale';
export interface RevealAckPayload {
  readonly anchorOrdinal: string;
  readonly outcome: RevealAckOutcome;
  readonly renderedOrdinal?: string;
  readonly reason?: string;
}
export type RevealResultOutcome = RevealAckOutcome | 'no-view' | 'timeout' | 'superseded' | 'cancelled' | 'out-of-range' | 'unauthorized';
export interface RevealResult {
  readonly outcome: RevealResultOutcome;
  readonly documentId: string;
  readonly generation: string;
  readonly epoch?: number;
  readonly requestId: string;
  readonly anchorOrdinal: string;
}
export interface RevealRowTarget {
  readonly sourceId: string;
  readonly nativeId: string;
  readonly anchorOrdinal: string;
}
export function isRevealOrdinal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,63})$/u.test(value);
}
export function isRevealAckPayload(value: unknown): value is RevealAckPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['anchorOrdinal', 'outcome', 'renderedOrdinal', 'reason'].includes(key))
    || !isRevealOrdinal(data.anchorOrdinal)
    || !['shown', 'filtered-out', 'not-found', 'stale'].includes(String(data.outcome))
    || (data.renderedOrdinal !== undefined && !isRevealOrdinal(data.renderedOrdinal))
    || (data.reason !== undefined && (typeof data.reason !== 'string' || data.reason.length > 256))) return false;
  return data.outcome === 'shown' ? data.renderedOrdinal === data.anchorOrdinal : data.renderedOrdinal === undefined;
}
