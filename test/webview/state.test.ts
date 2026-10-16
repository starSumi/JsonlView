import { describe, expect, it } from 'vitest';
import type { AnalysisIntentV1, DocumentSummary, ExtensionMessage, InsightSummary, RecordDetail, RowProjection } from '../../src/shared/types';
import { keyPath, PROTOCOL_VERSION } from '../../src/shared/types';
import {
  createInitialState,
  selectProblems,
  selectTimelineRows,
  toPersistedState,
  workspaceReducer,
  type WorkspaceAction,
} from '../../src/webview/state';

describe('persisted table query migration', () => {
  it('persists the display choice without changing query, page, follow or selection intent', () => {
    const initial = createInitialState({ query: 'answer', followMode: true, sortDirection: 'desc' });
    const next = workspaceReducer(initial, { type: 'SET_DISPLAY_MODE', mode: 'conversation' });
    expect(next).toEqual({ ...initial, displayMode: 'conversation' });
    expect(createInitialState(toPersistedState(next)).displayMode).toBe('conversation');
    expect(createInitialState().displayMode).toBe('table');
  });

  const filter = { columnId: 'actor', source: 'profile' as const, operator: 'eq' as const, value: 'assistant' };
  it('restores a legacy single filter as the first condition and round-trips multiple conditions and types', () => {
    const initial = createInitialState({ filter });
    expect(initial.filters).toEqual([filter]);
    const filters = [filter, { columnId: 'status', source: 'profile' as const, operator: 'eq' as const, value: 'ok' }];
    let state = workspaceReducer(initial, { type: 'SET_FILTERS', filters });
    const rowTypes = { column: { id: 'eventKind', label: 'Event', source: 'profile' as const }, values: ['message', 'tool_call'] };
    state = workspaceReducer(state, { type: 'SET_ROW_TYPES', rowTypes });
    const restored = createInitialState(toPersistedState(state));
    expect(restored.filters).toEqual(filters);
    expect(restored.filter).toEqual(filters[0]);
    expect(restored.rowTypes).toEqual(rowTypes);
  });

  it('respects an explicit empty new filter list over a legacy field', () => {
    const state = createInitialState({ followMode: true, filter, filters: [] });
    expect(state.filters).toEqual([]);
    expect(state.filter).toBeUndefined();
    expect(state.viewportMode).toBe('following');
  });

  it('clears incompatible profile conditions and Event selections without losing record conditions or configured columns', () => {
    const path = keyPath('stage');
    const recordFilter = { columnId: JSON.stringify(path.tokens), source: 'record' as const, path,
      operator: 'eq' as const, value: 'prod' };
    const visibility = { [JSON.stringify(keyPath('payload', 'output').tokens)]: true };
    let state = createInitialState({ filters: [filter, recordFilter], columnVisibility: visibility,
      rowTypes: { column: { id: 'eventKind', label: 'Event', source: 'profile' }, values: ['message'] } });
    state = { ...state, columns: [{ id: 'actor', label: 'Actor', source: 'profile' }] };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('PROFILE_CHANGED', {
      profileId: 'generic', columns: [],
    }) });
    expect(state.filters).toEqual([recordFilter]);
    expect(state.filter).toEqual(recordFilter);
    expect(state.rowTypes).toBeUndefined();
    expect(state.columnVisibility).toMatchObject(visibility);
    expect(state.columns).toEqual([{
      id: JSON.stringify(keyPath('payload', 'output').tokens), label: '$.payload.output', source: 'record',
      path: keyPath('payload', 'output'),
    }]);
    expect(state.schema).toEqual([]);
    const restored = createInitialState(toPersistedState(state));
    const other = { id: 'severity', label: 'Severity', source: 'profile' as const };
    const switched = workspaceReducer(restored, { type: 'MESSAGE_RECEIVED', message: envelope('PROFILE_CHANGED', {
      profileId: 'other', columns: [other],
    }) });
    expect(switched.columns).toEqual([other, ...state.columns]);
  });

  it('does not retain an old profile column or a deselected record when changing profiles', () => {
    const path = keyPath('status');
    const id = JSON.stringify(path.tokens);
    let state = createInitialState({ columnVisibility: { [id]: false, actor: true } });
    state = { ...state, columns: [
      { id: 'actor', label: 'Actor', source: 'profile' },
      { id, label: '$.status', source: 'record', path },
    ] };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('PROFILE_CHANGED', {
      profileId: 'generic', columns: [],
    }) });
    expect(state.columns).toEqual([]);
    expect(state.columnVisibility[id]).toBe(false);
  });
});

const summary: DocumentSummary = {
  snapshot: {
    documentId: 'doc',
    generation: 'g1',
    uri: 'file:///events.jsonl',
    scheme: 'file',
    sizeBytes: '4096',
    mtimeMs: 1,
    prefixFingerprint: 'abc',
    observedAt: '2026-08-30T00:00:00Z',
  },
  profileId: 'generic',
  profileVersion: '1',
  profileSuggestions: [],
  indexedBytes: '4096',
  indexedRecords: '2',
  indexingComplete: true,
  validRecords: '1',
  problemRecords: '1',
};

function envelope<T extends ExtensionMessage['type']>(
  type: T,
  payload: Extract<ExtensionMessage, { type: T }>['payload'],
): Extract<ExtensionMessage, { type: T }> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    documentId: 'doc',
    generation: 'g1',
    requestId: 'request-1',
    payload,
  } as Extract<ExtensionMessage, { type: T }>;
}

const rows: RowProjection[] = [
  {
    ref: {
      generation: 'g1',
      ordinal: '1',
      byteStart: '0',
      byteEndExclusive: '20',
      contentByteLength: '19',
      delimiterByteLength: 1,
      parseState: 'valid',
    },
    cells: [],
    genericSummary: 'agent message',
    profile: {
      profileId: 'codex',
      eventKind: 'message',
      summary: 'agent message',
      evidence: [],
      confidence: 'source',
    },
  },
  {
    ref: {
      generation: 'g1',
      ordinal: '2',
      byteStart: '20',
      byteEndExclusive: '40',
      contentByteLength: '19',
      delimiterByteLength: 1,
      parseState: 'invalid_json',
    },
    cells: [],
    genericSummary: 'invalid record',
    problems: [{ code: 'invalid_json', message: 'Invalid JSON', severity: 'error' }],
  },
];

describe('workspace reducer', () => {
  it('reports a missing startup response and recovers if OPENED arrives late', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'REQUEST_SENT', request: { kind: 'ready', id: 'request-1' },
    });
    state = workspaceReducer(state, { type: 'STARTUP_TIMEOUT' });
    expect(state.phase).toBe('error');
    expect(state.summary).toBeUndefined();
    expect(state.error?.code).toBe('STARTUP_TIMEOUT');
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    expect(state.phase).toBe('ready');
    expect(state.summary?.indexedRecords).toBe('2');
    expect(state.error).toBeUndefined();
    expect(workspaceReducer(state, { type: 'STARTUP_TIMEOUT' })).toBe(state);
  });

  it('does not replace a startup host error with a timeout', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'REQUEST_SENT', request: { kind: 'ready', id: 'request-1' },
    });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('ERROR', {
      code: 'OPEN_FAILED', message: 'Unable to read the source', recoverable: false,
    }) });
    expect(state.error?.code).toBe('OPEN_FAILED');
    expect(workspaceReducer(state, { type: 'STARTUP_TIMEOUT' })).toBe(state);
    state = workspaceReducer(state, {
      type: 'REQUEST_SENT', request: { kind: 'ready', id: 'request-2' },
    });
    expect(state.phase).toBe('error');
    expect(state.error?.code).toBe('OPEN_FAILED');
  });

  it('increments the viewport revision only for accepted explicit navigation', () => {
    const initial = createInitialState({ followMode: true });
    expect(initial.viewportRevision).toBe(0);
    const reset = workspaceReducer(initial, { type: 'RESET_VIEWPORT' });
    expect(reset.viewportRevision).toBe(1);
    expect(reset.viewportMode).toBe('following');
    const reading = workspaceReducer(reset, { type: 'SET_VIEWPORT_MODE', mode: 'reading' });
    expect(reading.viewportRevision).toBe(1);
    expect(workspaceReducer(reading, { type: 'RESET_VIEWPORT' }).viewportRevision).toBe(2);
  });

  it('tracks appended activity above safe integer precision without rows or request ACK clearing it', () => {
    const indexedRecords = '9007199254740993';
    let state = workspaceReducer(createInitialState({ followMode: true }), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', { ...summary, indexedRecords }),
    });
    expect(state.seenSeq).toBe(indexedRecords);
    state = workspaceReducer(state, { type: 'SET_VIEWPORT_MODE', mode: 'reading' });
    const latestSeq = '9007199254740994';
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('INDEX_PROGRESS', { ...summary, indexedRecords: latestSeq }),
    });
    expect(state.latestSeq).toBe(latestSeq);
    expect(state.unseenActivity).toBe(true);
    const tailRef = { ...rows[0]!.ref, ordinal: '9007199254740993' };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('ROWS', {
        rows: [{ ...rows[0]!, ref: tailRef }], columns: [], anchorOrdinal: tailRef.ordinal,
        hasBefore: true, hasAfter: false, indexedRecords: latestSeq,
      }),
    });
    expect(state.unseenActivity).toBe(true);
    state = workspaceReducer(state, { type: 'SET_VIEWPORT_MODE', mode: 'following' });
    expect(state.unseenActivity).toBe(true);
    for (const observation of [
      { generation: 'retired', ordinal: tailRef.ordinal, indexedRecords: latestSeq },
      { generation: 'g1', ordinal: tailRef.ordinal, indexedRecords },
      { generation: 'g1', ordinal: '9007199254740992', indexedRecords: latestSeq },
      { generation: 'g1', ordinal: tailRef.ordinal, indexedRecords: latestSeq, epoch: 9 },
    ]) {
      expect(workspaceReducer(state, { type: 'TAIL_VISIBLE', ...observation })).toBe(state);
    }
    state = workspaceReducer(state, {
      type: 'TAIL_VISIBLE', generation: 'g1', ordinal: tailRef.ordinal, indexedRecords: latestSeq,
    });
    expect(state.seenSeq).toBe(latestSeq);
    expect(state.unseenActivity).toBe(false);
  });

  it('seeds the Follow seen watermark from the accepted latest index', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', { ...summary, indexedRecords: '2' }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('INDEX_PROGRESS', { ...summary, indexedRecords: '3' }),
    });
    expect(state.unseenActivity).toBe(true);
    state = workspaceReducer(state, { type: 'SET_FOLLOW_MODE', enabled: true });
    expect(state.seenSeq).toBe('3');
    expect(state.unseenActivity).toBe(false);
  });

  it('keeps append activity through recovery but resets it across destructive snapshot replacement', () => {
    let state = workspaceReducer(createInitialState({ followMode: true }), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('INDEX_PROGRESS', { ...summary, indexedRecords: '3' }),
    });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }) });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      ...envelope('OPENED', { ...summary, snapshot: { ...summary.snapshot, generation: 'g2' }, indexedRecords: '0', indexingComplete: false }),
      generation: 'g2',
    } });
    expect(state.latestSeq).toBe('3');
    expect(state.unseenActivity).toBe(true);
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: { ...envelope('SOURCE_INVALIDATED', { reason: 'replace' }), generation: 'g2' } });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      ...envelope('OPENED', { ...summary, snapshot: { ...summary.snapshot, generation: 'g3' }, indexedRecords: '1' }), generation: 'g3',
    } });
    expect(state.latestSeq).toBe('1');
    expect(state.seenSeq).toBe('1');
    expect(state.unseenActivity).toBe(false);
  });

  it('rejects a retained old-generation selection without removing recovery state', () => {
    let state = workspaceReducer(createInitialState({ followMode: true }), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[1]!.ref });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('DETAIL', {
        ref: rows[1]!.ref, rawPreview: 'cached old generation', rawComplete: true, problems: [],
      }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: {
        ...envelope('OPENED', { ...summary, snapshot: { ...summary.snapshot, generation: 'g2' } }),
        generation: 'g2',
      },
    });
    expect(state.detailStale).toBe(true);
    expect(state.selectedRef?.generation).toBe('g2');
    expect(workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[1]!.ref })).toBe(state);
    expect(workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '1' })).toBe(state);
    const recovery = state.rebuildDetail;
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: { ...envelope('ERROR', {
        code: 'DETAIL_FAILED', message: 'Synthetic recovery failure', recoverable: true,
      }), generation: 'g2' },
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: {
        ...envelope('OPENED', { ...summary, snapshot: { ...summary.snapshot, generation: 'g2' } }), generation: 'g2',
      },
    });
    expect(state.detailStale).toBe(true);
    expect(state.rebuildDetail).toEqual(recovery);
    expect(state.detail?.ref.generation).toBe('g1');
  });

  it.each([true, false])('keeps explicit detail selection independent of descending page=%s', (descendingPage) => {
    let state = workspaceReducer(createInitialState({ followMode: true, sortDirection: 'desc' }), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('ROWS', {
        rows: descendingPage ? [...rows].reverse() : rows, columns: [], anchorOrdinal: '2',
        hasBefore: false, hasAfter: false, indexedRecords: '2',
      }),
    });
    expect(state.selectedRef).toEqual((descendingPage ? rows[1] : rows[0])!.ref);
    expect(state.detailOpen).toBe(false);
    state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[0]!.ref });
    expect(state.detailFollow).toBe(false);
    state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[1]!.ref });
    expect(state.detailFollow).toBe(false);
  });

  it.each([false, true])('replaces stale projections on a same-generation newer epoch (invalidated=%s)', (invalidated) => {
    const initialSummary = { ...summary, snapshot: { ...summary.snapshot, epoch: 1 } };
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: { ...envelope('OPENED', initialSummary), epoch: 1 },
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { id: 'old-detail', kind: 'detail' } });
    if (invalidated) state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'replace' }),
    });

    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, epoch: 2 } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: { ...envelope('OPENED', nextSummary), epoch: 2 },
    });
    expect(state.summary?.snapshot.epoch).toBe(2);
    expect(state.invalidationReason).toBeUndefined();
    expect(state.rows).toEqual([]);
    expect(state.selectedOrdinal).toBeUndefined();
    expect(state.pending).toEqual({});
    expect(state.phase).toBe('ready');
  });

  it('clears the Follow viewport when the document changes even if its generation matches', () => {
    let state = workspaceReducer(createInitialState({ followMode: true }), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, documentId: 'other-document' } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: { ...envelope('OPENED', nextSummary), documentId: 'other-document' },
    });
    expect(state.rows).toEqual([]);
    expect(state.page).toBeUndefined();
    expect(state.selectedOrdinal).toBeUndefined();
    expect(state.summary?.snapshot.documentId).toBe('other-document');
  });

  it('resets generation-bound projections when a new document generation opens', () => {
    let state = createInitialState();
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: false,
        indexedRecords: '2',
        totalRecords: '2',
      }),
    });

    const nextSummary = {
      ...summary,
      snapshot: { ...summary.snapshot, generation: 'g2' },
    };
    const next = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: {
        ...envelope('OPENED', nextSummary),
        generation: 'g2',
      },
    });

    expect(next.rows).toEqual([]);
    expect(next.selectedOrdinal).toBeUndefined();
    expect(next.summary?.snapshot.generation).toBe('g2');
  });

  it('keeps the selected detail mounted through a manual rebuild and refreshes it by physical identity', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', { rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }),
    });
    const oldDetail: RecordDetail = {
      ref: rows[1]!.ref, rawPreview: '{"event":"old"}', rawComplete: true, problems: [],
    };
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('DETAIL', oldDetail) });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'rebuild', id: 'rebuild-1' } });

    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2 } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2, requestId: 'rebuild-1' },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toEqual(oldDetail);
    expect(state.detailStale).toBe(true);

    const refreshedRows = rows.map((row) => ({ ...row, ref: { ...row.ref, generation: 'g2' } }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: {
        ...envelope('ROWS', { rows: refreshedRows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }),
        generation: 'g2', requestId: 'rows-g2',
      },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toEqual(oldDetail);
    expect(state.detailStale).toBe(true);

    const newDetail: RecordDetail = {
      ...oldDetail, ref: refreshedRows[1]!.ref, rawPreview: '{"event":"new"}',
    };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('DETAIL', newDetail), generation: 'g2', requestId: 'detail-g2' },
    });
    expect(state.detail).toEqual(newDetail);
    expect(state.detailStale).toBe(false);
    expect(state.rebuildDetail).toBeUndefined();
  });

  it('admits a rebased detail before the replacement rows page arrives', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', { rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    const oldDetail: RecordDetail = { ref: rows[1]!.ref, rawPreview: '{"event":"old"}', rawComplete: true, problems: [] };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('DETAIL', oldDetail) });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'rebuild', id: 'rebuild-before-rows' } });
    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2 } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2, requestId: 'rebuild-before-rows' },
    });
    const refreshed: RecordDetail = {
      ...oldDetail, ref: { ...oldDetail.ref, generation: 'g2' }, rawPreview: '{"event":"new-before-rows"}',
    };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('DETAIL', refreshed), generation: 'g2', requestId: 'detail-g2-before-rows' },
    });
    expect(state.detail).toEqual(refreshed);
    expect(state.detailStale).toBe(false);
  });

  it('falls back when a rebuild reuses an ordinal at a different physical offset', () => {
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', { rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'rebuild', id: 'rebuild-2' } });
    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2 } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2, requestId: 'rebuild-2' },
    });
    const movedRows = rows.map((row, index) => ({
      ...row, ref: { ...row.ref, generation: 'g2', byteStart: String(index * 30), byteEndExclusive: String(index * 30 + 20) },
    }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('ROWS', { rows: movedRows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }), generation: 'g2' },
    });
    expect(state.selectedOrdinal).toBe('1');
    expect(state.detail).toBeUndefined();
    expect(state.rebuildDetail).toBeUndefined();
  });

  it('keeps a closed detail drawer closed while retaining the selected row', () => {
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', { rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'rebuild', id: 'rebuild-closed' } });
    expect(state.rebuildDetail).toBeUndefined();
    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2 } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2, requestId: 'rebuild-closed' },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toBeUndefined();
    const refreshedRows = rows.map((row) => ({ ...row, ref: { ...row.ref, generation: 'g2' } }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('ROWS', { rows: refreshedRows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2' }), generation: 'g2' },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toBeUndefined();
  });

  it('keeps the prior follow viewport visible until the new tail page swaps in', () => {
    let state = createInitialState({ followMode: true });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [{ id: 'summary', label: 'Summary', source: 'profile' }],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: false,
        indexedRecords: '2',
        totalRecords: '2',
      }),
    });

    const nextSummary = { ...summary, snapshot: { ...summary.snapshot, generation: 'g2' } };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2' },
    });
    expect(state.rows).toEqual(rows);
    expect(state.columns).toHaveLength(1);
    expect(state.summary?.snapshot.generation).toBe('g2');

    const refreshedRows = rows.map((row, index) => ({
      ...row,
      ref: { ...row.ref, generation: 'g2', ordinal: String(index + 2) },
    }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: {
        ...envelope('ROWS', {
          rows: refreshedRows,
          columns: [{ id: 'summary', label: 'Summary', source: 'profile' }],
          anchorOrdinal: '2',
          hasBefore: true,
          hasAfter: false,
          indexedRecords: '3',
          totalRecords: '3',
        }),
        generation: 'g2',
      },
    });
    expect(state.rows).toEqual(refreshedRows);
    expect(state.selectedOrdinal).toBe('2');
  });

  it('keeps a followed physical selection and drawer mounted across auto-adopt', () => {
    let state = createInitialState({ followMode: true });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    const oldDetail: RecordDetail = {
      ref: rows[1]!.ref, rawPreview: '{"event":"old"}', rawComplete: true, problems: [],
    };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('DETAIL', oldDetail) });

    const nextSummary = {
      ...summary,
      snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2, sizeBytes: '8192' },
    };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2 },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toEqual(oldDetail);
    expect(state.detailStale).toBe(true);
    expect(state.rebuildDetail?.ref.byteStart).toBe(rows[1]!.ref.byteStart);
    expect(state.rebuildDetail?.ref.generation).toBe('g2');

    const refreshedRows = rows.map((row) => ({ ...row, ref: { ...row.ref, generation: 'g2' } }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: {
        ...envelope('ROWS', {
          rows: refreshedRows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
          indexedRecords: '3', totalRecords: '3',
        }),
        generation: 'g2',
      },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toEqual(oldDetail);

    const hydrated: RecordDetail = {
      ...oldDetail, ref: refreshedRows[1]!.ref, rawPreview: '{"event":"new"}',
    };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('DETAIL', hydrated), generation: 'g2' },
    });
    expect(state.detail).toEqual(hydrated);
    expect(state.detailStale).toBe(false);
  });

  it('pins an explicitly opened detail when the new tail page arrives', () => {
    let state = createInitialState({ followMode: true });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    const oldDetail: RecordDetail = {
      ref: rows[1]!.ref, rawPreview: '{"event":"old"}', rawComplete: true, problems: [],
    };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('DETAIL', oldDetail) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });

    const nextSummary = {
      ...summary, snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2, sizeBytes: '8192' },
    };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2 },
    });
    const tailRows = rows.map((row, index) => ({
      ...row, ref: { ...row.ref, generation: 'g2', ordinal: String(index + 3), byteStart: String(40 + index * 20),
        byteEndExclusive: String(60 + index * 20) },
    }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('ROWS', {
        rows: tailRows, columns: [], anchorOrdinal: '3', hasBefore: true, hasAfter: false,
        indexedRecords: '4', totalRecords: '4',
      }), generation: 'g2' },
    });

    expect(state.rows).toEqual(tailRows);
    expect(state.selectedOrdinal).toBe('2');
    expect(state.selectedRef).toEqual({ ...rows[1]!.ref, generation: 'g2' });
    expect(state.detail).toEqual(oldDetail);
    expect(state.detailStale).toBe(true);
    expect(state.rebuildDetail?.ref.ordinal).toBe('2');
    expect(state.detailOpen).toBe(true);
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { id: 'manual-rebuild', kind: 'rebuild' } });
    expect(state.rebuildSelection?.ref.ordinal).toBe('2');
    expect(state.rebuildDetail?.ref.ordinal).toBe('2');
  });

  it('keeps transient non-follow detail mounted when recovery publishes a generation', () => {
    let state = createInitialState();
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    const oldDetail: RecordDetail = {
      ref: rows[1]!.ref, rawPreview: '{"event":"old"}', rawComplete: true, problems: [],
    };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('DETAIL', oldDetail) });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'detail', id: 'moving-detail' } });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ERROR', {
        code: 'SOURCE_UPDATING', message: 'The source is still changing.', recoverable: true,
      }),
    });

    const nextSummary = {
      ...summary,
      snapshot: { ...summary.snapshot, generation: 'g2', epoch: 2, sizeBytes: '8192' },
    };
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', nextSummary), generation: 'g2', epoch: 2 },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toEqual(oldDetail);
    expect(state.detailStale).toBe(true);

    const refreshedRows = rows.map((row) => ({ ...row, ref: { ...row.ref, generation: 'g2' } }));
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: {
        ...envelope('ROWS', {
          rows: refreshedRows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
          indexedRecords: '3', totalRecords: '3',
        }),
        generation: 'g2',
      },
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail?.ref.ordinal).toBe('2');
  });

  it('keeps selectors bounded to the current page', () => {
    let state = createInitialState();
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: false,
        indexedRecords: '2',
      }),
    });

    expect(selectTimelineRows(state)).toHaveLength(1);
    expect(selectProblems(state)).toEqual([
      expect.objectContaining({ code: 'invalid_json', ordinal: '2' }),
    ]);
  });

  it('stores an independent problem page without replacing the visible row page', () => {
    let state = createInitialState();
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: true,
        indexedRecords: '2',
      }),
    });
    const problems = {
      items: [{ code: 'BLANK_RECORD', message: 'blank', severity: 'warning' as const, ref: rows[1]!.ref }],
      anchorOrdinal: '4',
      hasBefore: true,
      hasAfter: true,
      indexedRecords: '5',
      observedProblemRecords: '1',
      complete: false,
      scan: { examinedRecords: '5', examinedBytes: '50', cursorOrdinal: '4', direction: 'forward' as const },
    };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('PROBLEMS', problems) });

    expect(state.rows).toEqual(rows);
    expect(state.problems).toEqual(problems);
    expect(selectProblems(state)).toEqual([
      expect.objectContaining({ code: 'invalid_json', ordinal: '2' }),
    ]);
  });

  it('advances observed problem records from problem scans without regressing', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED',
      message: envelope('OPENED', summary),
    });
    const page = {
      items: [],
      anchorOrdinal: '16',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '16',
      observedProblemRecords: '16',
      complete: true,
      scan: { examinedRecords: '16', examinedBytes: '160', cursorOrdinal: '16', direction: 'forward' as const },
    };

    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('PROBLEMS', page) });
    expect(state.summary?.problemRecords).toBe('16');

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('PROBLEMS', { ...page, observedProblemRecords: '8' }),
    });
    expect(state.summary?.problemRecords).toBe('16');
  });

  it('marks invalidated and recoverable-error states explicitly', () => {
    let state = createInitialState();
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('SOURCE_INVALIDATED', { reason: 'truncate' }),
    });
    expect(state.phase).toBe('invalidated');
    expect(state.invalidationReason).toBe('truncate');

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ERROR', { code: 'query_failed', message: 'Bad query', recoverable: true }),
    });
    expect(state.phase).toBe('invalidated');
    expect(state.error?.code).toBe('query_failed');
  });

  it('keeps verified append snapshots readable without adopting the new generation', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: false,
        indexedRecords: '2',
      }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.blockedDetailOrdinal).toBeUndefined();

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', {
        ref: rows[1]!.ref,
        rawPreview: 'invalid record',
        rawComplete: true,
        problems: [],
      }),
    });
    expect(state.detail?.ref.ordinal).toBe('2');
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows: [rows[0]!],
        columns: [],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: true,
        indexedRecords: '2',
      }),
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail?.ref.ordinal).toBe('2');
    expect(state.invalidationReason).toBe('append');
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows: [rows[1]!],
        columns: [],
        anchorOrdinal: '2',
        hasBefore: true,
        hasAfter: false,
        indexedRecords: '2',
      }),
    });
    expect(state.rows).toHaveLength(1);
    expect(state.detail?.ref.ordinal).toBe('2');
    expect(state.phase).toBe('invalidated');
    expect(state.invalidationReason).toBe('append');
    expect(state.summary?.snapshot.generation).toBe('g1');

    const sameGenerationOpened = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    expect(sameGenerationOpened).toEqual(state);
  });

  it('does not relabel a newer append selection with a cancelled detail response', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '1' });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', {
        ref: rows[0]!.ref, rawPreview: '{"event":"one"}', rawComplete: true, problems: [],
      }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', {
        ref: rows[0]!.ref, rawPreview: '{"event":"stale"}', rawComplete: true, problems: [],
      }),
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toBeUndefined();

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', {
        ref: rows[1]!.ref, rawPreview: '{"event":"two"}', rawComplete: true, problems: [],
      }),
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail?.rawPreview).toBe('{"event":"two"}');
  });

  it('rejects a detail payload whose coordinates do not match the selected row', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false,
        indexedRecords: '2', totalRecords: '2',
      }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', {
        ref: { ...rows[1]!.ref, byteStart: '999', byteEndExclusive: '1001' },
        rawPreview: '{"event":"wrong-physical-record"}', rawComplete: true, problems: [],
      }),
    });
    expect(state.selectedOrdinal).toBe('2');
    expect(state.detail).toBeUndefined();
  });

  it('preserves in-flight reads across append hints but cancels them on replacement', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'REQUEST_SENT', request: { kind: 'rows', id: 'rows-1' },
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    expect(state.pending.rows?.id).toBe('rows-1');
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    expect(state.pending.rows?.id).toBe('rows-1');
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'replace' }),
    });
    expect(state.pending.rows).toBeUndefined();
    expect(state.invalidationReason).toBe('replace');
  });

  it('keeps a blocked selection visible when a pending detail read is cancelled', () => {
    let state = workspaceReducer(createInitialState(), { type: 'SELECT_ROW', ordinal: '1' });
    state = workspaceReducer(state, {
      type: 'REQUEST_SENT', request: { kind: 'detail', id: 'detail-1' },
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'truncate' }),
    });
    expect(state.pending.detail).toBeUndefined();
    expect(state.blockedDetailOrdinal).toBe('1');
  });

  it('retains already-hydrated detail only as a blocked-generation cache', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'SELECT_ROW', ref: rows[0]!.ref, ordinal: rows[0]!.ref.ordinal,
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', { ref: rows[0]!.ref, rawPreview: 'old content', rawComplete: true, problems: [] }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'replace' }),
    });
    expect(state.detail?.rawPreview).toBe('old content');
    expect(state.detail?.ref.generation).toBe('g1');
    expect(state.selectedOrdinal).toBe(rows[0]!.ref.ordinal);
    expect(state.invalidationReason).toBe('replace');
    expect(state.blockedDetailOrdinal).toBeUndefined();

    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: rows[1]!.ref.ordinal });
    expect(state.detail).toBeUndefined();
    expect(state.blockedDetailOrdinal).toBe(rows[1]!.ref.ordinal);
  });

  it('allows a verified append after uncertainty but never after destructive invalidation', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'unknown' }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    expect(state.invalidationReason).toBe('append');

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'truncate' }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    expect(state.invalidationReason).toBe('truncate');
  });

  it('explains a failed append detail read and allows a new selection', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('SOURCE_INVALIDATED', { reason: 'append' }),
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    state = workspaceReducer(state, {
      type: 'REQUEST_SENT', request: { kind: 'detail', id: 'request-1' },
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ERROR', { code: 'REQUEST_FAILED', message: 'Source changed.', recoverable: true }),
    });
    expect(state.blockedDetailOrdinal).toBe('2');
    expect(state.error?.code).toBe('REQUEST_FAILED');
    expect(state.phase).toBe('invalidated');

    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '1' });
    expect(state.blockedDetailOrdinal).toBeUndefined();
    expect(state.selectedOrdinal).toBe('1');
  });

  it('keeps the current snapshot mounted while the source is moving', () => {
    let state = workspaceReducer(createInitialState(), {
      type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
      }),
    });
    const selected = rows[1]!;
    state = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: selected.ref.ordinal });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('DETAIL', {
        ref: selected.ref, value: { value: 2 }, rawPreview: '{"value":2}', rawComplete: true, problems: [],
      }),
    });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'detail', id: 'moving-1' } });
    const moving = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ERROR', {
        code: 'SOURCE_UPDATING',
        message: 'The source is still changing.',
        recoverable: true,
      }),
    });
    expect(moving.detail?.ref.ordinal).toBe(selected.ref.ordinal);
    expect(moving.blockedDetailOrdinal).toBeUndefined();
    expect(moving.error).toMatchObject({ code: 'SOURCE_UPDATING' });
    expect(moving.invalidationReason).toBeUndefined();
    expect(moving.selectedOrdinal).toBe(selected.ref.ordinal);
  });

  it('keeps an invalidated generation blocked until a new snapshot opens', () => {
    let state = createInitialState();
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('OPENED', summary) });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [],
        anchorOrdinal: '1',
        hasBefore: false,
        hasAfter: false,
        indexedRecords: '2',
      }),
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('SOURCE_INVALIDATED', { reason: 'replace' }),
    });

    const invalidated = state;
    const lateProgress = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('INDEX_PROGRESS', { ...summary, indexingComplete: true }),
    });
    const lateRows = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows: [],
        columns: [],
        anchorOrdinal: '2',
        hasBefore: true,
        hasAfter: false,
        indexedRecords: '3',
      }),
    });
    const lateProfile = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('PROFILE_CHANGED', { profileId: 'codex', columns: [] }),
    });
    const sameGenerationOpened = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('OPENED', summary),
    });

    expect(lateProgress).toEqual(invalidated);
    expect(lateRows).toEqual(invalidated);
    expect(lateProfile).toEqual(invalidated);
    expect(sameGenerationOpened).toEqual(invalidated);

    const blockedSelection = workspaceReducer(state, { type: 'SELECT_ROW', ordinal: '2' });
    expect(blockedSelection.selectedOrdinal).toBe('2');
    expect(blockedSelection.blockedDetailOrdinal).toBe('2');
    expect(blockedSelection.detail).toBeUndefined();
    expect(workspaceReducer(blockedSelection, { type: 'CLOSE_DETAIL' }).blockedDetailOrdinal).toBeUndefined();

    const dismissed = workspaceReducer(
      workspaceReducer(state, {
        type: 'MESSAGE_RECEIVED',
        message: envelope('ERROR', { code: 'rebuild_failed', message: 'retry', recoverable: true }),
      }),
      { type: 'DISMISS_ERROR' },
    );
    expect(dismissed.phase).toBe('invalidated');
    expect(dismissed.invalidationReason).toBe('replace');

    const next = { ...summary, snapshot: { ...summary.snapshot, generation: 'g2' } };
    const recovered = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: { ...envelope('OPENED', next), generation: 'g2' },
    });
    expect(recovered.phase).toBe('ready');
    expect(recovered.invalidationReason).toBeUndefined();
  });

  it('persists the user-selected detail pane width', () => {
    const state = workspaceReducer(createInitialState(), { type: 'SET_DETAIL_WIDTH', width: 704 });

    expect(state.detailWidth).toBe(704);
    expect(toPersistedState(state).detailWidth).toBe(704);
  });

  it('restores physical row-order preference independently from an ascending preview', () => {
    let state = createInitialState({ sortDirection: 'desc' });
    expect(state.sort).toEqual({ columnId: '__ordinal', direction: 'desc' });
    state = workspaceReducer(state, { type: 'SET_SORT', sort: undefined });
    expect(state.sortDirection).toBe('desc');
    expect(toPersistedState(state).sortDirection).toBe('desc');

    state = workspaceReducer(state, { type: 'SET_SORT_DIRECTION', direction: 'asc' });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROW_ORDER_CHANGED', { direction: 'desc' }),
    });
    expect(state.sortDirection).toBe('asc');
  });

  it('retains a hidden schema field after the next projected page omits it', () => {
    let state = createInitialState();
    const column = { id: JSON.stringify([{ kind: 'key', value: 'message' }, { kind: 'key', value: 'role' }]), label: '$.message.role', source: 'record' as const };
    state = workspaceReducer(state, { type: 'SET_COLUMN_VISIBILITY', columnId: column.id, visible: false });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows, columns: [], anchorOrdinal: '2', hasBefore: false, hasAfter: false, indexedRecords: '3',
      }),
    });
    expect(state.columnVisibility[column.id]).toBe(false);
  });

  it('stores bounded insight results and clears them when the dimension changes', () => {
    let state = createInitialState();
    const intent: AnalysisIntentV1 = { version: 1, intentRevision: 1, dimension: 'eventKind',
      scope: 'current-view', document: { documentId: 'doc', generation: 'g1' },
      profile: { id: 'generic', version: '1' } };
    state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('INSIGHTS', {
        intent,
        provenance: { scope: 'current-view', predicateApplied: false, coverage: 'complete' },
        categories: [{ label: 'message', count: 2 }],
        timeBuckets: [{ start: '2026-08-30T00:00:00.000Z', count: 2 }],
        processedRecords: '2',
        examinedRecords: '4',
        examinedBytes: '256',
        truncated: false,
        capacityReached: false,
        bucketWidthMs: 300_000,
      }),
    });
    expect(state.insights?.categories[0]).toEqual({ label: 'message', count: 2 });

    state = workspaceReducer(state, { type: 'SET_INSIGHT_DIMENSION', dimension: 'severity' });
    expect(state.insightDimension).toBe('severity');
    expect(state.insights).toBeUndefined();
  });

  it.each<[string, WorkspaceAction]>([
    ['text query', { type: 'SET_QUERY', query: 'new query' }],
    ['field filter', { type: 'SET_FILTERS', filters: [{
      columnId: 'status', source: 'profile', operator: 'eq', value: 'failed',
    }] }],
    ['row type', { type: 'SET_ROW_TYPES', rowTypes: {
      column: { id: 'eventKind', label: 'Event', source: 'profile' }, values: ['tool_call'],
    } }],
    ['profile', { type: 'MESSAGE_RECEIVED', message: envelope('PROFILE_CHANGED', {
      profileId: 'codex', profileVersion: '2', columns: [],
    }) }],
    ['scope', { type: 'SET_INSIGHT_SCOPE', scope: 'whole-file' }],
  ])('rejects delayed old Insights after changing %s, including after a new intent is active', (_, change) => {
    const oldIntent: AnalysisIntentV1 = { version: 1, intentRevision: 10, dimension: 'eventKind',
      scope: 'current-view', document: { documentId: 'doc', generation: 'g1' },
      profile: { id: 'generic', version: '1' } };
    const result: InsightSummary = { intent: oldIntent,
      provenance: { scope: 'current-view', predicateApplied: false, coverage: 'complete' },
      categories: [{ label: 'old', count: 99 }], timeBuckets: [], processedRecords: '99',
      examinedRecords: '99', examinedBytes: '990', truncated: false, capacityReached: false, bucketWidthMs: 300_000 };
    let state = createInitialState();
    state = { ...state, summary };
    state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent: oldIntent });
    state = workspaceReducer(state, change);
    expect(state.analysisIntentRevision).toBe(11);
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('INSIGHTS', result) });
    expect(state.insights).toBeUndefined();

    const newIntent = { ...oldIntent, intentRevision: 12 };
    state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent: newIntent });
    const nextResult = { ...result, intent: newIntent, categories: [{ label: 'new', count: 1 }] };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('INSIGHTS', nextResult) });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('INSIGHTS', result) });
    expect(state.insights?.categories).toEqual([{ label: 'new', count: 1 }]);
    expect(state.analysisIntent).toEqual(newIntent);
  });

  it('keeps display projection changes outside the analysis intent and persists explicit scope', () => {
    expect(createInitialState().insightScope).toBe('current-view');
    const restored = createInitialState({ insightScope: 'whole-file' });
    expect(toPersistedState(restored).insightScope).toBe('whole-file');
    const intent: AnalysisIntentV1 = { version: 1, intentRevision: 1, dimension: 'eventKind',
      scope: 'current-view', document: { documentId: 'doc', generation: 'g1' },
      profile: { id: 'generic', version: '1' } };
    let state = workspaceReducer(createInitialState(), { type: 'SET_ANALYSIS_INTENT', intent });
    state = workspaceReducer(state, { type: 'SET_COLUMN_VISIBILITY', columnId: 'status', visible: false });
    expect(state.analysisIntent).toEqual(intent);
    expect(state.analysisIntentRevision).toBe(1);
  });

  it('blocks analysis reissuance while a selected profile is awaiting the host', () => {
    const intent: AnalysisIntentV1 = { version: 1, intentRevision: 1, dimension: 'eventKind',
      scope: 'current-view', document: { documentId: 'doc', generation: 'g1' },
      profile: { id: 'generic', version: '1' } };
    let state = workspaceReducer(createInitialState(), { type: 'SET_ANALYSIS_INTENT', intent });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'profile', id: 'profile-pending' } });
    expect(state.analysisIntent).toBeUndefined();
    expect(state.analysisIntentRevision).toBe(2);
    state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent: { ...intent, intentRevision: 3 } });
    expect(state.analysisIntent).toBeUndefined();
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      ...envelope('PROFILE_CHANGED', { profileId: 'codex', profileVersion: '2', columns: [] }),
      requestId: 'profile-pending',
    } });
    expect(state.pending.profile).toBeUndefined();
    const nextIntent = { ...intent, intentRevision: 4, profile: { id: 'codex', version: '2' } };
    state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent: nextIntent });
    expect(state.analysisIntent).toEqual(nextIntent);
  });

  it.each(['STALE_ANALYSIS_INTENT', 'REQUEST_FAILED'])(
    'remembers the correlated failed analysis conditions for %s', (code) => {
      const intent: AnalysisIntentV1 = { version: 1, intentRevision: 1, dimension: 'eventKind',
        scope: 'current-view', document: { documentId: 'doc', generation: 'g1' },
        profile: { id: 'generic', version: '1' } };
      let state = workspaceReducer(createInitialState(), { type: 'SET_ANALYSIS_INTENT', intent });
      state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { kind: 'insights', id: 'analysis' } });
      state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
        ...envelope('ERROR', { code, message: 'failed', recoverable: true }), requestId: 'analysis',
      } });
      expect(state.pending.insights).toBeUndefined();
      expect(state.failedAnalysisIntent).toEqual(intent);
    },
  );

  it.each(['OPENED', 'INDEX_PROGRESS'] as const)(
    'invalidates delayed Insights when %s changes source epoch or profile identity', (type) => {
      const initialSummary = { ...summary, profileVersion: '1', snapshot: { ...summary.snapshot, epoch: 1 } };
      const intent: AnalysisIntentV1 = { version: 1, intentRevision: 1, dimension: 'eventKind',
        scope: 'current-view', document: { documentId: initialSummary.snapshot.documentId,
          generation: initialSummary.snapshot.generation, sourceEpoch: 1 },
        profile: { id: initialSummary.profileId, version: '1' } };
      const result: InsightSummary = { intent,
        provenance: { scope: 'current-view', predicateApplied: false, coverage: 'complete' },
        categories: [{ label: 'old', count: 2 }], timeBuckets: [], processedRecords: '2',
        examinedRecords: '2', examinedBytes: '200', truncated: false, capacityReached: false, bucketWidthMs: 300_000 };
      for (const nextSummary of [
        { ...initialSummary, snapshot: { ...initialSummary.snapshot, epoch: 2 } },
        { ...initialSummary, profileId: 'changed' },
        { ...initialSummary, profileVersion: '2' },
      ]) {
        let state = createInitialState();
        state = { ...state, summary: initialSummary };
        state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent });
        state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('INSIGHTS', result) });
        expect(state.insights).toBe(result);
        state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope(type, nextSummary) });
        expect(state.analysisIntent).toBeUndefined();
        expect(state.insights).toBeUndefined();
        state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: envelope('INSIGHTS', result) });
        expect(state.insights).toBeUndefined();
        expect(state.summary).toBe(nextSummary);
      }
    },
  );

  it('keeps ordinal first while persisting sort, filter, and column order', () => {
    let state = createInitialState();
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('ROWS', {
        rows,
        columns: [
          { id: 'name', label: 'Name', source: 'record' },
          { id: 'status', label: 'Status', source: 'record' },
        ],
        anchorOrdinal: '2',
        hasBefore: false,
        hasAfter: false,
        indexedRecords: '3',
      }),
    });
    state = workspaceReducer(state, { type: 'SET_COLUMN_ORDER', order: ['status', '__ordinal', 'name'] });
    state = workspaceReducer(state, { type: 'SET_COLUMN_VISIBILITY', columnId: '__ordinal', visible: false });
    state = workspaceReducer(state, { type: 'SET_SORT', sort: { columnId: 'status', direction: 'desc' } });
    state = workspaceReducer(state, {
      type: 'SET_FILTER',
      filter: { columnId: 'status', operator: 'eq', value: 'error' },
    });

    expect(state.columnOrder).toEqual(['status', 'name']);
    expect(state.columnVisibility.__ordinal).not.toBe(false);
    expect(toPersistedState(state)).toMatchObject({
      sort: { columnId: 'status', direction: 'desc' },
      filter: { columnId: 'status', operator: 'eq', value: 'error' },
      columnOrder: ['status', 'name'],
      sortOffset: '0',
      sortOffsetHistory: [],
      sortPage: '1',
    });
  });

  it('clears profile query fields missing from the new profile and resets sorted paging', () => {
    let state = createInitialState({
      sort: { columnId: 'status', direction: 'asc' },
      filter: { columnId: 'status', operator: 'eq', value: 'working', source: 'profile' },
      sortOffset: '7',
      sortOffsetHistory: ['0', '3'],
      sortPage: '3',
    });
    state = {
      ...state,
      columns: [{ id: 'status', label: 'Status', source: 'profile' }],
    };

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('PROFILE_CHANGED', {
        profileId: 'other-profile',
        columns: [{ id: 'summary', label: 'Summary', source: 'profile' }],
      }),
    });

    expect(state.sort).toBeUndefined();
    expect(state.filter).toBeUndefined();
    expect(state.sortOffset).toBe('0');
    expect(state.sortOffsetHistory).toEqual([]);
    expect(state.sortPage).toBe('1');
  });

  it('preserves compatible profile and record query fields across a profile change', () => {
    const recordPath = keyPath('requestId');
    let state = createInitialState({
      sort: { columnId: 'summary', direction: 'desc' },
      filter: {
        columnId: JSON.stringify(recordPath.tokens),
        operator: 'contains',
        value: 'req-',
        source: 'record',
        path: recordPath,
      },
      sortOffset: '7',
      sortOffsetHistory: ['0', '3'],
      sortPage: '3',
    });
    state = {
      ...state,
      columns: [
        { id: 'summary', label: 'Summary', source: 'profile' },
        { id: JSON.stringify(recordPath.tokens), label: 'requestId', source: 'record', path: recordPath },
      ],
    };

    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('PROFILE_CHANGED', {
        profileId: 'compatible-profile',
        columns: [{ id: 'summary', label: 'Summary', source: 'profile' }],
      }),
    });

    expect(state.sort).toEqual({ columnId: 'summary', direction: 'desc' });
    expect(state.filter).toMatchObject({ source: 'record', path: recordPath });
    expect(state.sortOffset).toBe('0');
    expect(state.sortOffsetHistory).toEqual([]);
    expect(state.sortPage).toBe('1');
  });

  it('persists a logical sorted page independently from its continuation offset', () => {
    expect(createInitialState({
      sort: { columnId: 'status', direction: 'asc' },
      sortOffset: '300',
    }).sortPage).toBe('4');

    let state = createInitialState({
      sort: { columnId: 'status', direction: 'asc' },
      sortOffset: '300',
      sortPage: '4',
    });
    state = workspaceReducer(state, {
      type: 'SET_SORT_OFFSET',
      offset: '303',
      history: ['300'],
      page: '5',
    });

    expect(toPersistedState(state)).toMatchObject({
      sortOffset: '303',
      sortOffsetHistory: ['300'],
      sortPage: '5',
    });
  });
});
