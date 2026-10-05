import { describe, expect, it } from 'vitest';
import {
  captureRebuild,
  planEmptyRestore,
  planOpened,
  type PendingViewportIntent,
  type QueryViewport,
  type RestoreViewportIntent,
} from '../../src/webview/row-query-recovery-policy';

const session = { documentId: 'doc', generation: 'g1', epoch: 1 };
const opened = { ...session, generation: 'g2', epoch: 2 };
const viewport: QueryViewport = { ...session, query: '', firstVisibleOrdinal: '300' };
const pending: PendingViewportIntent = {
  ...session, requestId: 'rows-1', query: '', options: {},
  preserveOnRebuild: true, restoreAfterRebuild: false,
};
const restore: RestoreViewportIntent = {
  ...opened, query: '', requestId: 'rows-2', firstVisibleOrdinal: '900', pageText: '10', phase: 'initial',
};
const captureInput = { session, query: '', followMode: false, pageText: '4', pageSize: 100, viewport };
const openedInput = {
  opened, firstOpenedSession: false, snapshotChanged: true, query: '', followMode: false, pageText: '4', viewport,
};
const emptyInput = {
  restore, session: opened, query: '', followMode: false, invalidated: false, pageSize: 100,
  indexingComplete: true, totalRecords: '250', requestedOptions: { anchorOrdinal: '899', direction: 'forward' as const },
};

describe('row query recovery policy', () => {
  it('captures eligible pending page one before cancellation without inheriting the shown anchor', () => {
    const captured = captureRebuild({ ...captureInput, pageText: '1', pending });
    expect(captured.options).toEqual({});
    const decision = planOpened({ ...openedInput, rebuild: { ...captured, requestId: 'rebuild-1' } });
    expect(decision).toMatchObject({ kind: 'restore', options: {}, replacesSnapshot: true });
    expect(viewport.firstVisibleOrdinal).toBe('300');
    expect(pending.options).toEqual({});
  });

  it('prefers a pending anchor and copies mutable request options', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const options = { anchorOrdinal: '499', direction: 'forward' as const, sort, sortOffset: '100' };
    const captured = captureRebuild({ ...captureInput, pending: { ...pending, options } });
    options.anchorOrdinal = '999';
    sort.columnId = 'changed';
    expect(captured.options).toEqual({ anchorOrdinal: '499', direction: 'forward', sortOffset: '100',
      sort: { columnId: '__ordinal', direction: 'desc' } });
  });

  it.each([
    { ...pending, query: 'old' },
    { ...pending, documentId: 'other' },
    { ...pending, generation: 'retired' },
    { ...pending, epoch: 0 },
    { ...pending, preserveOnRebuild: false },
  ])('excludes ineligible pending viewport intent', (ineligible) => {
    expect(captureRebuild({ ...captureInput, pending: ineligible }).options)
      .toEqual({ anchorOrdinal: '299', direction: 'forward' });
  });

  it('starts a newer draft query from page one', () => {
    const captured = captureRebuild({ ...captureInput, query: 'new draft', pending });
    expect(captured).toMatchObject({ query: 'new draft', viewportQuery: '', pageText: '1', options: {} });
    expect(captured.firstVisibleOrdinal).toBeUndefined();
    expect(planOpened({ ...openedInput, query: 'new draft', rebuild: { ...captured, requestId: 'rebuild' } }))
      .toMatchObject({ kind: 'restore', options: {}, restore: { query: 'new draft', pageText: '1' } });
  });

  it('follows the tail and does not install an empty-page restore', () => {
    const captured = captureRebuild({ ...captureInput, followMode: true, pending });
    expect(captured.options).toEqual({ direction: 'backward' });
    const decision = planOpened({ ...openedInput, followMode: true, rebuild: { ...captured, requestId: 'rebuild' } });
    expect(decision).toMatchObject({ kind: 'restore', options: { direction: 'backward' } });
    if (decision.kind !== 'restore') throw new Error('Expected tail request');
    expect(decision.restore).toBeUndefined();
  });

  it('makes duplicate accepted snapshots a no-op even before rows arrive', () => {
    expect(planOpened({ ...openedInput, opened: session, snapshotChanged: false, pending })).toEqual({ kind: 'none' });
    expect(planOpened({ ...openedInput, viewport: undefined, pending: undefined, snapshotChanged: false }))
      .toEqual({ kind: 'none' });
  });

  it('restores a newer same-generation payload epoch with the accepted identity helper', () => {
    expect(planOpened({ ...openedInput, opened: { ...session, epoch: 2 } }))
      .toMatchObject({ kind: 'restore', replacesSnapshot: true, options: { anchorOrdinal: '299', direction: 'forward' } });
  });

  it('never carries an old document cursor into the first accepted document', () => {
    expect(planOpened({ ...openedInput, firstOpenedSession: true, opened: { ...opened, documentId: 'other' } }))
      .toMatchObject({ kind: 'restore', replacesSnapshot: false, options: {} });
  });

  it('waits for completed indexing and returns an immutable retry', () => {
    const waiting = planEmptyRestore({ ...emptyInput, indexingComplete: false, totalRecords: undefined });
    expect(waiting).toMatchObject({ kind: 'wait-index', restore: { phase: 'waiting-index' } });
    expect(restore.phase).toBe('initial');
    const retried = planEmptyRestore(emptyInput);
    expect(retried).toMatchObject({ kind: 'retry', options: { anchorOrdinal: '199', direction: 'forward' },
      restore: { phase: 'retrying' } });
    if (retried.kind !== 'retry') throw new Error('Expected clamped request');
    expect(planEmptyRestore({ ...emptyInput, restore: retried.restore })).toEqual({ kind: 'stop' });
  });

  it('stops a zero or identical retry instead of cycling', () => {
    expect(planEmptyRestore({ ...emptyInput, totalRecords: '0' })).toEqual({ kind: 'stop' });
    expect(planEmptyRestore({ ...emptyInput, requestedOptions: { anchorOrdinal: '199', direction: 'forward' } }))
      .toEqual({ kind: 'stop' });
  });

  it('retains the completed request while waiting so later progress cannot retry identical options', () => {
    const waiting = planEmptyRestore({ ...emptyInput, indexingComplete: false, totalRecords: undefined });
    if (waiting.kind !== 'wait-index') throw new Error('Expected pending indexing');
    expect(waiting.restore.requestedOptions).toEqual(emptyInput.requestedOptions);
    expect(planEmptyRestore({ ...emptyInput, restore: waiting.restore,
      requestedOptions: undefined, totalRecords: '1000' })).toEqual({ kind: 'stop' });
    const sorted = planEmptyRestore({ ...emptyInput, indexingComplete: false, totalRecords: undefined,
      requestedOptions: { sortOffset: '900' } });
    if (sorted.kind !== 'wait-index') throw new Error('Expected pending sorted indexing');
    expect(planEmptyRestore({ ...emptyInput, restore: sorted.restore,
      requestedOptions: undefined, totalRecords: '1000' })).toEqual({ kind: 'stop' });
  });

  it('uses a filtered tail and trusts sorted matched counts only when complete', () => {
    expect(planEmptyRestore({ ...emptyInput, query: 'match', restore: { ...restore, query: 'match' } }))
      .toMatchObject({ kind: 'retry', options: { direction: 'backward' } });
    const sorted = { ...emptyInput, requestedOptions: { sortOffset: '900' }, matchedRecords: '230' };
    expect(planEmptyRestore(sorted)).toMatchObject({ kind: 'retry', options: { sortOffset: '200' } });
    expect(planEmptyRestore({ ...sorted, scanTruncated: true })).toEqual({ kind: 'stop' });
    expect(planEmptyRestore({ ...sorted, matchedRecords: undefined })).toEqual({ kind: 'stop' });
  });

  it.each([
    { query: 'new draft' }, { followMode: true }, { invalidated: true },
    { session: { ...opened, epoch: 3 } }, { session: { ...opened, generation: 'g3' } },
  ])('retires recovery when superseded', (supersession) => {
    expect(planEmptyRestore({ ...emptyInput, ...supersession })).toEqual({ kind: 'stop' });
  });

  it('keeps ordinals beyond Number precision as decimal strings', () => {
    const ordinal = '900719925474099312345';
    const captured = captureRebuild({ ...captureInput, viewport: { ...viewport, firstVisibleOrdinal: ordinal } });
    expect(captured.options.anchorOrdinal).toBe('900719925474099312344');
    expect(planEmptyRestore({ ...emptyInput, restore: { ...restore, firstVisibleOrdinal: ordinal },
      totalRecords: '900719925474099312300' }))
      .toMatchObject({ kind: 'retry', options: { anchorOrdinal: '900719925474099312199', direction: 'forward' } });
  });
});
