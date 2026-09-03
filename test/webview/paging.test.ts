import { describe, expect, it } from 'vitest';
import { anchorForPage, pageFromOrdinal } from '../../src/webview/paging';

describe('paging helpers', () => {
  it('maps physical ordinals to one-based pages without losing precision', () => {
    expect(pageFromOrdinal(undefined, 100)).toBe('1');
    expect(pageFromOrdinal('0', 100)).toBe('1');
    expect(pageFromOrdinal('100', 100)).toBe('2');
    expect(pageFromOrdinal('900719925474099200', 100)).toBe('9007199254740993');
  });

  it('creates exclusive anchors for direct page jumps', () => {
    expect(anchorForPage('1', 100)).toBeUndefined();
    expect(anchorForPage('2', 100)).toBe('99');
    expect(anchorForPage('17', 50)).toBe('799');
    expect(anchorForPage('0', 100)).toBeUndefined();
    expect(anchorForPage('not-a-page', 100)).toBeUndefined();
  });
});
