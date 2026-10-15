import { describe, expect, it } from 'vitest';
import type { DocumentSummary, ExtensionMessage } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { createInitialState, workspaceReducer } from '../../src/webview/state';

const summary = (profileEpoch?: number): DocumentSummary => ({
  snapshot: { documentId: 'd', generation: 'g', epoch: 1, uri: 'file:///x', scheme: 'file', sizeBytes: '1', mtimeMs: 0, prefixFingerprint: 'fp', observedAt: '2026-01-01T00:00:00Z' },
  profileId: 'generic', profileVersion: '1.0.0', ...(profileEpoch === undefined ? {} : { profileEpoch }), profileSuggestions: [],
  indexedBytes: '1', indexedRecords: '1', indexingComplete: true, validRecords: '1', problemRecords: '0',
});

function receive(payload: DocumentSummary, type: 'OPENED' | 'INDEX_PROGRESS' = 'INDEX_PROGRESS'): ExtensionMessage {
  return { protocolVersion: PROTOCOL_VERSION, type, documentId: 'd', generation: 'g', epoch: 1, requestId: '', payload };
}

describe('dataset provenance epoch admission', () => {
  it('does not downgrade a live state with a missing or older profile epoch', () => {
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: receive(summary(4), 'OPENED') });
    const before = state;
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: receive(summary()) });
    expect(state).toBe(before);
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: receive(summary(3)) });
    expect(state).toBe(before);
  });

  it('accepts a newer epoch and keeps old fixtures without an epoch compatible', () => {
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: receive(summary()) });
    expect(state.summary?.profileEpoch).toBeUndefined();
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: receive(summary(1)) });
    expect(state.summary?.profileEpoch).toBe(1);
  });

  it('drops a stale PROFILE_CHANGED publication after A to B to A', () => {
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: receive(summary(2), 'OPENED') });
    const stale: ExtensionMessage = {
      protocolVersion: PROTOCOL_VERSION, type: 'PROFILE_CHANGED', documentId: 'd', generation: 'g', epoch: 1, requestId: '',
      payload: { profileId: 'stale', profileVersion: '1.0.0', profileEpoch: 1, columns: [] },
    };
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: stale });
    expect(state.summary?.profileId).toBe('generic');
    expect(state.summary?.profileEpoch).toBe(2);
  });
});
