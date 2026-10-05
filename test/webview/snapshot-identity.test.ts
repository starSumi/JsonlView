import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type DocumentSummary, type ExtensionMessage, type WebviewRequest } from '../../src/shared/types';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';
import { snapshotIdentityChanged } from '../../src/webview/snapshot-identity';
import { createInitialState, workspaceReducer } from '../../src/webview/state';

const identity = { documentId: 'doc', generation: 'opaque-generation-uuid', epoch: 1 };
const summary: DocumentSummary = {
  snapshot: { ...identity, uri: 'file:///synthetic.jsonl', scheme: 'file', sizeBytes: '20', mtimeMs: 1,
    prefixFingerprint: 'synthetic', observedAt: '2026-10-04T00:00:00Z' },
  profileId: 'generic', profileSuggestions: [], indexedBytes: '20', indexedRecords: '1',
  indexingComplete: true, validRecords: '1', problemRecords: '0',
};
const opened = (payload: DocumentSummary, epoch?: number): Extract<ExtensionMessage, { type: 'OPENED' }> => ({
  protocolVersion: PROTOCOL_VERSION, type: 'OPENED', documentId: payload.snapshot.documentId,
  generation: payload.snapshot.generation, requestId: '', payload,
  ...(epoch === undefined ? {} : { epoch }),
});

describe('accepted snapshot identity', () => {
  it('compares opaque identities without imposing numeric generation ordering', () => {
    expect(snapshotIdentityChanged(undefined, identity)).toBe(true);
    expect(snapshotIdentityChanged(identity, { ...identity })).toBe(false);
    expect(snapshotIdentityChanged(identity, { ...identity, documentId: 'other' })).toBe(true);
    expect(snapshotIdentityChanged(identity, { ...identity, generation: '000-earlier-looking-uuid' })).toBe(true);
    expect(snapshotIdentityChanged(identity, { ...identity, epoch: 2 })).toBe(true);
  });

  it('preserves optional-epoch compatibility in both directions', () => {
    const legacy = { documentId: identity.documentId, generation: identity.generation };
    expect(snapshotIdentityChanged(legacy, identity)).toBe(false);
    expect(snapshotIdentityChanged(identity, legacy)).toBe(false);
    expect(snapshotIdentityChanged(legacy, legacy)).toBe(false);
  });

  it('accepts a newer same-generation snapshot, clears pending, and rejects late old responses', () => {
    const sent: WebviewRequest[] = [];
    const client = new VsCodeMessageClient({ postMessage: (message) => sent.push(message) }, identity);
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: opened(summary, 1) });
    const oldRows = client.send('GET_ROWS', { limit: 100 });
    const oldDetail = client.send('GET_DETAIL', { ref: {
      generation: identity.generation, ordinal: '0', byteStart: '0', byteEndExclusive: '20',
      contentByteLength: '19', delimiterByteLength: 1, parseState: 'valid',
    } });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: oldRows });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: oldDetail });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      protocolVersion: PROTOCOL_VERSION, type: 'SOURCE_INVALIDATED', ...identity, requestId: '', payload: { reason: 'replace' },
    } });
    const next = opened({ ...summary, snapshot: { ...summary.snapshot, epoch: 2 } }, 2);
    const accepted = client.accept(next);
    expect(accepted).toBe(next);
    if (!accepted) throw new Error('Expected admitted snapshot');
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: accepted });
    expect(state.invalidationReason).toBeUndefined();
    expect(state.pending).toEqual({});
    expect(client.cancel('rows')).toEqual([]);
    expect(client.cancel('detail')).toEqual([]);
    expect(client.accept({ protocolVersion: PROTOCOL_VERSION, type: 'ROWS', ...identity, requestId: oldRows.id,
      payload: { rows: [], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1' },
    })).toBeUndefined();
    expect(client.accept({ protocolVersion: PROTOCOL_VERSION, type: 'DETAIL', ...identity,
      requestId: oldDetail.id, payload: {},
    })).toBeUndefined();
    expect(client.accept(opened(summary, 1))).toBeUndefined();
    expect(client.accept({ ...next, epoch: 3 })).toBeUndefined();
    expect(sent.map((message) => message.type)).toEqual(['GET_ROWS', 'GET_DETAIL']);
  });

  it('keeps a duplicate OPENED behind the destructive barrier', () => {
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: opened(summary, 1) });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      protocolVersion: PROTOCOL_VERSION, type: 'SOURCE_INVALIDATED', ...identity, requestId: '', payload: { reason: 'replace' },
    } });
    expect(workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: opened(summary, 1) }).invalidationReason).toBe('replace');
  });

  it('characterizes envelope-only epochs without widening payload snapshot identity', () => {
    const { epoch: _epoch, ...legacySnapshot } = summary.snapshot;
    const legacySummary = { ...summary, snapshot: legacySnapshot };
    const client = new VsCodeMessageClient({ postMessage: () => undefined }, identity);
    let state = workspaceReducer(createInitialState(), { type: 'MESSAGE_RECEIVED', message: opened(legacySummary, 1) });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      protocolVersion: PROTOCOL_VERSION, type: 'SOURCE_INVALIDATED', ...identity, requestId: '', payload: { reason: 'replace' },
    } });
    const next = client.accept(opened(legacySummary, 2));
    expect(client.session.epoch).toBe(2);
    expect(next).toBeDefined();
    if (!next) throw new Error('Expected legacy-compatible envelope');
    expect(workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: next }).invalidationReason).toBe('replace');
  });
});
