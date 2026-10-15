import { writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';
import {
  PROTOCOL_VERSION, keyPath, type ColumnSpec, type DocumentSummary, type ExtensionMessage,
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
import { recordColumnOptions } from '../../src/webview/features/record-query/model';

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
      if (enabled) controller.returnToLatest();
    },
    profile(profileId: string) {
      controller.abandonRestore();
      cancel(['profile']);
      dispatch({ type: 'REQUEST_SENT', request: client.send('SET_PROFILE', { profileId }) });
    },
  };
}

async function withEngineFixture(
  records: unknown[],
  run: (fixture: { path: string; open: (generation: string) => Promise<JsonlFileEngine> }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-view-controller-engine-'));
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe temporary fixture path');
  const path = join(directory, 'fixture.jsonl');
  const engines: JsonlFileEngine[] = [];
  try {
    await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    await run({ path, open: async (generation) => {
      const engine = await JsonlFileEngine.open(path, { documentId: 'doc', generation, newlineScanner: 'off' });
      engines.push(engine);
      return engine;
    } });
  } finally {
    await Promise.all(engines.map((engine) => engine.dispose()));
    await rm(directory, { recursive: true, force: true });
  }
}

describe('multiple table conditions with synchronous controller capture', () => {
  it('keeps handwritten table queries local until Navigator is explicitly opened', () => {
    const test = harness();
    test.boot();
    test.controller.editQuery('session_id=synthetic');
    test.controller.requestRows();
    expect(test.count('GET_ROWS')).toBeGreaterThan(0);
    expect(test.count('OPEN_SESSION_NAVIGATOR')).toBe(0);
    test.client.send('OPEN_SESSION_NAVIGATOR', {});
    expect(test.count('OPEN_SESSION_NAVIGATOR')).toBe(1);
  });

  it('preserves an unsampled configured record column across profile switches before React commits and after reload', () => {
    const path = keyPath('rare', 'requestId');
    const id = JSON.stringify(path.tokens);
    const event: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const severity: ColumnSpec = { id: 'severity', label: 'Severity', source: 'profile' };
    const record: ColumnSpec = { id, label: '$.rare.requestId', source: 'record', path };
    const test = harness({ columnVisibility: { [id]: true, eventKind: true } });
    test.boot();
    expect(test.last('GET_ROWS').payload.columns).toEqual([record]);
    test.rows(test.last('GET_ROWS'), page(['0'], 'g1', { columns: [event, record] }));
    expect(test.state.schema).toEqual([]); // The bounded sample has not observed the configured path.
    test.delayCommits();
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    expect(test.last('GET_ROWS').payload.columns).toEqual([record]);
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'other', columns: [severity] }, test.client.session));
    expect(test.last('GET_ROWS').payload.columns).toEqual([record]);
    test.commit();
    expect(test.state.columns).toEqual([severity, record]);
    expect(recordColumnOptions(test.state.columns, [], test.state.columnVisibility)).toEqual([severity, record]);
    const reloaded = harness(toPersistedState(test.state));
    reloaded.boot();
    expect(reloaded.state.schema).toEqual([]);
    expect(reloaded.last('GET_ROWS').payload.columns).toEqual([record]);
    expect(recordColumnOptions(reloaded.state.columns, [], reloaded.state.columnVisibility)).toEqual([record]);
  });

  it('captures type alternatives and all conditions before React commits, removes one, and clears each group independently', () => {
    const event: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['0'], 'g1', { columns: [event] }));
    const stage = { columnId: JSON.stringify(keyPath('stage').tokens), source: 'record' as const,
      path: keyPath('stage'), operator: 'eq' as const, value: 'prod' };
    const allowed = { columnId: JSON.stringify(keyPath('allowed').tokens), source: 'record' as const,
      path: keyPath('allowed'), operator: 'eq' as const, value: true };
    test.delayCommits();
    test.controller.editQuery('needle');
    test.controller.applyFilters([stage, allowed]);
    test.controller.applyRowTypes({ column: event, values: ['message', 'tool_call'] });
    expect(test.last('GET_ROWS').payload.predicate).toMatchObject({ op: 'and', args: expect.arrayContaining([
      expect.objectContaining({ op: 'text_search', value: 'needle' }),
      expect.objectContaining({ op: 'compare', path: stage.path, value: 'prod' }),
      expect.objectContaining({ op: 'compare', path: allowed.path, value: true }),
      expect.objectContaining({ op: 'or', args: expect.arrayContaining([
        expect.objectContaining({ op: 'profile_field', field: 'eventKind', value: 'message' }),
        expect.objectContaining({ op: 'profile_field', field: 'eventKind', value: 'tool_call' }),
      ]) }),
    ]) });
    test.commit();
    expect(test.state.filters).toEqual([stage, allowed]);
    test.controller.applyFilters(test.controller.filters.filter((_, index) => index !== 0));
    expect(test.state.filters).toEqual([allowed]);
    test.controller.applyFilters([]);
    expect(test.last('GET_ROWS').payload.predicate).toMatchObject({ op: 'and', args: expect.arrayContaining([
      expect.objectContaining({ op: 'text_search', value: 'needle' }), expect.objectContaining({ op: 'or' }),
    ]) });
    test.controller.applyRowTypes(undefined);
    expect(test.last('GET_ROWS').payload.predicate).toEqual({ op: 'text_search', value: 'needle', caseSensitive: false });
    test.controller.applyFilters([stage, allowed]);
    test.controller.applyRowTypes({ column: event, values: ['message'] });
    test.controller.returnToLatest();
    expect(test.last('GET_ROWS').payload.predicate).toBeUndefined();
    expect(test.state.filters).toEqual([]);
    expect(test.state.rowTypes).toBeUndefined();
    expect(test.state.query).toBe('');
  });

  it('removes Event selections on a Generic switch while retaining record-path conditions synchronously', () => {
    const event: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['0'], 'g1', { columns: [event] }));
    const path = keyPath('stage');
    const filter = { columnId: JSON.stringify(path.tokens), source: 'record' as const, path,
      operator: 'eq' as const, value: 'prod' };
    test.controller.applyFilters([filter]);
    test.controller.applyRowTypes({ column: event, values: ['message', 'tool_call'] });
    test.delayCommits();
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    expect(test.last('GET_ROWS').payload.predicate).toEqual({ op: 'compare', path, cmp: 'eq', value: 'prod' });
    test.commit();
    expect(test.state.filters).toEqual([filter]);
    expect(test.state.rowTypes).toBeUndefined();
  });
});

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
  const navigationCases = [
    { name: 'Previous', navigate: (controller: RowQueryController) => controller.previousPage(),
      cursor: { anchorOrdinal: '300', direction: 'backward' as const }, ordinals: ['200', '299'] },
    { name: 'Next', navigate: (controller: RowQueryController) => controller.nextPage(),
      cursor: { anchorOrdinal: '399', direction: 'forward' as const }, ordinals: ['400', '499'] },
    { name: 'page one input', navigate: (controller: RowQueryController) => {
      controller.focusPageInput(true); controller.editPageInput('1'); controller.submitPageInput();
    }, cursor: {}, ordinals: ['0', '99'] },
    { name: 'page three input', navigate: (controller: RowQueryController) => {
      controller.focusPageInput(true); controller.editPageInput('3'); controller.submitPageInput();
    }, cursor: { anchorOrdinal: '199', direction: 'forward' as const }, ordinals: ['200', '299'] },
  ];

  for (const arrival of ['before', 'after'] as const) {
    it.each(navigationCases)('keeps $name in Reading when append arrives ' + arrival + ' its rows', ({ navigate, cursor, ordinals }) => {
      const test = harness({ followMode: true });
      test.boot();
      test.rows(test.last('GET_ROWS'), page(['300', '399']));
      test.delayCommits();
      navigate(test.controller);
      const explicit = test.last('GET_ROWS');
      expect(explicit.payload).toEqual({ limit: 100, ...cursor });
      expect(test.controller.viewportMode).toBe('reading');
      if (arrival === 'after') expect(test.rows(explicit, page(ordinals))).toBe(true);
      test.opened('g2', 2, true, '1001');
      const recovery = test.last('GET_ROWS');
      const recoveryCursor = arrival === 'before' ? cursor
        : ordinals[0] === '0' ? {} : { anchorOrdinal: (BigInt(ordinals[0]!) - 1n).toString(), direction: 'forward' };
      expect(recovery.payload).toEqual({ limit: 100, ...recoveryCursor });
      const requests = test.count('GET_ROWS');
      test.opened('g2', 2, true, '1001');
      test.controller.requestFollowRows();
      expect(test.count('GET_ROWS')).toBe(requests);
      test.opened('g3', 3, true, '1002');
      const latest = test.last('GET_ROWS');
      expect(latest.payload).toEqual({ limit: 100, ...recoveryCursor });
      expect(test.rows(recovery, page(ordinals, 'g2'))).toBe(false);
      if (arrival === 'before') expect(test.rows(explicit, page(ordinals))).toBe(false);
      expect(test.rows(latest, page(ordinals, 'g3', { indexedRecords: '1002', totalRecords: '1002' }))).toBe(true);
      test.commit();
      expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(ordinals);
      expect(test.state.rows[0]?.ref.generation).toBe('g3');
      expect(test.state.followMode).toBe(true);
      expect(test.state.viewportMode).toBe('reading');
      expect(test.state.latestSeq).toBe('1002');
      expect(test.state.unseenActivity).toBe(true);
    });
  }

  it.each(navigationCases)('preserves pending $name through append and unsolicited profile projection', ({ navigate, cursor, ordinals }) => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['300', '350', '399']));
    test.controller.reportViewport(row('350').ref);
    test.delayCommits();
    navigate(test.controller);
    const explicit = test.last('GET_ROWS');
    test.opened('g2', 2, true, '1001');
    const recovery = test.last('GET_ROWS');
    expect(recovery.payload).toEqual({ limit: 100, ...cursor });
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    const projected = test.last('GET_ROWS');
    expect(projected.requestId).not.toBe(recovery.requestId);
    expect(projected.payload).toEqual({ limit: 100, ...cursor });
    expect(test.rows(explicit, page(ordinals))).toBe(false);
    expect(test.rows(recovery, page(ordinals, 'g2'))).toBe(false);
    test.opened('g3', 3, true, '1002');
    const latest = test.last('GET_ROWS');
    expect(latest.payload).toEqual({ limit: 100, ...cursor });
    expect(test.rows(projected, page(ordinals, 'g2'))).toBe(false);
    expect(test.rows(latest, page(ordinals, 'g3', { indexedRecords: '1002', totalRecords: '1002' }))).toBe(true);
    test.commit();
    expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(ordinals);
    expect(test.state.viewportMode).toBe('reading');
    expect(test.state.followMode).toBe(true);
  });

  it('keeps a compatible sorted page cursor through consecutive OPENED and profile projection', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ followMode: true, sortDirection: 'desc' });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['999', '998', '997'], 'g1', { sort, sortOffset: '0', sortNextOffset: '3' }));
    test.delayCommits();
    test.controller.nextPage();
    const explicit = test.last('GET_ROWS');
    expect(explicit.payload).toEqual({ limit: 100, sort, anchorOrdinal: '997', direction: 'backward' });
    test.opened('g2', 2, true, '1001');
    const recovery = test.last('GET_ROWS');
    expect(recovery.payload).toEqual({ limit: 100, sort, anchorOrdinal: '997', direction: 'backward' });
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    const projected = test.last('GET_ROWS');
    expect(projected.payload).toEqual({ limit: 100, sort, anchorOrdinal: '997', direction: 'backward' });
    expect(test.controller.sortPage).toBe('1');
    expect(test.controller.sortOffsetHistory).toEqual([]);
    test.opened('g3', 3, true, '1002');
    const latest = test.last('GET_ROWS');
    expect(latest.payload).toEqual({ limit: 100, sort, anchorOrdinal: '997', direction: 'backward' });
    expect(test.rows(explicit, page(['996', '995']))).toBe(false);
    expect(test.rows(recovery, page(['996', '995'], 'g2'))).toBe(false);
    expect(test.rows(projected, page(['996', '995'], 'g2'))).toBe(false);
    expect(test.rows(latest, page(['996', '995'], 'g3', { sort }))).toBe(true);
    test.controller.previousPage();
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, sort, anchorOrdinal: '996', direction: 'forward' });
    test.commit();
    expect(test.state.viewportMode).toBe('reading');
    expect(test.state.followMode).toBe(true);
  });

  it('uses descending row boundaries for Next and Previous across a partial final page', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ sortDirection: 'desc' });
    test.boot();
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, sort, sortOffset: '0' });
    test.rows(test.last('GET_ROWS'), page(['224', '125'], 'g1', { sort, hasBefore: false, hasAfter: true }));

    test.controller.nextPage();
    expect(test.last('GET_ROWS').payload).toEqual({
      limit: 100, sort, anchorOrdinal: '125', direction: 'backward',
    });
    test.rows(test.last('GET_ROWS'), page(['124', '25'], 'g1', { sort, hasBefore: true, hasAfter: true }));
    test.controller.nextPage();
    expect(test.last('GET_ROWS').payload).toEqual({
      limit: 100, sort, anchorOrdinal: '25', direction: 'backward',
    });
    test.rows(test.last('GET_ROWS'), page(['24', '0'], 'g1', { sort, hasBefore: true, hasAfter: false }));
    const atEnd = test.count('GET_ROWS');
    test.controller.nextPage();
    expect(test.count('GET_ROWS')).toBe(atEnd);

    test.controller.previousPage();
    expect(test.last('GET_ROWS').payload).toEqual({
      limit: 100, sort, anchorOrdinal: '24', direction: 'forward',
    });
    test.rows(test.last('GET_ROWS'), page(['124', '25'], 'g1', { sort, hasBefore: true, hasAfter: true }));
    test.controller.previousPage();
    expect(test.last('GET_ROWS').payload).toEqual({
      limit: 100, sort, anchorOrdinal: '124', direction: 'forward',
    });
  });

  it('restores the same descending partial window after an append generation', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ followMode: false, sortDirection: 'desc' });
    test.boot();
    test.controller.requestRows({ anchorOrdinal: '25', direction: 'backward' }, { navigation: 'physical' });
    test.rows(test.last('GET_ROWS'), page(['24', '0'], 'g1', {
      sort, hasBefore: true, hasAfter: false, indexedRecords: '225', totalRecords: '225',
    }));

    test.opened('g2', 2, true, '226');
    const recovery = test.last('GET_ROWS');
    expect(recovery.payload).toEqual({
      limit: 100, sort, anchorOrdinal: '25', direction: 'backward',
    });
    expect(test.rows(recovery, page(['24', '0'], 'g2', {
      sort, hasBefore: true, hasAfter: false, indexedRecords: '226', totalRecords: '226',
    }))).toBe(true);
    expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(['24', '0']);
  });

  it('keeps direct descending page jumps logical, including page one', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ sortDirection: 'desc' });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['999', '900'], 'g1', { sort, sortOffset: '0' }));

    test.controller.focusPageInput(true);
    test.controller.editPageInput('3');
    test.controller.submitPageInput();
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, sort, sortOffset: '200' });
    test.rows(test.last('GET_ROWS'), page(['799', '700'], 'g1', { sort, sortOffset: '200' }));

    test.controller.editPageInput('1');
    test.controller.submitPageInput();
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, sort, sortOffset: '0' });
  });

  it('requires an explicit physical intent before sending sorted cursor fields', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ sortDirection: 'desc' });
    test.boot();

    test.controller.requestRows({ anchorOrdinal: '900', direction: 'backward' });

    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, sort, sortOffset: '0' });
  });

  it('converts a descending Navigator reveal to a logical rank', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ sortDirection: 'desc' });
    test.boot();

    test.controller.revealOrdinal('900');

    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, sort, sortOffset: '99' });
  });

  it('replays the original sparse descending scan window after append', () => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ followMode: false, sortDirection: 'desc' });
    test.boot();
    test.controller.editQuery('needle');
    test.controller.requestRows({ anchorOrdinal: '900', direction: 'backward' }, { navigation: 'physical' });
    test.rows(test.last('GET_ROWS'), page(['850'], 'g1', {
      sort, indexedRecords: '1000', totalRecords: '1000',
      scan: { examinedRecords: '50', examinedBytes: '5000', cursorOrdinal: '850',
        direction: 'backward', truncatedReason: 'record_limit' },
    }));

    test.opened('g2', 2, true, '1001');
    const replay = test.last('GET_ROWS');
    expect(replay.payload).toMatchObject({
      limit: 100, sort, anchorOrdinal: '900', direction: 'backward',
      scanBudget: { maxExaminedRecords: 50, maxExaminedBytes: '5000' },
    });
    expect(replay.payload).not.toHaveProperty('sortOffset');
    expect(test.rows(replay, page(['850'], 'g2', {
      sort, indexedRecords: '1001', totalRecords: '1001',
      scan: { examinedRecords: '50', examinedBytes: '5000', cursorOrdinal: '850',
        direction: 'backward', truncatedReason: 'record_limit' },
    }))).toBe(true);
    expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(['850']);
  });

  it('keeps a sparse logical jump as matching rank through projection and append recovery in the real engine', async () => {
    const records = Array.from({ length: 1000 }, (_, id) => ({
      id: String(id).padStart(4, '0'), keep: id % 5 === 0 ? 'needle' : 'absent',
    }));
    await withEngineFixture(records, async ({ path, open }) => {
      const engine = await open('g1');
      const test = harness({ followMode: false, sortDirection: 'desc' });
      test.boot();
      test.controller.applyFilters([{ columnId: JSON.stringify(keyPath('keep').tokens), source: 'record',
        path: keyPath('keep'), operator: 'eq', value: 'needle' }]);
      test.controller.editPageInput('2');
      test.controller.submitPageInput();
      expect(test.last('GET_ROWS').payload.sortOffset).toBe('100');
      test.controller.requestRows({ sortOffset: '100', scanBudget: { maxExaminedRecords: 506 } });
      const original = test.last('GET_ROWS');
      const firstPage = await engine.getRows({ ...original.payload, generation: original.generation });
      // Independent matching-rank oracle: skip 100 matches while examining 506 source rows.
      const expected = Array.from({ length: 506 }, (_, index) => 999 - index)
        .filter((ordinal) => ordinal % 5 === 0).slice(100).map(String);
      expect(expected).toEqual(['495']);
      expect(firstPage.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      expect(firstPage.scan).toMatchObject({ examinedRecords: '506', cursorOrdinal: '494', truncatedReason: 'record_limit' });
      expect(test.rows(original, firstPage)).toBe(true);
      expect(test.controller.sortOffset).toBe('100');

      const columns: ColumnSpec[] = [{ id: JSON.stringify(keyPath('id').tokens), label: 'ID', source: 'record', path: keyPath('id') }];
      // This is the production Columns caller shape: no separate navigation metadata.
      test.controller.requestRows({ ...test.controller.currentViewportOptions(), columns }, { preserveOnRebuild: true });
      const projection = test.last('GET_ROWS');
      expect(projection.payload).toMatchObject({ sortOffset: '100',
        scanBudget: { maxExaminedRecords: 506, maxExaminedBytes: firstPage.scan?.examinedBytes } });
      expect(projection.payload.anchorOrdinal).toBeUndefined();
      expect(projection.payload.direction).toBeUndefined();
      const projectedPage = await engine.getRows({ ...projection.payload, generation: projection.generation });
      expect(projectedPage.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      expect(test.rows(projection, projectedPage)).toBe(true);

      test.deliver(wire('SOURCE_INVALIDATED', { reason: 'append' }, test.client.session));
      await engine.dispose();
      await appendFile(path, JSON.stringify({ id: '1000', keep: 'absent' }) + '\n');
      const reopened = await open('g2');
      test.opened('g2', 2, true, '1001');
      const recovery = test.last('GET_ROWS');
      expect(recovery.payload).toMatchObject({ sortOffset: '100',
        scanBudget: { maxExaminedRecords: 506, maxExaminedBytes: firstPage.scan?.examinedBytes } });
      expect(recovery.payload.anchorOrdinal).toBeUndefined();
      expect(recovery.payload.direction).toBeUndefined();
      const restoredPage = await reopened.getRows({ ...recovery.payload, generation: recovery.generation });
      expect(restoredPage.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      expect(test.rows(original, firstPage)).toBe(false);
      expect(test.rows(recovery, restoredPage)).toBe(true);
      expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      expect(test.controller.sortOffset).toBe('100');
    });
  });

  it.each([
    { name: 'partial physical DESC page', count: 225, physical: true, anchor: '25', sparse: false, budget: undefined, offset: undefined },
    { name: 'sparse bounded physical DESC page', count: 1000, physical: true, anchor: '900', sparse: true, budget: 50, offset: undefined },
    { name: 'logical DESC page', count: 225, physical: false, anchor: undefined, sparse: false, budget: undefined, offset: '100' },
  ])('preserves $name through Columns refresh and physical append recovery in the real engine', async (scenario) => {
    const records = Array.from({ length: scenario.count }, (_, id) => ({
      id: String(id).padStart(4, '0'), keep: id % 5 === 0 ? 'needle' : 'absent',
    }));
    await withEngineFixture(records, async ({ path, open }) => {
      const engine = await open('g1');
      const test = harness({ followMode: false, sortDirection: 'desc' });
      test.boot();
      if (scenario.sparse) test.controller.applyFilters([{ columnId: JSON.stringify(keyPath('keep').tokens), source: 'record',
        path: keyPath('keep'), operator: 'eq', value: 'needle' }]);
      test.controller.requestRows({
        ...(scenario.anchor === undefined ? {} : { anchorOrdinal: scenario.anchor, direction: 'backward' }),
        ...(scenario.offset === undefined ? {} : { sortOffset: scenario.offset }),
        ...(scenario.budget === undefined ? {} : { scanBudget: { maxExaminedRecords: scenario.budget } }),
      }, { navigation: scenario.physical ? 'physical' : 'logical' });
      const original = test.last('GET_ROWS');
      const firstPage = await engine.getRows({ ...original.payload, generation: original.generation });
      const scanStart = scenario.anchor === undefined ? scenario.count - 1 : Number(scenario.anchor) - 1;
      const examined = Array.from({ length: scenario.budget ?? scanStart + 1 }, (_, index) => scanStart - index)
        .filter((ordinal) => ordinal >= 0 && (!scenario.sparse || ordinal % 5 === 0));
      const expected = examined.slice(Number(scenario.offset ?? '0'), Number(scenario.offset ?? '0') + 100).map(String);
      expect(firstPage.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      expect(test.rows(original, firstPage)).toBe(true);
      const columns: ColumnSpec[] = [{ id: JSON.stringify(keyPath('id').tokens), label: 'ID', source: 'record', path: keyPath('id') }];
      test.controller.requestRows({ ...test.controller.currentViewportOptions(), columns }, { preserveOnRebuild: true });
      const refresh = test.last('GET_ROWS');
      if (scenario.physical) {
        expect(refresh.payload).toMatchObject({ anchorOrdinal: scenario.anchor, direction: 'backward' });
        expect(refresh.payload.sortOffset).toBeUndefined();
      } else {
        expect(refresh.payload.sortOffset).toBe(scenario.offset);
        expect(refresh.payload.anchorOrdinal).toBeUndefined();
        expect(refresh.payload.direction).toBeUndefined();
      }
      if (scenario.budget !== undefined) expect(refresh.payload.scanBudget).toMatchObject({
        maxExaminedRecords: scenario.budget, maxExaminedBytes: firstPage.scan?.examinedBytes,
      });
      const refreshedPage = await engine.getRows({ ...refresh.payload, generation: refresh.generation });
      expect(refreshedPage.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      expect(test.rows(refresh, refreshedPage)).toBe(true);
      expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(expected);
      if (scenario.physical) {
        test.deliver(wire('SOURCE_INVALIDATED', { reason: 'append' }, test.client.session));
        await engine.dispose();
        await appendFile(path, JSON.stringify({ id: String(scenario.count).padStart(4, '0'), keep: 'absent' }) + '\n');
        const reopened = await open('g2');
        test.opened('g2', 2, true, String(scenario.count + 1));
        const recovery = test.last('GET_ROWS');
        expect(recovery.payload).toMatchObject({ anchorOrdinal: scenario.anchor, direction: 'backward' });
        expect(recovery.payload.sortOffset).toBeUndefined();
        const restoredPage = await reopened.getRows({ ...recovery.payload, generation: recovery.generation });
        expect(restoredPage.rows.map((item) => item.ref.ordinal)).toEqual(expected);
        expect(test.rows(recovery, restoredPage)).toBe(true);
      }
    });
  });

  it('renews each replay deadline without shrinking its original time-truncated range in the real engine', async () => {
    const records = Array.from({ length: 20 }, (_, id) => ({ id: String(id).padStart(2, '0'), keep: 'needle' }));
    await withEngineFixture(records, async ({ path, open }) => {
      const engine = await open('g1');
      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const test = harness({ followMode: false, sortDirection: 'desc' });
        test.boot();
        test.controller.applyFilters([{ columnId: JSON.stringify(keyPath('keep').tokens), source: 'record',
          path: keyPath('keep'), operator: 'eq', value: 'needle' }]);
        test.controller.requestRows({ anchorOrdinal: '20', direction: 'backward' }, { navigation: 'physical' });
        const original = test.last('GET_ROWS');
        expect(original.payload.scanBudget).toEqual({ maxExaminedRecords: 100_000, maxExaminedBytes: '67108864', deadlineEpochMs: 6000 });
        const first = await engine.getRows({ ...original.payload, generation: original.generation,
          onHydrated: () => { now += 1000; } });
        const expected = ['19', '18', '17', '16', '15'];
        expect(now).toBe(6000);
        expect(first.rows.map((item) => item.ref.ordinal)).toEqual(expected);
        expect(first.scan).toMatchObject({ examinedRecords: '5', truncatedReason: 'time_limit' });
        expect(test.rows(original, first)).toBe(true);
        const bytes = first.scan?.examinedBytes;
        const columns: ColumnSpec[] = [{ id: JSON.stringify(keyPath('id').tokens), label: 'ID', source: 'record', path: keyPath('id') }];
        const refresh = () => {
          test.controller.requestRows({ ...test.controller.currentViewportOptions(), columns }, { preserveOnRebuild: true });
          return test.last('GET_ROWS');
        };
        now = 10_000;
        const superseded = refresh();
        expect(superseded.payload.scanBudget).toEqual({ maxExaminedRecords: 5, maxExaminedBytes: bytes, deadlineEpochMs: 15_000 });
        now = 11_000;
        const slow = refresh();
        expect(slow.payload.scanBudget).toEqual({ maxExaminedRecords: 5, maxExaminedBytes: bytes, deadlineEpochMs: 16_000 });
        const partial = await engine.getRows({ ...slow.payload, generation: slow.generation,
          onHydrated: () => { now += 6000; } });
        expect(now).toBe(17_000);
        expect(partial.rows.map((item) => item.ref.ordinal)).toEqual(['19']);
        expect(partial.scan).toMatchObject({ examinedRecords: '1', truncatedReason: 'time_limit' });
        expect(test.rows(superseded, first)).toBe(false);
        expect(test.rows(slow, partial)).toBe(true);
        expect(test.controller.currentViewportOptions().scanWindow).toEqual({ records: 5, bytes });
        now = 20_000;
        const fast = refresh();
        expect(fast.payload.scanBudget).toEqual({ maxExaminedRecords: 5, maxExaminedBytes: bytes, deadlineEpochMs: 25_000 });
        const complete = await engine.getRows({ ...fast.payload, generation: fast.generation,
          onHydrated: () => { now += 100; } });
        expect(complete.rows.map((item) => item.ref.ordinal)).toEqual(expected);
        expect(complete.scan).toMatchObject({ examinedRecords: '5', truncatedReason: 'record_limit' });
        expect(test.rows(fast, complete)).toBe(true);
        test.deliver(wire('SOURCE_INVALIDATED', { reason: 'append' }, test.client.session));
        await engine.dispose();
        await appendFile(path, JSON.stringify({ id: '20', keep: 'absent' }) + '\n');
        const reopened = await open('g2');
        now = 30_000;
        test.opened('g2', 2, true, '21');
        const recovery = test.last('GET_ROWS');
        expect(recovery.payload.scanBudget).toEqual({ maxExaminedRecords: 5, maxExaminedBytes: bytes, deadlineEpochMs: 35_000 });
        const recovered = await reopened.getRows({ ...recovery.payload, generation: recovery.generation });
        expect(recovered.rows.map((item) => item.ref.ordinal)).toEqual(expected);
        expect(test.rows(recovery, recovered)).toBe(true);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it('renews a pending projection deadline while retaining its original record and byte caps', () => {
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const test = harness({ followMode: false, sortDirection: 'desc' });
      test.boot();
      test.controller.applyFilters([{ columnId: JSON.stringify(keyPath('keep').tokens), source: 'record',
        path: keyPath('keep'), operator: 'eq', value: 'needle' }]);
      // Generated budgets must be retained too, before the first response exists.
      test.controller.requestRows({ sortOffset: '100' });
      expect(test.controller.currentViewportOptions().scanBudget).toEqual({
        maxExaminedRecords: 100_000, maxExaminedBytes: '67108864', deadlineEpochMs: 6000,
      });
      test.controller.requestRows({ sortOffset: '100', scanBudget: { maxExaminedRecords: 10, maxExaminedBytes: '240', deadlineEpochMs: 6000 } });
      now = 10_000;
      test.controller.requestRows(test.controller.currentViewportOptions(), { preserveOnRebuild: true });
      expect(test.last('GET_ROWS').payload.scanBudget).toEqual({ maxExaminedRecords: 10, maxExaminedBytes: '240', deadlineEpochMs: 15_000 });
      now = 20_000;
      test.controller.requestRows(test.controller.currentViewportOptions(), { preserveOnRebuild: true });
      expect(test.last('GET_ROWS').payload.scanBudget).toEqual({ maxExaminedRecords: 10, maxExaminedBytes: '240', deadlineEpochMs: 25_000 });
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a zero-progress frozen window empty after its deadline expires in the real engine', async () => {
    await withEngineFixture([{ id: 0 }, { id: 1 }], async ({ open }) => {
      const engine = await open('g1');
      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const test = harness({ followMode: false, sortDirection: 'desc' });
        test.boot();
        test.controller.requestRows({ anchorOrdinal: '2', direction: 'backward', scanBudget: { deadlineEpochMs: now } }, { navigation: 'physical' });
        const original = test.last('GET_ROWS');
        const first = await engine.getRows({ ...original.payload, generation: original.generation });
        expect(first.scan).toMatchObject({ examinedRecords: '0', truncatedReason: 'time_limit' });
        expect(test.rows(original, first)).toBe(true);
        for (const time of [10_000, 20_000]) {
          now = time;
          test.controller.requestRows(test.controller.currentViewportOptions(), { preserveOnRebuild: true });
          const replay = test.last('GET_ROWS');
          expect(replay.payload.scanBudget).toEqual({ deadlineEpochMs: time });
          const next = await engine.getRows({ ...replay.payload, generation: replay.generation });
          expect(next.rows).toEqual([]);
          expect(next.scan).toMatchObject({ examinedRecords: '0', truncatedReason: 'time_limit' });
          expect(test.rows(replay, next)).toBe(true);
          expect(test.controller.currentViewportOptions().scanWindow).toEqual({ records: 0 });
        }
      } finally {
        clock.mockRestore();
      }
    });
  });

  it.each(['logical', 'physical'] as const)('keeps pending %s navigation when Columns refresh supersedes it', (navigation) => {
    const sort = { columnId: '__ordinal', direction: 'desc' as const };
    const test = harness({ followMode: false, sortDirection: 'desc' });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['999', '900'], 'g1', { sort, sortOffset: '0' }));
    const options = navigation === 'logical' ? { sortOffset: '200' }
      : { anchorOrdinal: '25', direction: 'backward' as const, scanBudget: { maxExaminedRecords: 10 } };
    test.controller.requestRows(options, { navigation });
    const pending = test.last('GET_ROWS');
    const columns: ColumnSpec[] = [{ id: JSON.stringify(keyPath('id').tokens), label: 'ID', source: 'record', path: keyPath('id') }];
    test.controller.requestRows({ ...test.controller.currentViewportOptions(), columns }, { preserveOnRebuild: true });
    const projection = test.last('GET_ROWS');
    expect(projection.payload).toEqual({ ...pending.payload, columns,
      ...(navigation === 'physical' ? { scanBudget: { ...pending.payload.scanBudget, deadlineEpochMs: expect.any(Number) } } : {}) });
    expect(test.rows(pending, page(['1'], 'g1', { sort }))).toBe(false);
  });

  it('removes a retired profile sort from a pending generation recovery', () => {
    const column: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const sort = { columnId: column.id, direction: 'asc' as const };
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['300', '399'], 'g1', { columns: [column] }));
    test.controller.changeSort(sort);
    test.rows(test.last('GET_ROWS'), page(['300', '399'], 'g1', { columns: [column], sort, sortOffset: '300' }));
    test.controller.nextPage();
    test.opened('g2', 2, true, '1001');
    const recovery = test.last('GET_ROWS');
    expect(recovery.payload).toMatchObject({ sort, sortOffset: '400' });
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    const projected = test.last('GET_ROWS');
    expect(test.controller.sort).toBeUndefined();
    expect(projected.payload.sort).toBeUndefined();
    expect(projected.payload.sortOffset).toBeUndefined();
    expect(test.rows(recovery, page(['400', '499'], 'g2', { sort, sortOffset: '400' }))).toBe(false);
    expect(test.rows(projected, page(['0', '99'], 'g2'))).toBe(true);
  });

  it.each(navigationCases)('clamps the pending $name target after an empty partial-index recovery', ({ name, navigate, cursor }) => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['300', '350', '399']));
    test.controller.reportViewport(row('350').ref);
    navigate(test.controller);
    test.opened('g2', 2, false, '100');
    const recovery = test.last('GET_ROWS');
    test.deliver(wire('PROFILE_CHANGED', { profileId: 'generic', columns: [] }, test.client.session));
    const projected = test.last('GET_ROWS');
    expect(projected.payload).toEqual({ limit: 100, ...cursor });
    const partial: RowPage = { rows: [], columns: [], anchorOrdinal: '0', hasBefore: true,
      hasAfter: false, indexedRecords: '100' };
    expect(test.rows(projected, partial)).toBe(true);
    const requests = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g2', 2, true, '250'), test.client.session));
    const retry = test.last('GET_ROWS');
    const needsClamp = name === 'Previous' || name === 'Next';
    expect(test.count('GET_ROWS')).toBe(requests + (needsClamp ? 1 : 0));
    if (needsClamp) {
      expect(retry.payload).toEqual({ limit: 100, anchorOrdinal: '199', direction: 'forward' });
      expect(test.rows(retry, page(['200', '249'], 'g2', { totalRecords: '250', indexedRecords: '250' }))).toBe(true);
      expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(['200', '249']);
    }
    expect(test.rows(recovery, page(['300', '399'], 'g2'))).toBe(false);
    expect(test.state.viewportMode).toBe('reading');
    expect(test.state.followMode).toBe(true);
  });

  it('restores the actual reading anchor on append while source Follow stays enabled', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    test.controller.pauseFollowing(row('950').ref);
    test.delayCommits();
    test.opened('g2', 2, true, '1001');
    expect(test.last('GET_ROWS').payload).toMatchObject({ anchorOrdinal: '949', direction: 'forward' });
    const count = test.count('GET_ROWS');
    test.controller.requestFollowRows();
    expect(test.count('GET_ROWS')).toBe(count);
    test.commit();
    expect(test.state.followMode).toBe(true);
    expect(test.state.viewportMode).toBe('reading');
    expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(['900', '950', '999']);
    expect(test.state.unseenActivity).toBe(true);
  });

  it('keeps an underfilled ascending page and its selected detail stable across append', () => {
    const test = harness({ followMode: true });
    test.boot();
    const partialPage = page(['900', '950', '999'], 'g1', {
      hasBefore: true, hasAfter: false, indexedRecords: '1000', totalRecords: '1000',
    });
    test.rows(test.last('GET_ROWS'), partialPage);
    test.dispatch({ type: 'SELECT_ROW', ref: partialPage.rows[1]!.ref, ordinal: '950' });
    test.delayCommits();
    test.controller.pauseFollowing(partialPage.rows[1]!.ref);
    test.opened('g2', 2, true, '1001');

    const recovery = test.last('GET_ROWS');
    expect(recovery.payload).toEqual({ limit: 100, anchorOrdinal: '949', direction: 'forward' });
    const refreshed = page(['900', '950', '999'], 'g2', {
      hasBefore: true, hasAfter: true, indexedRecords: '1001', totalRecords: '1001',
    });
    expect(test.rows(recovery, refreshed)).toBe(true);
    test.commit();

    expect(test.state.rows.map((item) => item.ref.ordinal)).toEqual(['900', '950', '999']);
    expect(test.state.viewportMode).toBe('reading');
    expect(test.state.followMode).toBe(true);
    expect(test.state.selectedOrdinal).toBe('950');
    expect(test.state.selectedRef?.ordinal).toBe('950');
  });

  it('cancels a late automatic tail page synchronously when reading begins', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    test.controller.requestFollowRows();
    const tail = test.last('GET_ROWS');
    test.delayCommits();
    test.controller.pauseFollowing(row('950').ref);
    expect(test.last('CANCEL').payload.targetRequestId).toBe(tail.requestId);
    expect(test.rows(tail, page(['901', '1000']))).toBe(false);
    test.controller.requestFollowRows();
    expect(test.last('GET_ROWS').requestId).toBe(tail.requestId);
    test.commit();
    expect(test.state.rows.at(-1)?.ref.ordinal).toBe('999');
  });

  it('requeries the retained semantic anchor when reading starts during generation adoption', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    test.opened('g2', 2, true, '1001');
    const tail = test.last('GET_ROWS');
    test.controller.pauseFollowing(row('950').ref);
    const reading = test.last('GET_ROWS');
    expect(reading.requestId).not.toBe(tail.requestId);
    expect(reading.generation).toBe('g2');
    expect(reading.payload).toMatchObject({ anchorOrdinal: '949', direction: 'forward' });
    expect(test.rows(tail, page(['901', '1000'], 'g2'))).toBe(false);
  });

  it('recovers the last observed actual anchor when a non-table interaction pauses generation adoption', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    test.controller.reportViewport(row('950').ref);
    test.opened('g2', 2, true, '1001');
    const tail = test.last('GET_ROWS');
    test.controller.pauseFollowing();
    const reading = test.last('GET_ROWS');
    expect(test.last('CANCEL').payload.targetRequestId).toBe(tail.requestId);
    expect(reading.requestId).not.toBe(tail.requestId);
    expect(reading.generation).toBe('g2');
    expect(reading.payload).toMatchObject({ anchorOrdinal: '949', direction: 'forward' });
    expect(test.rows(tail, page(['901', '1000'], 'g2'))).toBe(false);
    test.rows(reading, page(['950', '999'], 'g2'));
    expect(test.state.rows[0]?.ref.generation).toBe('g2');
    expect(test.state.viewportMode).toBe('reading');
    expect(test.state.unseenActivity).toBe(true);
  });

  it('returns to the physical tail and clears filters without clearing unseen activity early', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.editQuery('tool');
    test.controller.applyFilter({ columnId: 'eventKind', operator: 'eq', value: 'tool', source: 'profile' });
    test.controller.changeSort({ columnId: 'eventKind', direction: 'asc' });
    test.opened('g2', 2, true, '1001');
    test.delayCommits();
    test.controller.returnToLatest();
    expect(test.controller.viewportMode).toBe('following');
    expect(test.controller.query).toBe('');
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, direction: 'backward' });
    test.commit();
    expect(test.state.query).toBe('');
    expect(test.state.filter).toBeUndefined();
    expect(test.state.sort).toBeUndefined();
    expect(test.state.unseenActivity).toBe(true);
    test.rows(test.last('GET_ROWS'), page(['901', '1000'], 'g2', { indexedRecords: '1001' }));
    expect(test.state.unseenActivity).toBe(true);
    test.dispatch({ type: 'TAIL_VISIBLE', generation: 'g2', ordinal: '1000', indexedRecords: '1001', epoch: 2 });
    expect(test.state.unseenActivity).toBe(false);
  });

  it('does not request automatic tail pages with source Follow disabled', () => {
    const test = harness();
    test.boot();
    const count = test.count('GET_ROWS');
    test.controller.requestFollowRows();
    expect(test.count('GET_ROWS')).toBe(count);
  });

  it('resumes at a manually observed latest row without requesting rows or changing the clicked detail', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.pauseFollowing(row('900').ref);
    test.dispatch({ type: 'SELECT_ROW', ref: row('900').ref });
    test.deliver(wire('INDEX_PROGRESS', summary('g1', 1, true, '1001'), test.client.session));
    test.controller.requestRows({ direction: 'backward' });
    test.rows(test.last('GET_ROWS'), page(['901', '1000'], 'g1', { indexedRecords: '1001' }));
    const selected = test.state.selectedRef;
    const requests = test.count('GET_ROWS');
    const actionCount = test.actions.length;
    test.delayCommits();
    expect(test.controller.resumeFollowingAtTail(row('1000').ref)).toBe(true);
    expect(test.controller.viewportMode).toBe('following');
    expect(test.state.viewportMode).toBe('reading');
    expect(test.actions.slice(actionCount)).toEqual([{ type: 'SET_VIEWPORT_MODE', mode: 'following' }]);
    expect(test.count('GET_ROWS')).toBe(requests);
    test.commit();
    expect(test.state.selectedRef).toBe(selected);
    expect(test.state.detailOpen).toBe(true);
    expect(test.state.unseenActivity).toBe(true);
    test.dispatch({ type: 'TAIL_VISIBLE', generation: 'g1', ordinal: '1000', indexedRecords: '1001', epoch: 1 });
    expect(test.state.unseenActivity).toBe(false);
    test.deliver(wire('INDEX_PROGRESS', summary('g1', 1, true, '1002'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(requests + 1);
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, direction: 'backward' });
  });

  it.each([
    { name: 'a historical page bottom', ordinals: ['0', '99'], ref: row('99').ref },
    { name: 'an unloaded latest row', ordinals: ['900', '950'], ref: row('999').ref },
    { name: 'a stale generation', ordinals: ['900', '999'], ref: row('999', 'old').ref },
    { name: 'different bytes at the latest ordinal', ordinals: ['900', '999'],
      ref: { ...row('999').ref, byteStart: '1' } },
  ])('does not resume at $name', ({ ordinals, ref }) => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(ordinals, 'g1', { hasAfter: false }));
    test.controller.pauseFollowing();
    const actions = test.actions.length;
    const requests = test.count('GET_ROWS');
    expect(test.controller.resumeFollowingAtTail(ref)).toBe(false);
    expect(test.controller.viewportMode).toBe('reading');
    expect(test.actions).toHaveLength(actions);
    expect(test.count('GET_ROWS')).toBe(requests);
  });

  it.each(['query', 'filter', 'sort'] as const)('does not resume at the final %s result or clear its view', (kind) => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    if (kind === 'query') {
      test.controller.editQuery('tool');
      test.controller.requestRows();
    } else if (kind === 'filter') {
      test.controller.applyFilter({ columnId: 'eventKind', operator: 'eq', value: 'tool', source: 'profile' });
    } else test.controller.changeSort({ columnId: 'eventKind', direction: 'asc' });
    test.rows(test.last('GET_ROWS'), page(['999'], 'g1', { hasAfter: false, matchedRecords: '1' }));
    const state = test.state;
    const actions = test.actions.length;
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(false);
    expect(test.controller.viewportMode).toBe('reading');
    expect(test.actions).toHaveLength(actions);
    expect(test.state).toBe(state);
  });

  it('rejects an old tail watermark before and after a delayed progress commit', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.pauseFollowing();
    test.delayCommits();
    test.deliver(wire('INDEX_PROGRESS', summary('g1', 1, true, '1001'), test.client.session));
    expect(test.state.latestSeq).toBe('1000');
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(false);
    test.commit();
    expect(test.state.latestSeq).toBe('1001');
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(false);
    expect(test.controller.viewportMode).toBe('reading');
  });

  it('does not resume with source Follow disabled', () => {
    const test = harness();
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(false);
    expect(test.controller.viewportMode).toBe('reading');
  });

  it('waits for pending rows and rebuild recovery before resuming', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.pauseFollowing();
    test.controller.requestRows({ direction: 'backward' });
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(false);
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    test.controller.rebuild();
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(false);
    test.opened('g2', 2, true, '1000', test.last('REBUILD_INDEX').requestId);
    expect(test.controller.resumeFollowingAtTail(row('999', 'g2').ref)).toBe(false);
    test.rows(test.last('GET_ROWS'), page(['900', '999'], 'g2'));
    expect(test.controller.resumeFollowingAtTail(row('999', 'g2').ref)).toBe(true);
  });

  it('allows the physical latest row in descending ordinal order without changing the order', () => {
    const test = harness({ followMode: true, sortDirection: 'desc' });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['999', '998'], 'g1', {
      sort: { columnId: '__ordinal', direction: 'desc' }, sortOffset: '0',
    }));
    test.controller.pauseFollowing(row('998').ref);
    const requests = test.count('GET_ROWS');
    expect(test.controller.resumeFollowingAtTail(row('999').ref)).toBe(true);
    expect(test.controller.sort).toEqual({ columnId: '__ordinal', direction: 'desc' });
    expect(test.count('GET_ROWS')).toBe(requests);
  });

  it('uses a backward physical tail during incomplete indexing with descending preference', () => {
    const test = harness({ followMode: true, sortDirection: 'desc' });
    test.boot(false);
    test.controller.pauseFollowing();
    test.controller.returnToLatest();
    expect(test.last('GET_ROWS').payload).toEqual({ limit: 100, direction: 'backward' });
    expect(test.controller.sort).toBeUndefined();
    expect(test.controller.sortDirection).toBe('desc');
  });

  it('releases a retained reading anchor when an explicit replacement page includes that row', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    test.controller.pauseFollowing(row('950').ref);
    expect(test.state.viewportRevision).toBe(0);
    test.controller.requestRows({ anchorOrdinal: '899', direction: 'forward' });
    expect(test.state.viewportRevision).toBe(0);
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    expect(test.state.viewportRevision).toBe(1);
    test.opened('g2', 2, true, '1001');
    expect(test.last('GET_ROWS').payload).toMatchObject({ anchorOrdinal: '899', direction: 'forward' });
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999'], 'g2'));
    expect(test.state.viewportRevision).toBe(1);
  });

  it('does not reset the reading viewport for rejected, preserved or tail row responses', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    const revision = test.state.viewportRevision;
    test.controller.pauseFollowing(row('950').ref);
    test.controller.requestRows({ anchorOrdinal: '899', direction: 'forward' });
    const retired = test.last('GET_ROWS');
    test.controller.requestRows({ anchorOrdinal: '899', direction: 'forward' }, { preserveOnRebuild: true });
    expect(test.rows(retired, page(['900', '950', '999']))).toBe(false);
    expect(test.state.viewportRevision).toBe(revision);
    test.rows(test.last('GET_ROWS'), page(['900', '950', '999']));
    expect(test.state.viewportRevision).toBe(revision);
    test.controller.returnToLatest();
    test.rows(test.last('GET_ROWS'), page(['901', '1000']));
    expect(test.state.viewportRevision).toBe(revision);
  });

  it('refreshes the bounded live tail on index progress while Reading only updates activity', () => {
    const test = harness({ followMode: true });
    test.boot();
    test.rows(test.last('GET_ROWS'), page(['900', '999']));
    const count = test.count('GET_ROWS');
    test.deliver(wire('INDEX_PROGRESS', summary('g1', 1, true, '1001'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count + 1);
    expect(test.last('GET_ROWS').payload.direction).toBe('backward');
    test.deliver(wire('INDEX_PROGRESS', summary('g1', 1, true, '1001'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count + 1);
    test.controller.pauseFollowing(row('900').ref);
    test.deliver(wire('INDEX_PROGRESS', summary('g1', 1, true, '1002'), test.client.session));
    expect(test.count('GET_ROWS')).toBe(count + 1);
    expect(test.state.latestSeq).toBe('1002');
    expect(test.state.unseenActivity).toBe(true);
  });

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
    expect(test.count('GET_ROWS')).toBe(count + (mode === 'follow' ? 1 : 0));
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
    const sort = { columnId: 'value', direction: 'desc' as const };
    const test = harness({ sort });
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
    expect(test.last('GET_ROWS').payload).toEqual({
      limit: 100,
      sort: { columnId: '__ordinal', direction: 'desc' },
      sortOffset: '0',
    });
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
