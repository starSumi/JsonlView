import type { RecordRef } from '@shared/types';

export function recordRefKey(ref: RecordRef): string {
  return `${ref.generation}:${recordPresentationKey(ref)}`;
}

/** DOM identity only. Transport authorization must still use recordRefKey. */
export function recordPresentationKey(ref: RecordRef): string {
  return [
    ref.ordinal,
    ref.byteStart,
    ref.byteEndExclusive,
    ref.contentByteLength,
    ref.delimiterByteLength,
  ].join(':');
}

export function sameRecordRef(left: RecordRef | undefined, right: RecordRef | undefined): boolean {
  return left !== undefined
    && right !== undefined
    && recordRefKey(left) === recordRefKey(right);
}
