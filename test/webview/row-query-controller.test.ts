import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION, type ColumnSpec, type DocumentSummary, type ExtensionMessage,
  type RowPage, type RowProjection, type WebviewRequest,
} from '../../src/shared/types';
import { VsCodeMessageClient, type ProtocolSession } from '../../src/webview/protocol-client';
import { RowQueryController } from '../../src/webview/row-query-controller';
import { snapshotIdentityChanged, type AcceptedSnapshotIdentity } from '../../src/webview/snapshot-identity';
import {
  createInitialState, nextInvalidationReason, toPersistedState, workspaceReducer,
  type PersistedWorkspaceState, type RequestKind, type WorkspaceAction,
} from '../../src/webview/state';
import { fallbackColumns } from '../../src/webview/views';

function summary(generation = 'g1', epoch = 1, indexingComplete = true, indexedRecords = '1000'): DocumentSummary {
  return {
    snapshot: { documentId: 'doc', generation, epoch, uri: 'file:///synthetic.jsonl', scheme: 'file',
      sizeBytes: '20000', mtimeMs: 1, prefixFingerprint: 'synthetic', observedAt: '2026-10-04T00:00:00Z' },
    profileId: 'generic', profileSuggestions: [], indexedBytes: '20000', indexedRecords, indexingComplete,
    validRecords: indexedRecords, problemRecords: '0',
  };
}

function row(ordinal: string, generation = 'g1'): RowProjection {
  return { ref: { generation, ordinal, byteStart: '0', byteEndExclusive: '20', contentByteLength: '19',
    delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: `synthetic row ${ordinal}` };
}

function page(ordinals: string[], generation = 'g1', overrides: Partial<RowPage> = {}): RowPage {
  return { rows: ordinals.map((ordinal) => row(ordinal, generation)), columns: [],
    anchorOrdinal: ordinals.at(-1) ?? '0', hasBefore: true, hasAfter: true, indexedRecords: '1000',
    totalRecords: '1000', ...overrides };
}

function wire<T extends ExtensionMessage['type']>(type: T,
  payload: Extract<ExtensionMessage, { type: T }>['payload'], identity: Readonly<ProtocolSession>, requestId = ''):
  Extract<ExtensionMessage, { type: T }> {
  return { protocolVersion: PROTOCOL_VERSION, type, documentId: identity.documentId, generation: identity.generation,
    ...(identity.epoch === undefined ? {} : { epoch: identity.epoch }), requestId, payload } as Extract<ExtensionMessage, { type: T }>;
}

/** Real controller/client/reducer; queued actions model React commit lag, not hooks. */
function harness(persisted?: PersistedWorkspaceState) {
  let state = createInitialState(persisted, 100);
  let invalidationReason = state.invalidationReason;
  let indexingComplete = false;
  let followMode = state.followMode;
  let acceptedSession: AcceptedSnapshotIdentity | undefined;
  let delayedCommit = false;
  const queuedActions: WorkspaceAction[] = [];
  const actions: WorkspaceAction[] = [];
  const sent: WebviewRequest[] = [];
  const pageInputs: string[] = [];
  const events: Array<{ event: string; value: unknown }> = [];
  const client = new VsCodeMessageClient({ postMessage: (message) => {
    events.push({ event: 'transport', value: message });
    sent.push(message);
  } }, {
    documentId: 'doc', generation: 'bootstrap', epoch: 0,
  });
  const dispatch = (action: WorkspaceAction): void => {
    events.push({ event: 'dispatch', value: action });
    actions.push(action);
    if (delayedCommit) queuedActions.push(action);
    else state = workspaceReducer(state, action);
  };
  const cancel = (kinds: readonly RequestKind[]): void => {
    for (const kind of kinds) for (const requestId of client.cancel(kind)) {
      dispatch({ type: 'REQUEST_FINISHED', kind, requestId });
    }
  };
  const controller = new RowQueryController({
    client, getContext: () => ({ workspace: state, session: client.session, invalidationReason,
      indexingComplete, followMode }), dispatch,
    cancelReadRequests: () => cancel(['rows', 'problems', 'detail', 'schema', 'insights']),
    onPageInputChange: (value) => pageInputs.push(value),
    fallbackColumns,
  }, state, 100);
  const deliver = (message: ExtensionMessage): boolean => {
    events.push({ event: 'incoming', value: message });
    const accepted = client.accept(message);
    events.push({ event: accepted ? 'client-accepted' : 'client-rejected', value: message });
    if (!accepted) return false;
    const firstOpenedSession = accepted.type === 'OPENED' && acceptedSession === undefined;
    const openedGenerationChanged = accepted.type === 'OPENED'
      && snapshotIdentityChanged(acceptedSession, accepted.payload.snapshot);
    if (accepted.type === 'SOURCE_INVALIDATED') {
      invalidationReason = nextInvalidationReason(invalidationReason, accepted.payload.reason);
    } else if (openedGenerationChanged) invalidationReason = undefined;
    if (accepted.type === 'OPENED') {
      indexingComplete = accepted.payload.indexingComplete;
      acceptedSession = accepted.payload.snapshot;
    } else if (accepted.type === 'INDEX_PROGRESS' && acceptedSession?.generation === accepted.generation) {
      indexingComplete = accepted.payload.indexingComplete;
    }
    events.push({ event: 'app-barriers', value: { invalidationReason, indexingComplete, acceptedSession } });
    const followUp = controller.handleAcceptedMessage(accepted, { firstOpenedSession, openedGenerationChanged });
    dispatch({ type: 'MESSAGE_RECEIVED', message: accepted });
    if (accepted.type === 'SOURCE_INVALIDATED') {
      cancel(invalidationReason === 'append' ? ['profile', 'follow']
        : ['rows', 'problems', 'detail', 'schema', 'insights', 'profile', 'follow']);
    }
    followUp();
    if (openedGenerationChanged && followMode) {
      dispatch({ type: 'REQUEST_SENT', request: client.send('SET_FOLLOW_MODE', { enabled: true }) });
    }
    return true;
  };
  const last = <T extends WebviewRequest['type']>(type: T): Extract<WebviewRequest, { type: T }> => {
    const request = [...sent].reverse().find((candidate) => candidate.type === type);
    if (!request) throw new Error(`Missing ${type}`);
    return request as Extract<WebviewRequest, { type: T }>;
  };
  const boot = (complete = true): void => {
    const ready = client.send('READY', {});
    dispatch({ type: 'REQUEST_SENT', request: ready });
    const opened = summary('g1', 1, complete);
    expect(deliver(wire('OPENED', opened, opened.snapshot, ready.id))).toBe(true);
  };
  const opened = (generation = 'g2', epoch = 2, complete = true, indexedRecords = '1000', requestId = ''): void => {
    const payload = summary(generation, epoch, complete, indexedRecords);
    expect(deliver(wire('OPENED', payload, payload.snapshot, requestId))).toBe(true);
  };
  const rows = (request: Extract<WebviewRequest, { type: 'GET_ROWS' }>, payload: RowPage): boolean =>
    deliver(wire('ROWS', payload, request, request.requestId));
  return {
    controller, client, sent, actions, pageInputs, events, dispatch, deliver, last, boot, opened, rows,
    get state() { return state; },
    count(type: WebviewRequest['type']) { return sent.filter((request) => request.type === type).length; },
    delayCommits() { delayedCommit = true; },
    commit() {
      for (const action of queuedActions) state = workspaceReducer(state, action);
      events.push({ event: 'reducer-commit', value: { queuedActionCount: queuedActions.length } });
      queuedActions.length = 0;
      delayedCommit = false;
    },
    follow(enabled: boolean) {
      controller.abandonRestore();
      followMode = enabled;
      dispatch({ type: 'SET_FOLLOW_MODE', enabled });
      cancel(['follow']);
      dispatch({ type: 'REQUEST_SENT', request: client.send('SET_FOLLOW_MODE', { enabled }) });
      if (enabled) controller.requestFollowRows();
    },
    profile(profileId: string) {
      controller.abandonRestore();
      cancel(['profile']);
      dispatch({ type: 'REQUEST_SENT', request: client.send('SET_PROFILE', { profileId }) });
    },
  };
}

function waitingRestore() {
  const test = harness();
  test.boot();
  test.rows(test.last('GET_ROWS'), page(['900', '999']));
  test.controller.rebuild();
  test.opened('g2', 2, false, '100', test.last('REBUILD_INDEX').requestId);
  const restoring = test.last('GET_ROWS');
  const partial: RowPage = { rows: [], columns: [], anchorOrdinal: '899', hasBefore: true, hasAfter: false,
    indexedRecords: '100' };
  expect(test.rows(restoring, partial)).toBe(true);
  return test;
}

const failed = { code: 'REQUEST_FAILED', message: 'synthetic failure', recoverable: true };

describe('row query controller with real client and reducer', () => {
  it('cancels a replaced rows request and finishes its exact reducer id', () => {
    const test = harness();
    test.boot();
    const old = test.last('GET_ROWS');
    test.controller.requestRows({ query: 'fresh' });
    const current = test.last('GET_ROWS');
    expect(test.last('CANCEL').payload.targetRequestId).toBe(old.requestId);
    expect(test.actions).toContainEqual({ type: 'REQUEST_FINISHED', kind: 'rows', requestId: old.requestId });
    expect(test.state.pending.rows?.id).toBe(current.requestId);
    const received = test.actions.filter((action) => action.type === 'MESSAGE_RECEIVED').length;
    expect(test.rows(old, page(['0']))).toBe(false);
    expect(test.actions.filter((action) => action.type === 'MESSAGE_RECEIVED')).toHaveLength(received);
    expect(test.rows(current, page(['1']))).toBe(true);
    expect(test.state.rows[0]?.ref.ordinal).toBe('1');
    expect(test.state.pending.rows).toBeUndefined();
  });

  it('captures page one before cancelling a jump from displayed page four', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['300', '399']));
    expect(test.controller.pageInput).toBe('4');
    test.controller.editPageInput('1');
    test.controller.submitPageInput();
    const pageOne = test.last('GET_ROWS');
    expect(pageOne.payload.anchorOrdinal).toBeUndefined();
    test.controller.rebuild();
    expect(test.last('CANCEL').payload.targetRequestId).toBe(pageOne.requestId);
    test.opened('g2', 2, true, '1000', test.last('REBUILD_INDEX').requestId);
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100 });
    expect(test.controller.pageInputDirty).toBe(false);
    expect(test.rows(pageOne, page(['0']))).toBe(false);
    test.rows(test.last('GET_ROWS'), page(['0', '99'], 'g2'));
    expect(test.controller.pageInput).toBe('1');
    expect(test.state.rows[0]?.ref.generation).toBe('g2');
  });

  it('reconciles page one when clear search arrives without a Page blur', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['0', '99']));
    test.controller.focusPageInput(true);
    test.controller.editPageInput('4');
    test.controller.submitPageInput();
    const pageFour = test.last('GET_ROWS');
    test.rows(pageFour, page(['300', '399']));
    expect(test.controller.pageInput).toBe('4');
    expect(test.controller.pageInputDirty).toBe(false);

    test.controller.releasePageInputFocus();
    test.controller.editQuery('');
    test.controller.requestRows({ query: '' });
    const cleared = test.last('GET_ROWS');
    test.rows(cleared, page(['0', '99']));

    expect(test.controller.pageInput).toBe('1');
    expect(test.controller.pageInputDirty).toBe(false);
  });

  it('deduplicates OPENED and Follow before any React-style reducer commit', () => {
    const test = harness({ followMode: true });
    test.delayCommits();
    test.boot();
    const rows = test.last('GET_ROWS');
    expect(rows.payload.direction).toBe('backward');
    test.opened('g1', 1);
    test.opened('g1', 1);
    expect(test.count('GET_ROWS')).toBe(1);
    expect(test.count('SET_FOLLOW_MODE')).toBe(1);
    expect(test.client.hasPending('rows')).toBe(true);
    test.commit();
    expect(test.state.pending.rows?.id).toBe(rows.requestId);
    expect(test.actions.filter((action) => action.type === 'MESSAGE_RECEIVED')).toHaveLength(3);
  });

  it('restores a same-generation newer payload epoch and rejects retired responses', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['300', '399']));
    test.controller.requestRows({ anchorOrdinal: '499', direction: 'forward' });
    const old = test.last('GET_ROWS');
    test.opened('g1', 2);
    expect(test.last('GET_ROWS').payload).toMatchObject({ anchorOrdinal: '499', direction: 'forward' });
    expect(test.state.summary?.snapshot.epoch).toBe(2);
    expect(test.state.rows).toEqual([]);
    expect(test.rows(old, page(['500']))).toBe(false);
    expect(test.deliver(wire('ERROR', failed, old, old.requestId))).toBe(false);
  });

  it('keeps invalidation synchronous through duplicates, stale responses and trailing blur', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['300', '399']));
    test.controller.editPageInput('7');
    test.controller.submitPageInput();
    const old = test.last('GET_ROWS');
    test.controller.editPageInput('8');
    test.delayCommits();
    test.deliver(wire('SOURCE_INVALIDATED', { reason: 'replace' }, test.client.session));
    test.opened('g1', 1);
    const count = test.count('GET_ROWS');
    test.controller.focusPageInput(false);
    test.controller.submitPageInput();
    expect(test.controller.pageInput).toBe('8');
    expect(test.controller.pageInputDirty).toBe(true);
    expect(test.count('GET_ROWS')).toBe(count);
    expect(test.rows(old, page(['600']))).toBe(false);
    expect(test.deliver(wire('ERROR', failed, old, old.requestId))).toBe(false);
    test.commit();
    expect(test.state.invalidationReason).toBe('replace');
    test.controller.rebuild();
    test.opened('g2', 2, true, '1000', test.last('REBUILD_INDEX').requestId);
    expect(test.state.invalidationReason).toBeUndefined();
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe('299');
  });

  it.each(['ROWS', 'ERROR'] as const)('leaves draft B intact when submitted page A receives %s', (type) => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['0', '99']));
    test.controller.editPageInput('5');
    test.controller.submitPageInput();
    const submitted = test.last('GET_ROWS');
    test.controller.editPageInput('8');
    if (type === 'ROWS') expect(test.rows(submitted, page(['400', '499']))).toBe(true);
    else expect(test.deliver(wire('ERROR', failed, submitted, submitted.requestId))).toBe(true);
    expect(test.controller.pageInput).toBe('8');
    expect(test.controller.pageInputDirty).toBe(true);
    expect(test.pageInputs.at(-1)).toBe('8');
    test.controller.submitPageInput();
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe('699');
    test.rows(test.last('GET_ROWS'), page(['700', '799']));
    expect(test.controller.pageInput).toBe('8');
    expect(test.controller.pageInputDirty).toBe(false);
  });

  it('preserves a newer query draft and gives its rebuild a fresh cursor', () => {
    const test = harness();
    test.boot();
    test.controller.editQuery('A');
    test.controller.requestRows({ query: 'A' });
    const oldQuery = test.last('GET_ROWS');
    test.controller.editQuery('B');
    test.rows(oldQuery, page(['700', '799'], 'g1', { sortOffset: '500' }));
    expect(test.controller.query).toBe('B');
    expect(test.controller.sortOffset).toBe('0');
    expect(test.state.query).toBe('B');
    test.controller.rebuild();
    test.opened('g2', 2, true, '1000', test.last('REBUILD_INDEX').requestId);
    expect(test.last('GET_ROWS').payload).toMatchObject({ predicate: { op: 'text_search', value: 'B' } });
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBeUndefined();
  });

  it('waits through incomplete indexing and exhausts one distinct empty-page retry', () => {
    const test = waitingRestore();
    const count = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, false, '150'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count);
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count + 1);
    expect(test.last('GET_ROWS').payload).toMatchObject({ anchorOrdinal: '199', direction: 'forward' });
    test.rows(test.last('GET_ROWS'), page([], 'g2', { totalRecords: '250', hasAfter: false }));
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count + 1);
    expect(test.state.pending.rows).toBeUndefined();
  });

  it('does not retry the same restored anchor when completed indexing confirms it', () => {
    const test = waitingRestore();
    const count = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '1000'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count);
    expect(test.state.pending.rows).toBeUndefined();
  });

  it.each(['query', 'profile', 'follow', 'rebuild'] as const)('retires waiting recovery after %s supersession', (mode) => {
    const test = waitingRestore();
    if (mode === 'query') test.controller.editQuery('new draft');
    if (mode === 'profile') {
      test.profile('generic');
      const request = test.last('SET_PROFILE');
      test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, request, request.requestId));
    }
    if (mode === 'follow') test.follow(true);
    if (mode === 'rebuild') test.controller.rebuild();
    const count = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count);
    if (mode === 'follow') expect(test.last('GET_ROWS').payload.direction).toBe('backward');
  });

  it('preserves a waiting restore through an unsolicited profile projection', () => {
    const test = waitingRestore();
    const count = test.count('GET_ROWS');
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    expect(test.count('GET_ROWS')).toBe(count);
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count + 1);
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe('199');
  });

  it('refreshes a pending restore through profile projection without losing its empty-page fallback', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.rebuild();
    test.opened('g2', 2, true, '250', test.last('REBUILD_INDEX').requestId);
    const old = test.last('GET_ROWS');
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    const refreshed = test.last('GET_ROWS');
    expect(refreshed.requestId).not.toBe(old.requestId);
    expect(refreshed.payload.anchorOrdinal).toBe('899');
    expect(test.rows(old, page(['900'], 'g2'))).toBe(false);
    test.rows(refreshed, page([], 'g2', { totalRecords: '250' }));
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe('199');
  });

  it('stops recovery after a restore request fails', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.rebuild();
    test.opened('g2', 2, false, '100', test.last('REBUILD_INDEX').requestId);
    const request = test.last('GET_ROWS');
    test.deliver(wire('ERROR', failed, request, request.requestId));
    const count = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count);
    expect(test.state.error?.message).toBe('synthetic failure');
  });

  it('never clamps a sorted restore to a truncated matched count', () => {
    const sort = { columnId: 'value', direction: 'asc' as const };
    const test = harness({ sort, sortOffset: '900', sortPage: '10' });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900'], 'g1', { sort, sortOffset: '900', matchedRecords: '1000' }));
    test.controller.rebuild();
    test.opened('g2', 2, true, '1000', test.last('REBUILD_INDEX').requestId);
    const restoring = test.last('GET_ROWS');
    expect(restoring.payload.sortOffset).toBe('900');
    test.rows(restoring, page([], 'g2', { sort, sortOffset: '900', matchedRecords: '50',
      scan: { examinedRecords: '50', examinedBytes: '1000', cursorOrdinal: '49', direction: 'forward',
        truncatedReason: 'record_limit' } }));
    const count = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '1000'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count);
    expect(test.controller.sortOffset).toBe('900');
  });

  it('tracks partial sorted offsets, logical pages and history before reducer commits', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ sortDirection: 'desc' });
    test.boot();
    test.delayCommits();
    test.rows(test.last('GET_ROWS'), page(['999', '998', '997'], 'g1', { sort, sortOffset: '0', sortNextOffset: '3' }));
    test.controller.nextPage();
    expect(test.last('GET_ROWS').payload.sortOffset).toBe('3');
    expect(test.controller.sortPage).toBe('2');
    expect(test.controller.sortOffsetHistory).toEqual(['0']);
    test.rows(test.last('GET_ROWS'), page(['996', '995'], 'g1', { sort, sortOffset: '3', sortNextOffset: '5' }));
    test.controller.nextPage();
    expect(test.last('GET_ROWS').payload.sortOffset).toBe('5');
    expect(test.controller.sortPage).toBe('3');
    test.controller.previousPage();
    expect(test.last('GET_ROWS').payload.sortOffset).toBe('3');
    expect(test.controller.sortPage).toBe('2');
    test.controller.previousPage();
    expect(test.last('GET_ROWS').payload.sortOffset).toBe('0');
    expect(test.controller.sortPage).toBe('1');
    expect(test.controller.sortOffsetHistory).toEqual([]);
    const count = test.count('GET_ROWS');
    test.controller.focusPageInput(true);
    test.controller.focusPageInput(false);
    test.controller.submitPageInput();
    expect(test.count('GET_ROWS')).toBe(count);
    test.commit();
    expect(test.state.sortOffset).toBe('0');
    expect(test.state.sortPage).toBe('1');
  });

  it('keeps huge physical anchors and page submissions in decimal strings', () => {
    const test = harness();
    test.boot();
    const ordinal = '900719925474099312345';
    test.rows(test.last('GET_ROWS'), page([ordinal]));
    expect(test.controller.pageInput).toBe('9007199254740993124');
    test.controller.nextPage();
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe(ordinal);
    test.controller.rebuild();
    test.opened('g2', 2, true, '900719925474099312400', test.last('REBUILD_INDEX').requestId);
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe(ordinal);
    test.controller.editPageInput('9007199254740993');
    test.controller.submitPageInput();
    expect(test.last('GET_ROWS').payload.anchorOrdinal).toBe('900719925474099199');
  });

  it('commits row order only on host ACK and leaves the prior preference after ERROR', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['0', '99']));
    test.delayCommits();
    test.controller.requestRowOrder('desc');
    const rejected = test.last('SET_ROW_ORDER');
    test.controller.requestRowOrder('desc');
    expect(test.count('SET_ROW_ORDER')).toBe(1);
    expect(test.controller.sortDirection).toBe('asc');
    expect(toPersistedState(test.state).sortDirection).toBe('asc');
    expect(test.deliver(wire('ROW_ORDER_CHANGED', { direction: 'desc' }, rejected, 'unknown'))).toBe(false);
    test.deliver(wire('ERROR', failed, rejected, rejected.requestId));
    test.commit();
    expect(test.controller.sortDirection).toBe('asc');
    expect(toPersistedState(test.state).sortDirection).toBe('asc');
    test.controller.requestRowOrder('desc');
    const saved = test.last('SET_ROW_ORDER');
    const start = test.actions.length;
    test.deliver(wire('ROW_ORDER_CHANGED', { direction: 'desc' }, saved, saved.requestId));
    expect(test.actions.slice(start).map((action) => action.type))
      .toEqual(['MESSAGE_RECEIVED', 'SET_SORT_DIRECTION', 'SET_SORT', 'REQUEST_SENT']);
    expect(test.controller.sortDirection).toBe('desc');
    expect(toPersistedState(test.state).sortDirection).toBe('desc');
    expect(test.last('GET_ROWS').payload).toMatchObject({ sort: { columnId: '__ordinal', direction: 'desc' }, sortOffset: '0' });
  });

  it('keeps append reads available while row order and recovery stay behind the source barrier', () => {
    const test = harness();
    test.boot();
    const current = test.last('GET_ROWS');
    test.deliver(wire('SOURCE_INVALIDATED', { reason: 'append' }, test.client.session));
    test.opened('g1', 1);
    test.controller.requestRowOrder('desc');
    expect(test.count('SET_ROW_ORDER')).toBe(0);
    expect(test.rows(current, page(['0', '99']))).toBe(true);
    expect(test.state.invalidationReason).toBe('append');
    expect(test.state.phase).toBe('invalidated');
    test.controller.requestRows({ anchorOrdinal: '99', direction: 'forward' });
    expect(test.count('GET_ROWS')).toBe(2);
  });

  it('reconciles removed profile sort/filter synchronously before its refresh request', () => {
    const profileColumn: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['0'], 'g1', { columns: [profileColumn] }));
    test.controller.applyFilter({ columnId: 'eventKind', operator: 'eq', value: 'tool', source: 'profile' });
    test.controller.changeSort({ columnId: 'eventKind', direction: 'asc' });
    expect(test.last('GET_ROWS').payload.predicate).toMatchObject({ op: 'profile_field', field: 'eventKind' });
    test.delayCommits();
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    expect(test.controller.sort).toBeUndefined();
    expect(test.last('GET_ROWS').payload.sort).toBeUndefined();
    expect(test.last('GET_ROWS').payload.predicate).toBeUndefined();
    test.commit();
    expect(test.state.filter).toBeUndefined();
    expect(test.state.sort).toBeUndefined();
  });

  it('captures representative complete wire and dispatch sequences for integration review', () => {
    const rebuild = harness();
    rebuild.boot();
    rebuild.rows(rebuild.last('GET_ROWS'), page(['300', '399']));
    rebuild.controller.editPageInput('1');
    rebuild.controller.submitPageInput();
    rebuild.controller.rebuild();
    rebuild.opened('g2', 2, true, '1000', rebuild.last('REBUILD_INDEX').requestId);
    rebuild.opened('g2', 2);
    rebuild.rows(rebuild.last('GET_ROWS'), page(['0', '99'], 'g2'));
    const restore = waitingRestore();
    restore.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), restore.client.session));
    restore.rows(restore.last('GET_ROWS'), page([], 'g2', { totalRecords: '250' }));
    const order = harness();
    order.boot();
    order.rows(order.last('GET_ROWS'), page(['0', '99']));
    order.controller.requestRowOrder('desc');
    const failedOrder = order.last('SET_ROW_ORDER');
    order.deliver(wire('ERROR', failed, failedOrder, failedOrder.requestId));
    order.controller.requestRowOrder('desc');
    const acknowledged = order.last('SET_ROW_ORDER');
    order.deliver(wire('ROW_ORDER_CHANGED', { direction: 'desc' }, acknowledged, acknowledged.requestId));
    expect(rebuild.sent.filter((message) => message.type === 'GET_ROWS')).toHaveLength(3);
    expect(restore.sent.filter((message) => message.type === 'GET_ROWS')).toHaveLength(3);
    expect(order.controller.sortDirection).toBe('desc');
    const output = process.env.JSONLVIEW_CONTROLLER_TRACE_PATH;
    if (output) writeFileSync(output, JSON.stringify({ schemaVersion: 1,
      sourceScope: 'real controller + real message client + real reducer; synthetic traffic; L2',
      scenarios: [
        { id: 'page4-page1-rebuild-duplicate', events: rebuild.events },
        { id: 'wait-index-one-retry-exhaustion', events: restore.events },
        { id: 'row-order-error-and-host-ack', events: order.events },
      ] }, undefined, 2) + '\n', 'utf8');
  });
});
