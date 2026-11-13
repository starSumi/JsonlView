import { describe, expect, it } from 'vitest';
import type { DocumentSummary, ExtensionMessage, RecordDetail, RecordRef, RowProjection } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import {
  createInitialState,
  shouldCloseDetailOnEscape,
  workspaceReducer,
  type WorkspaceState,
} from '../../src/webview/state';

const summary: DocumentSummary = {
  snapshot: {
    documentId: 'doc', generation: 'g1', epoch: 1, uri: 'file:///events.jsonl', scheme: 'file',
    sizeBytes: '40', mtimeMs: 1, prefixFingerprint: 'fixture', observedAt: '2026-10-13T00:00:00Z',
  },
  profileId: 'generic', profileSuggestions: [], indexedBytes: '40', indexedRecords: '2',
  indexingComplete: true, validRecords: '2', problemRecords: '0',
};
const rows: RowProjection[] = [0, 1].map((index) => ({
  ref: {
    generation: 'g1', ordinal: String(index + 1), byteStart: String(index * 20),
    byteEndExclusive: String(index * 20 + 20), contentByteLength: '19',
    delimiterByteLength: 1, parseState: 'valid',
  },
  cells: [], genericSummary: `Record ${index + 1}`,
}));

function receive<T extends ExtensionMessage['type']>(
  state: WorkspaceState, type: T,
  payload: Extract<ExtensionMessage, { type: T }>['payload'],
  generation = state.summary?.snapshot.generation ?? 'g1',
): WorkspaceState {
  const message = {
    protocolVersion: PROTOCOL_VERSION, type, documentId: 'doc', generation, requestId: `fixture-${type}`, payload,
  } as Extract<ExtensionMessage, { type: T }>;
  return workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message });
}

function openGeneration(state: WorkspaceState, generation: string, epoch: number): WorkspaceState {
  return receive(state, 'OPENED', {
    ...summary, snapshot: { ...summary.snapshot, generation, epoch, sizeBytes: String(epoch * 40) },
  }, generation);
}

function detail(ref: RecordRef, rawPreview: string): RecordDetail {
  return { ref, rawPreview, rawComplete: true, problems: [] };
}

function inspectedState(followMode: boolean): WorkspaceState {
  let state = receive(createInitialState({ followMode }), 'OPENED', summary);
  state = receive(state, 'ROWS', {
    rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
  });
  state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[1]!.ref, ordinal: '2' });
  return receive(state, 'DETAIL', detail(rows[1]!.ref, 'record two'));
}

describe('detail recovery ownership', () => {
  it.each([false, true])('rebases recovery through consecutive generations (follow=%s)', (followMode) => {
    let state = inspectedState(followMode);
    if (!followMode) state = receive(state, 'ERROR', {
      code: 'SOURCE_UPDATING', message: 'Source is moving.', recoverable: true,
    });
    state = openGeneration(state, 'g2', 2);
    state = openGeneration(state, 'g3', 3);

    expect(state.selectedOrdinal).toBe('2');
    expect(state.selectedRef).toEqual({ ...rows[1]!.ref, generation: 'g3' });
    expect(state.detail?.rawPreview).toBe('record two');
    expect(state.detail?.ref.generation).toBe('g1');
    expect(state.detailStale).toBe(true);
    expect(state.rebuildDetail?.ref).toEqual({ ...rows[1]!.ref, generation: 'g3' });

    state = receive(state, 'DETAIL', detail({ ...rows[1]!.ref, generation: 'g2' }, 'late g2'), 'g2');
    expect(state.detail?.rawPreview).toBe('record two');
    expect(state.detailStale).toBe(true);
    state = receive(state, 'DETAIL', detail({ ...rows[1]!.ref, generation: 'g3' }, 'current g3'), 'g3');
    expect(state.detail?.rawPreview).toBe('current g3');
    expect(state.detailStale).toBe(false);
    expect(state.rebuildDetail).toBeUndefined();

    state = receive(state, 'DETAIL', detail({ ...rows[1]!.ref, generation: 'g2' }, 'late after g3'), 'g2');
    expect(state.detail?.rawPreview).toBe('current g3');
  });

  it('keeps a closed drawer closed when a detail response arrives late', () => {
    let state = openGeneration(inspectedState(true), 'g2', 2);
    state = workspaceReducer(state, { type: 'CLOSE_DETAIL' });
    expect(state.detailOpen).toBe(false);
    state = receive(state, 'DETAIL', detail({ ...rows[1]!.ref, generation: 'g2' }, 'late after close'), 'g2');
    expect(state.detail).toBeUndefined();
    expect(state.rebuildDetail).toBeUndefined();
    expect(state.selectedOrdinal).toBe('2');
    state = openGeneration(state, 'g3', 3);
    expect(state.detail).toBeUndefined();
    expect(state.rebuildDetail).toBeUndefined();
    expect(state.detailOpen).toBe(false);
  });

  it.each(['replace', 'truncate', 'delete'] as const)('does not rebase a Follow detail after %s', (reason) => {
    let state = receive(inspectedState(true), 'SOURCE_INVALIDATED', { reason });
    state = openGeneration(state, 'g2', 2);
    expect(state.detail).toBeUndefined();
    expect(state.rebuildDetail).toBeUndefined();
    expect(state.rows).toEqual([]);
    expect(state.detailOpen).toBe(false);
  });

  it('enables source Follow without opening detail or replacing the clicked record', () => {
    let state = receive(createInitialState({ followMode: true }), 'OPENED', summary);
    state = receive(state, 'ROWS', {
      rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
    });
    expect(state.detailFollow).toBe(false);
    expect(state.detailOpen).toBe(false);
    expect(state.detail).toBeUndefined();

    state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[0]!.ref, ordinal: '1' });
    expect(state.detailOpen).toBe(true);
    expect(state.detailFollow).toBe(false);
    expect(state.selectedRef).toEqual(rows[0]!.ref);
    state = receive(state, 'DETAIL', detail(rows[0]!.ref, 'record one'));

    state = workspaceReducer(state, { type: 'SET_FOLLOW_MODE', enabled: false });
    state = workspaceReducer(state, { type: 'SET_FOLLOW_MODE', enabled: true });
    expect(state.detailFollow).toBe(false);
    state = receive(state, 'ROWS', {
      rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
    });
    expect(state.selectedRef).toEqual(rows[0]!.ref);
    expect(state.detail?.rawPreview).toBe('record one');
  });

  it('keeps table Follow advancing after the detail drawer is closed', () => {
    let state = receive(createInitialState({ followMode: true }), 'OPENED', summary);
    state = receive(state, 'ROWS', {
      rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[1]!.ref, ordinal: '2' });
    state = receive(state, 'DETAIL', detail(rows[1]!.ref, 'record two'));
    state = workspaceReducer(state, { type: 'CLOSE_DETAIL' });
    expect(state.detailOpen).toBe(false);
    expect(state.followMode).toBe(true);
    expect(state.detailFollow).toBe(false);

    const tailRows = rows.map((row, index) => ({
      ...row,
      ref: {
        ...row.ref,
        ordinal: String(index + 3),
        byteStart: String(40 + index * 20),
        byteEndExclusive: String(60 + index * 20),
      },
    }));
    state = receive(state, 'ROWS', {
      rows: tailRows, columns: [], anchorOrdinal: '3', hasBefore: true, hasAfter: false, indexedRecords: '4',
    });
    expect(state.rows).toEqual(tailRows);
    expect(state.detailOpen).toBe(false);
    expect(state.detail).toBeUndefined();
    expect(state.followMode).toBe(true);
  });

  it('lets Escape close a drawer left open by a detail hydration error', () => {
    let state = receive(createInitialState(), 'OPENED', summary);
    state = receive(state, 'ROWS', {
      rows, columns: [], anchorOrdinal: '1', hasBefore: false, hasAfter: false, indexedRecords: '2',
    });
    state = workspaceReducer(state, { type: 'SELECT_ROW', ref: rows[1]!.ref, ordinal: '2' });
    state = workspaceReducer(state, {
      type: 'REQUEST_SENT', request: { id: 'detail-error', kind: 'detail' },
    });
    state = workspaceReducer(state, {
      type: 'MESSAGE_RECEIVED',
      message: {
        protocolVersion: PROTOCOL_VERSION,
        type: 'ERROR',
        documentId: 'doc',
        generation: 'g1',
        requestId: 'detail-error',
        payload: { code: 'DETAIL_FAILED', message: 'Detail hydration failed.', recoverable: true },
      },
    });

    expect(state.detail).toBeUndefined();
    expect(state.pending.detail).toBeUndefined();
    expect(state.blockedDetailOrdinal).toBeUndefined();
    expect(state.detailOpen).toBe(true);
    expect(shouldCloseDetailOnEscape('Escape', state)).toBe(true);
    expect(shouldCloseDetailOnEscape('Enter', state)).toBe(false);
  });
});
