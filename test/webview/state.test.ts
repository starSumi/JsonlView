import { describe, expect, it } from 'vitest';
import type { DocumentSummary, ExtensionMessage, RowProjection } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import {
  createInitialState,
  selectProblems,
  selectTimelineRows,
  toPersistedState,
  workspaceReducer,
} from '../../src/webview/state';

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
    expect(state.selectedOrdinal).toBe('3');
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
    expect(state.phase).toBe('degraded');
    expect(state.error?.code).toBe('query_failed');
  });

  it('persists the user-selected detail pane width', () => {
    const state = workspaceReducer(createInitialState(), { type: 'SET_DETAIL_WIDTH', width: 704 });

    expect(state.detailWidth).toBe(704);
    expect(toPersistedState(state).detailWidth).toBe(704);
  });

  it('stores bounded insight results and clears them when the dimension changes', () => {
    let state = createInitialState();
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: envelope('INSIGHTS', {
        dimension: 'eventKind',
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
});
