import { describe, expect, it } from 'vitest';
import type { RecordRef } from '../../src/shared/types';
import { recordPresentationKey, recordRefKey, sameRecordRef } from '../../src/webview/record-identity';

const ref: RecordRef = {
  generation: 'g1', ordinal: '7', byteStart: '0', byteEndExclusive: '24',
  contentByteLength: '23', delimiterByteLength: 1, parseState: 'valid',
};

describe('record detail identity', () => {
  it('retains DOM identity through rebinding without accepting an old-generation response', () => {
    const rebound = { ...ref, generation: 'g2' };
    expect(recordPresentationKey(rebound)).toBe(recordPresentationKey(ref));
    expect(sameRecordRef(ref, rebound)).toBe(false);
    expect(recordPresentationKey({ ...ref, ordinal: '8' })).not.toBe(recordPresentationKey(ref));
    expect(recordPresentationKey({ ...ref, byteEndExclusive: '25' })).not.toBe(recordPresentationKey(ref));
  });
  it('rejects a late response when any physical coordinate or generation differs', () => {
    const changed: RecordRef[] = [
      { ...ref, generation: 'g2' }, { ...ref, ordinal: '8' },
      { ...ref, byteStart: '1' }, { ...ref, byteEndExclusive: '25' },
      { ...ref, contentByteLength: '24' }, { ...ref, delimiterByteLength: 2 },
    ];
    for (const other of changed) {
      expect(recordRefKey(other)).not.toBe(recordRefKey(ref));
      expect(sameRecordRef(ref, other)).toBe(false);
    }
  });

  it('matches the same source identity and rejects missing identities', () => {
    expect(sameRecordRef(ref, { ...ref })).toBe(true);
    expect(sameRecordRef(ref, undefined)).toBe(false);
    expect(sameRecordRef(undefined, ref)).toBe(false);
    expect(sameRecordRef(undefined, undefined)).toBe(false);
  });
});
