import { describe, expect, it } from 'vitest';
import { shouldIssueInsightRequest } from '../../src/webview/insight-request';
import { createInitialState, workspaceReducer, type WorkspaceState } from '../../src/webview/state';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';
import { PROTOCOL_VERSION, type AnalysisIntentV1, type WebviewRequest } from '../../src/shared/types';

const initialIntent: AnalysisIntentV1 = { version: 1, intentRevision: 1, dimension: 'eventKind',
  scope: 'current-view', document: { documentId: 'doc', generation: 'g1', sourceEpoch: 1 },
  profile: { id: 'generic', version: '1' } };

describe('automatic Insights admission', () => {
  it.each(['STALE_ANALYSIS_INTENT', 'REQUEST_FAILED'])(
    'bounds repeated %s to one request per condition and permits Refresh or identity changes', (code) => {
      const sent: WebviewRequest[] = [];
      const client = new VsCodeMessageClient({ postMessage: (value) => { sent.push(value); } },
        { documentId: 'doc', generation: 'g1', epoch: 1 });
      let state: WorkspaceState = createInitialState();
      const attempt = (automatic: boolean, condition = initialIntent) => {
        const intent = { ...condition, intentRevision: state.analysisIntentRevision + 1 };
        if (!shouldIssueInsightRequest(intent, state.failedAnalysisIntent, automatic)) return;
        state = workspaceReducer(state, { type: 'SET_ANALYSIS_INTENT', intent });
        const request = client.send('GET_INSIGHTS', { intent });
        state = workspaceReducer(state, { type: 'REQUEST_SENT', request });
        const error = client.accept({ protocolVersion: PROTOCOL_VERSION, type: 'ERROR',
          documentId: 'doc', generation: 'g1', epoch: 1, requestId: request.id,
          payload: { code, message: 'failed', recoverable: true } });
        if (error !== undefined) state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: error });
      };
      for (let tick = 0; tick < 10; tick++) attempt(true);
      expect(sent.filter((request) => request.type === 'GET_INSIGHTS')).toHaveLength(1);
      expect(state.pending.insights).toBeUndefined();
      state = workspaceReducer(state, { type: 'DISMISS_ERROR' });
      attempt(true);
      expect(sent).toHaveLength(1);
      attempt(false);
      expect(sent).toHaveLength(2);
      const next = { ...initialIntent, profile: { ...initialIntent.profile, version: '2' } };
      for (let tick = 0; tick < 10; tick++) attempt(true, next);
      expect(sent).toHaveLength(3);
      expect(client.hasPending('insights')).toBe(false);
    },
  );

  it('does not treat display projection or reapplying the same query as a changed failed condition', () => {
    let state = workspaceReducer(createInitialState(), { type: 'SET_ANALYSIS_INTENT', intent: initialIntent });
    state = workspaceReducer(state, { type: 'REQUEST_SENT', request: { id: 'failed', kind: 'insights' } });
    state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: {
      protocolVersion: PROTOCOL_VERSION, type: 'ERROR', documentId: 'doc', generation: 'g1',
      requestId: 'failed', payload: { code: 'REQUEST_FAILED', message: 'failed', recoverable: true },
    } });
    state = workspaceReducer(state, { type: 'SET_COLUMN_VISIBILITY', columnId: 'status', visible: false });
    state = workspaceReducer(state, { type: 'SET_QUERY', query: '' });
    expect(shouldIssueInsightRequest({ ...initialIntent, intentRevision: state.analysisIntentRevision + 1 },
      state.failedAnalysisIntent, true)).toBe(false);
  });

  it('keeps failure suppression across request revisions but admits each real condition or identity change', () => {
    expect(shouldIssueInsightRequest({ ...initialIntent, intentRevision: 200 }, initialIntent, true)).toBe(false);
    for (const changed of [
      { ...initialIntent, predicate: { op: 'text_search' as const, value: 'query', caseSensitive: false } },
      { ...initialIntent, predicate: { op: 'profile_field' as const, field: 'status', cmp: 'eq' as const, value: 'failed' } },
      { ...initialIntent, predicate: { op: 'profile_field' as const, field: 'eventKind', cmp: 'eq' as const, value: 'tool_call' } },
      { ...initialIntent, scope: 'whole-file' as const },
      { ...initialIntent, dimension: 'status' as const },
      { ...initialIntent, profile: { ...initialIntent.profile, id: 'codex' } },
      { ...initialIntent, profile: { ...initialIntent.profile, version: '2' } },
      { ...initialIntent, document: { ...initialIntent.document, documentId: 'other' } },
      { ...initialIntent, document: { ...initialIntent.document, generation: 'g2' } },
      { ...initialIntent, document: { ...initialIntent.document, sourceEpoch: 2 } },
    ]) expect(shouldIssueInsightRequest(changed, initialIntent, true)).toBe(true);
    expect(shouldIssueInsightRequest(initialIntent, initialIntent, false)).toBe(true);
  });
});
