import type { RecordDetail } from '../shared/types';

export const AUTOMATIC_FULL_RECORD_LIMIT_BYTES = 16 * 1024 * 1024;

export function shouldAutomaticallyHydrateSelectedRecord(
  detail: RecordDetail | undefined,
  selectedOrdinal: string | undefined,
  drawerOpen: boolean,
  requestPending: boolean,
): boolean {
  if (
    detail === undefined
    || selectedOrdinal !== detail.ref.ordinal
    || !drawerOpen
    || requestPending
    || detail.rawComplete
    || detail.ref.parseState !== 'oversized'
    || !/^(0|[1-9]\d*)$/.test(detail.ref.contentByteLength)
  ) {
    return false;
  }

  const recordBytes = BigInt(detail.ref.contentByteLength);
  return recordBytes > 0n && recordBytes <= BigInt(AUTOMATIC_FULL_RECORD_LIMIT_BYTES);
}
