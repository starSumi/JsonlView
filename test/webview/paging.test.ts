import { describe, expect, it } from 'vitest';
import {
  advanceSortPage,
  anchorBeforeOrdinal,
  anchorForPage,
  pageFromOrdinal,
  previousSortPage,
  rowsOptionsAfterEmptyRebuild,
  rowsOptionsAfterRebuild,
  rowsOptionsAfterOpened,
  rowsOptionsAfterOpenedRequest,
  rowsOptionsForViewport,
} from '../../src/webview/paging';

describe('paging helpers', () => {
  it('walks backward through actual partial sorted-page continuations', () => {
    const pageTwo = advanceSortPage([], '0', '1', '3', 100);
    expect(pageTwo).toEqual({ offset: '3', history: ['0'], page: '2' });
    const pageThree = advanceSortPage(pageTwo.history, pageTwo.offset, pageTwo.page, '7', 100);
    expect(pageThree).toEqual({ offset: '7', history: ['0', '3'], page: '3' });

    const backToTwo = previousSortPage(pageThree.history, pageThree.offset, pageThree.page, 100);
    expect(backToTwo).toEqual({ offset: '3', history: ['0'], page: '2' });
    expect(previousSortPage(backToTwo.history, backToTwo.offset, backToTwo.page, 100)).toEqual({
      offset: '0',
      history: [],
      page: '1',
    });
  });

  it('keeps logical pages independent after a direct sorted-page jump', () => {
    const pageFive = advanceSortPage([], '300', '4', '303', 100);
    expect(pageFive).toEqual({ offset: '303', history: ['300'], page: '5' });
    expect(previousSortPage(pageFive.history, pageFive.offset, pageFive.page, 100)).toEqual({
      offset: '300',
      history: [],
      page: '4',
    });
  });

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

  it('creates a precise predecessor cursor for a rebuilt viewport', () => {
    expect(anchorBeforeOrdinal(undefined)).toBeUndefined();
    expect(anchorBeforeOrdinal('0')).toBeUndefined();
    expect(anchorBeforeOrdinal('200')).toBe('199');
    expect(anchorBeforeOrdinal('900719925474099200')).toBe('900719925474099199');
    expect(anchorBeforeOrdinal('not-an-ordinal')).toBeUndefined();
  });

  it('requests the same page after rebuild and keeps follow mode at the tail', () => {
    expect(rowsOptionsAfterRebuild('200', false)).toEqual({
      anchorOrdinal: '199',
      direction: 'forward',
    });
    expect(rowsOptionsAfterRebuild('0', false)).toEqual({});
    expect(rowsOptionsAfterRebuild(undefined, false)).toEqual({});
    expect(rowsOptionsAfterRebuild('200', true)).toEqual({ direction: 'backward' });
  });

  it('uses the visible page as a fallback when a rebuild cancels the row response', () => {
    expect(rowsOptionsForViewport(undefined, '4', 100, false)).toEqual({
      anchorOrdinal: '299',
      direction: 'forward',
    });
    expect(rowsOptionsForViewport('300', '1', 100, false)).toEqual({
      anchorOrdinal: '299',
      direction: 'forward',
    });
    expect(rowsOptionsForViewport(undefined, '1', 100, false)).toEqual({});
    expect(rowsOptionsForViewport(undefined, '4', 100, true)).toEqual({ direction: 'backward' });
  });

  it('keeps an in-flight direct page request ahead of the previous cursor', () => {
    expect(rowsOptionsForViewport('100', '2', 100, false, {
      anchorOrdinal: '299',
      direction: 'forward',
    })).toEqual({
      anchorOrdinal: '299',
      direction: 'forward',
    });
    expect(rowsOptionsForViewport('0', '4', 100, false, undefined)).toEqual({
      anchorOrdinal: '299',
      direction: 'forward',
    });
  });

  it('keeps an in-flight request for page one ahead of an older page cursor', () => {
    expect(rowsOptionsForViewport('300', '4', 100, false, {})).toEqual({});
  });

  it('clamps a restored page when the rebuilt source is shorter', () => {
    expect(rowsOptionsAfterEmptyRebuild('300', '4', 100, '150')).toEqual({
      anchorOrdinal: '99',
      direction: 'forward',
    });
    expect(rowsOptionsAfterEmptyRebuild(undefined, '4', 100, '150')).toEqual({
      anchorOrdinal: '99',
      direction: 'forward',
    });
    expect(rowsOptionsAfterEmptyRebuild('300', '4', 100, '150', 'needle')).toEqual({
      direction: 'backward',
    });
    expect(rowsOptionsAfterEmptyRebuild('0', '1', 100, '0')).toEqual({});
    expect(rowsOptionsAfterEmptyRebuild('300', '4', 100, undefined)).toBeUndefined();
    expect(rowsOptionsAfterEmptyRebuild('300', '4', 100, 'not-a-count')).toBeUndefined();
  });

  it('clamps sorted rebuild offsets only from a complete matched-record count', () => {
    expect(rowsOptionsAfterEmptyRebuild(undefined, '4', 100, '1000', '', '300', '150')).toEqual({ sortOffset: '100' });
    expect(rowsOptionsAfterEmptyRebuild(undefined, '4', 100, '1000', '', '300', '0')).toEqual({ sortOffset: '0' });
    expect(rowsOptionsAfterEmptyRebuild(undefined, '2', 100, '1000', '', '100', '150')).toEqual({ sortOffset: '100' });
    expect(rowsOptionsAfterEmptyRebuild(undefined, '4', 100, '1000', '', '300', '150', true)).toBeUndefined();
    expect(rowsOptionsAfterEmptyRebuild(undefined, '4', 100, '1000', '', '300')).toBeUndefined();
  });

  it('restores only a changed generation and ignores duplicate OPENED messages', () => {
    const viewport = {
      documentId: 'doc',
      generation: 'g1',
      firstVisibleOrdinal: '200',
    };

    expect(rowsOptionsAfterOpened(viewport, { documentId: 'doc', generation: 'g2' }, false)).toEqual({
      anchorOrdinal: '199',
      direction: 'forward',
    });
    expect(rowsOptionsAfterOpened(viewport, { documentId: 'doc', generation: 'g2' }, true)).toEqual({
      direction: 'backward',
    });
    expect(rowsOptionsAfterOpened(viewport, { documentId: 'doc', generation: 'g1' }, false)).toBeUndefined();
    expect(rowsOptionsAfterOpened(undefined, { documentId: 'doc', generation: 'g1' }, false)).toEqual({});
    expect(rowsOptionsAfterOpened(viewport, { documentId: 'other', generation: 'g1' }, false)).toEqual({});
  });

  it('treats an explicit empty resume intent as authoritative', () => {
    const opened = { anchorOrdinal: '299', direction: 'forward' as const };
    expect(rowsOptionsAfterOpenedRequest(opened, {}, false)).toEqual({});
    expect(rowsOptionsAfterOpenedRequest(opened, undefined, false)).toEqual(opened);
    expect(rowsOptionsAfterOpenedRequest(opened, {}, true)).toEqual({ direction: 'backward' });
  });
});
