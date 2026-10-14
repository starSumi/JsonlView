import { describe, expect, it } from 'vitest';
import type { RowProjection } from '../../src/shared/types';
import { captureViewportAnchor, isRowVisible, latestRowIndex, physicalRowKey, resolveViewportAnchor } from '../../src/webview/features/record-query/viewport-anchor';

function rows(start = 0, count = 5, generation = 'g1'): RowProjection[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = start + index;
    return { ref: { generation, ordinal: String(ordinal), byteStart: String(ordinal * 10),
      byteEndExclusive: String(ordinal * 10 + 10), contentByteLength: '9', delimiterByteLength: 1,
      parseState: 'valid' }, cells: [], genericSummary: 'Synthetic record' };
  });
}

describe('physical viewport anchors', () => {
  it('preserves the record and intra-row offset after append and a shifted page in a safe generation', () => {
    const anchor = captureViewportAnchor('doc', rows(100), 67);
    const resolved = resolveViewportAnchor(anchor, 'doc', rows(101, 5, 'g2'));
    expect(anchor?.ref.ordinal).toBe('102');
    expect(anchor?.offset).toBe(7);
    expect(resolved?.scrollTop).toBe(37);
    expect(resolved?.anchor.ref.generation).toBe('g2');
  });

  it('rejects same ordinal with changed physical bytes and another document', () => {
    const anchor = captureViewportAnchor('doc', rows(), 37);
    const replacement = rows(0, 5, 'g2');
    replacement[1]!.ref.byteEndExclusive = '21';
    expect(resolveViewportAnchor(anchor, 'doc', replacement)).toBeUndefined();
    expect(resolveViewportAnchor(anchor, 'another-doc', rows())).toBeUndefined();
  });

  it('keeps an unloaded anchor unresolved instead of redirecting it to a page-local index', () => {
    const anchor = captureViewportAnchor('doc', rows(), 67);
    expect(resolveViewportAnchor(anchor, 'doc', rows(100))).toBeUndefined();
  });

  it('keeps generation out of presentation keys while retaining every physical coordinate', () => {
    const ref = rows()[0]!.ref;
    expect(physicalRowKey(ref)).toBe(physicalRowKey({ ...ref, generation: 'g2' }));
    expect(physicalRowKey(ref)).not.toBe(physicalRowKey({ ...ref, delimiterByteLength: 2 }));
  });

  it('clamps an elastic negative offset and rejects absent or invalid positions', () => {
    expect(captureViewportAnchor('doc', rows(), -9)?.offset).toBe(0);
    expect(captureViewportAnchor('doc', rows(), Number.NaN)).toBeUndefined();
    expect(captureViewportAnchor('doc', [], 0)).toBeUndefined();
  });
});

describe('latest row visibility', () => {
  it('requires the actual newest ordinal and generation, without lossy number conversion', () => {
    const latest = rows(0, 1, 'current');
    latest[0]!.ref.ordinal = '9007199254740993';
    expect(latestRowIndex(latest, 'current', '9007199254740994', undefined)).toBe(0);
    expect(latestRowIndex(latest, 'old', '9007199254740994', undefined)).toBe(-1);
    expect(latestRowIndex(latest, 'current', '9007199254740995', undefined)).toBe(-1);
  });

  it('resolves physical ascending and descending tails and rejects arbitrary sorts', () => {
    expect(latestRowIndex(rows(), 'g1', '5', undefined)).toBe(4);
    expect(latestRowIndex(rows().reverse(), 'g1', '5', { columnId: '__ordinal', direction: 'desc' })).toBe(0);
    expect(latestRowIndex(rows(), 'g1', '5', { columnId: 'status', direction: 'asc' })).toBe(-1);
    expect(latestRowIndex(rows(), 'g1', '0', undefined)).toBe(-1);
    expect(latestRowIndex(rows(), 'g1', 'invalid', undefined)).toBe(-1);
  });

  it('requires the whole newest row below the sticky header in a visible viewport', () => {
    expect(isRowVisible(4, 0, 180)).toBe(true);
    expect(isRowVisible(4, 0, 160)).toBe(false);
    expect(isRowVisible(4, 120, 60)).toBe(true);
    expect(isRowVisible(4, 150, 60)).toBe(false);
    expect(isRowVisible(0, 0, 0)).toBe(false);
    expect(isRowVisible(-1, 0, 180)).toBe(false);
  });
});
