import { describe, expect, it } from 'vitest';
import { copyGraphRecordRef } from '../../src/shared/graph-record-ref';

describe('engine physical graph references', () => {
  it('accepts content end independently of LF, CRLF and final record without a delimiter', () => {
    for (const delimiterByteLength of [0, 1, 2] as const) {
      const ref = { generation: 'g', ordinal: '0', byteStart: '10', byteEndExclusive: '12', contentByteLength: '2', delimiterByteLength, parseState: 'valid' };
      expect(copyGraphRecordRef(ref, 'g')).toEqual(ref);
      expect(copyGraphRecordRef({ ...ref, byteEndExclusive: String(12 + delimiterByteLength + 1) }, 'g')).toBeUndefined();
    }
  });
  it('rejects delimiter-inclusive or negative spans, noncanonical decimals and a stale generation', () => {
    const ref = { generation: 'g', ordinal: '0', byteStart: '10', byteEndExclusive: '12', contentByteLength: '2', delimiterByteLength: 2, parseState: 'valid' };
    for (const bad of [{ ...ref, byteEndExclusive: '14' }, { ...ref, byteEndExclusive: '9' }, { ...ref, ordinal: '01' }, { ...ref, generation: 'old' }]) expect(copyGraphRecordRef(bad, 'g')).toBeUndefined();
  });
  it('rejects additional own keys and returns a frozen copy for the exact current shape', () => {
    const ref = { generation: 'g', ordinal: '0', byteStart: '10', byteEndExclusive: '12', contentByteLength: '2', delimiterByteLength: 1 as const, parseState: 'valid' as const };
    const copied = copyGraphRecordRef(ref, 'g');
    expect(copied).toEqual(ref);
    expect(copied).not.toBe(ref);
    expect(Object.isFrozen(copied)).toBe(true);
    expect(copyGraphRecordRef({ ...ref, future: true }, 'g')).toBeUndefined();
  });
});
