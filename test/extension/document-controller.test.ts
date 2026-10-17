import { describe, expect, it, vi } from 'vitest';
import { DocumentController, type JsonlSessionPort, type MessageChannel } from '../../src/extension/document-controller';
import type { ObservabilityEvent } from '../../src/extension/observability-contract';
import {
  PROTOCOL_VERSION,
  type ColumnSpec,
  type DocumentSummary,
  type ExtensionMessage,
  type RowPage,
} from '../../src/shared/types';

function summary(): DocumentSummary {
  return {
    snapshot: {
      documentId: 'document',
      generation: 'generation',
      uri: 'file:///fixture.jsonl',
      scheme: 'file',
      sizeBytes: '0',
      mtimeMs: 0,
      prefixFingerprint: 'empty',
      observedAt: '2026-01-01T00:00:00.000Z',
    },
    profileId: 'generic',
    profileVersion: '1',
    profileSuggestions: [],
    indexedBytes: '0',
    indexedRecords: '0',
    indexingComplete: true,
    validRecords: '0',
    problemRecords: '0',
  };
}

function fakeSession(profileColumns: readonly ColumnSpec[] = []): JsonlSessionPort {
  let value = summary();
  return {
    getSummary: () => value,
    getProfileColumns: () => profileColumns,
    getRows: async () => ({
      rows: [],
      columns: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
      totalRecords: '0',
    }),
    getProblems: async () => ({
      items: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
      observedProblemRecords: '0',
      complete: true,
      scan: { examinedRecords: '0', examinedBytes: '0' },
    }),
    getDetail: async (ref) => ({
      ref,
      rawPreview: '',
      rawComplete: true,
      problems: [],
    }),
    getSchema: async () => ({ fields: [], totalFields: 0, complete: true }),
    getInsights: async (intent) => ({
      intent,
      provenance: { scope: intent.scope, predicateApplied: intent.predicate !== undefined, coverage: 'complete' },
      categories: [],
      timeBuckets: [],
      processedRecords: '0',
      examinedRecords: '0',
      examinedBytes: '0',
      truncated: false,
      capacityReached: false,
      bucketWidthMs: 300_000,
    }),
    setProfile: async (profileId) => { value = { ...value, profileId }; return value; },
    setFollowMode: async () => value,
    rebuild: async () => value,
  };
}

function request(
  type: string,
  payload: Record<string, unknown> = {},
  requestId = `request-${type}`,
): Record<string, unknown> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    documentId: 'document',
    generation: 'generation',
    requestId,
    payload,
  };
}

function queryDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise; reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Navigator bridge handoff', () => {
  const opened = {
    version: 1 as const,
    status: 'opened' as const,
    enabled: 'enabled' as const,
    authorization: 'granted' as const,
    authorizationReadback: 'confirmed' as const,
    action: 'focus-sessions' as const,
    targetDocumentId: 'document',
    sourceId: 'codex-source',
  };

  it('publishes only a Host-validated result as NAVIGATOR_STATUS', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => { messages.push(message); return true; },
    }, { onOpenSessionNavigator: async () => opened });

    await controller.handleMessage(request('OPEN_SESSION_NAVIGATOR'));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'NAVIGATOR_STATUS', requestId: 'request-OPEN_SESSION_NAVIGATOR', payload: opened });
  });

  it('rejects an untyped Host handoff without mutating Navigator state', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => { messages.push(message); return true; },
    }, { onOpenSessionNavigator: async () => ({ status: 'opened' }) });

    await controller.handleMessage(request('OPEN_SESSION_NAVIGATOR'));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'ERROR', payload: { code: 'NAVIGATOR_RESULT_INVALID', recoverable: true } });
  });
});

describe('GET_ROWS local operation observations', () => {
  function fixture() {
    const session = fakeSession();
    const events: ObservabilityEvent[] = [];
    const messages: ExtensionMessage[] = [];
    const channel: MessageChannel = { postMessage: async (message) => { messages.push(message); return true; } };
    const controller = new DocumentController(session, channel, { onQueryOperation: (event) => { events.push(event); } });
    return { session, events, messages, channel, controller };
  }

  it('pairs starts and terminals with per-controller sequence, including empty rows', async () => {
    const f = fixture();
    await f.controller.handleMessage(request('READY'));
    await f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'private-request-one'));
    await f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'private-request-two'));
    expect(f.events.map((event) => [event.name, event.attributes.request_seq])).toEqual([
      ['jsonlview.query.started', 1], ['jsonlview.query.settled', 1],
      ['jsonlview.query.started', 2], ['jsonlview.query.settled', 2],
    ]);
    expect(f.events[1]?.attributes).toEqual({ stage: 'get_rows', request_seq: 1,
      outcome: 'completed', delivery: 'accepted', abort_observed: false, duration_ms: expect.any(Number), rows: 0 });
    expect(f.events[1]?.attributes.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(f.events)).not.toMatch(/private-request|documentId|generation|epoch|fixture.jsonl/u);
    const allowed = new Set(['stage', 'request_seq', 'outcome', 'delivery', 'abort_observed', 'duration_ms', 'rows']);
    expect(f.events.every((event) => Object.keys(event.attributes).every((key) => allowed.has(key)))).toBe(true);
    const second = fixture();
    await second.controller.handleMessage(request('GET_ROWS', { limit: 10 }));
    expect(second.events[0]?.attributes.request_seq).toBe(1);
  });

  it('does not observe rejected identities, invalid requests, or non-query operations', async () => {
    const f = fixture();
    await f.controller.handleMessage(request('GET_ROWS', { limit: 0 }));
    await f.controller.handleMessage({ ...request('GET_ROWS', { limit: 10 }), generation: 'other' });
    await f.controller.handleMessage({ ...request('GET_ROWS', { limit: 10 }), documentId: 'other' });
    await f.controller.handleMessage(request('GET_SCHEMA', { offset: 0, limit: 10 }));
    expect(f.events).toEqual([]);
    expect(f.messages.map((message) => message.type)).toEqual(['ERROR', 'ERROR', 'ERROR', 'SCHEMA']);
  });

  it('distinguishes a rejected ROWS post from a failed operation', async () => {
    const f = fixture();
    f.channel.postMessage = async () => false;
    await f.controller.handleMessage(request('GET_ROWS', { limit: 10 }));
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'completed', delivery: 'rejected' });
    expect(f.events).toHaveLength(2);
  });

  it('records a failed ROWS post even if sending the existing error response also fails', async () => {
    const f = fixture();
    const error = new TypeError('private delivery body at C:/secret/file.jsonl');
    f.channel.postMessage = async () => { throw error; };
    await expect(f.controller.handleMessage(request('GET_ROWS', { limit: 10 }))).rejects.toBe(error);
    expect(f.events).toHaveLength(2);
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'failed', delivery: 'failed', error_name: 'TypeError' });
    expect(JSON.stringify(f.events)).not.toContain('private');
  });

  it('classifies failures with fixed metadata while preserving the existing error response', async () => {
    const f = fixture();
    const error = Object.assign(new Error('private query value at C:/secret/file.jsonl'), { name: 'PrivateError', code: 'private' });
    f.session.getRows = async () => { throw error; };
    await f.controller.handleMessage(request('GET_ROWS', { limit: 10 }));
    expect(f.messages[0]).toMatchObject({ type: 'ERROR', payload: { code: 'REQUEST_FAILED', message: error.message } });
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'failed', delivery: 'skipped', error_name: 'UnknownError' });
    expect(JSON.stringify(f.events)).not.toMatch(/private|PrivateError|secret/u);
  });

  it.each(['cancelled', 'stale'] as const)('keeps failed delivery separate from a later %s gate', async (outcome) => {
    const f = fixture();
    const delivered = queryDeferred<boolean>();
    let current = summary();
    f.session.getSummary = () => current;
    f.channel.postMessage = async (message) => { f.messages.push(message); return delivered.promise; };
    const handling = f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'old'));
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    if (outcome === 'cancelled') await f.controller.handleMessage(request('CANCEL', { targetRequestId: 'old' }));
    else current = { ...current, snapshot: { ...current.snapshot, generation: 'private-new' } };
    delivered.reject(new Error('private failed delivery'));
    await handling;
    expect(f.events).toHaveLength(2);
    expect(f.events[1]?.attributes).toMatchObject({ outcome, delivery: 'failed', abort_observed: outcome === 'cancelled' });
    if (outcome === 'stale') expect(f.events[1]?.attributes.stale_reason).toBe('generation');
    expect(f.messages.map((message) => message.type)).toEqual(['ROWS']);
  });

  it.each(['document', 'generation', 'epoch'] as const)('records the original %s stale gate without raw identity', async (field) => {
    const f = fixture();
    const page = await f.session.getRows({ limit: 10 }, new AbortController().signal);
    const pending = queryDeferred<RowPage>();
    let current = summary();
    f.session.getSummary = () => current;
    f.session.getRows = () => pending.promise;
    const handling = f.controller.handleMessage(request('GET_ROWS', { limit: 10 }));
    current = { ...current, snapshot: { ...current.snapshot,
      ...(field === 'document' ? { documentId: 'private-new-document' }
        : field === 'generation' ? { generation: 'private-new-generation' } : { epoch: 2 }) } };
    pending.resolve(page);
    await handling;
    expect(f.messages).toEqual([]);
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'stale', delivery: 'skipped', stale_reason: field });
    expect(JSON.stringify(f.events)).not.toContain('private-new');
  });

  it('records staleness at the second identity gate instead of mislabelling delivery rejection', async () => {
    const f = fixture();
    const current = summary();
    let reads = 0;
    f.session.getSummary = () => ++reads <= 2 ? current
      : { ...current, snapshot: { ...current.snapshot, generation: 'new' } };
    await f.controller.handleMessage(request('GET_ROWS', { limit: 10 }));
    expect(reads).toBe(3);
    expect(f.messages).toEqual([]);
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'stale', delivery: 'skipped', stale_reason: 'generation' });
  });

  it('observes cooperative cancellation only when the existing handler settles', async () => {
    const f = fixture();
    const pending = queryDeferred<RowPage>();
    f.session.getRows = () => pending.promise;
    const handling = f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'old'));
    await f.controller.handleMessage(request('CANCEL', { targetRequestId: 'old' }));
    expect(f.events).toHaveLength(1);
    pending.reject(new Error('private abort reason'));
    await handling;
    expect(f.events).toHaveLength(2);
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'cancelled', delivery: 'skipped', abort_observed: true });
    expect(f.events[1]?.attributes).not.toHaveProperty('error_name');
    expect(f.messages).toEqual([]);
  });

  it.each(['cancel', 'supersede', 'dispose'] as const)('preserves non-cooperative late delivery after %s', async (action) => {
    const f = fixture();
    const page = await f.session.getRows({ limit: 10 }, new AbortController().signal);
    const pending = queryDeferred<RowPage>();
    let calls = 0;
    f.session.getRows = () => ++calls === 1 ? pending.promise : Promise.resolve(page);
    const handling = f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'old'));
    if (action === 'cancel') await f.controller.handleMessage(request('CANCEL', { targetRequestId: 'old' }));
    else if (action === 'supersede') await f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'new'));
    else f.controller.dispose();
    pending.resolve(page);
    await handling;
    expect(f.messages.some((message) => message.type === 'ROWS' && message.requestId === 'old')).toBe(true);
    const terminals = f.events.filter((event) => event.name === 'jsonlview.query.settled' && event.attributes.request_seq === 1);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.attributes).toMatchObject({ outcome: 'completed', delivery: 'accepted', abort_observed: true });
  });

  it('does not rewrite a successful post when cancellation arrives during its acknowledgement', async () => {
    const f = fixture();
    const delivered = queryDeferred<boolean>();
    f.channel.postMessage = async (message) => { f.messages.push(message); return delivered.promise; };
    const handling = f.controller.handleMessage(request('GET_ROWS', { limit: 10 }, 'old'));
    await vi.waitFor(() => expect(f.messages).toHaveLength(1));
    await f.controller.handleMessage(request('CANCEL', { targetRequestId: 'old' }));
    delivered.resolve(true);
    await handling;
    expect(f.events[1]?.attributes).toMatchObject({ outcome: 'completed', delivery: 'accepted', abort_observed: true });
    expect(f.events).toHaveLength(2);
  });

  it('contains observer failures at both start and terminal without changing messages', async () => {
    const session = fakeSession();
    const messages: ExtensionMessage[] = [];
    let calls = 0;
    const controller = new DocumentController(session, { postMessage: async (message) => { messages.push(message); return true; } }, {
      onQueryOperation: () => { calls += 1; throw new Error('observer failed'); },
    });
    await expect(controller.handleMessage(request('GET_ROWS', { limit: 10 }))).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(messages.map((message) => message.type)).toEqual(['ROWS']);
  });

  it('preserves the failed-operation response when both observations throw', async () => {
    const session = fakeSession();
    const error = new Error('original query failure');
    session.getRows = async () => { throw error; };
    const messages: ExtensionMessage[] = [];
    let observations = 0;
    const controller = new DocumentController(session, { postMessage: async (message) => { messages.push(message); return true; } }, {
      onQueryOperation: () => { observations += 1; throw new Error('observer failed'); },
    });
    await expect(controller.handleMessage(request('GET_ROWS', { limit: 10 }))).resolves.toBeUndefined();
    expect(observations).toBe(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'ERROR', payload: { code: 'REQUEST_FAILED', message: error.message } });
  });
});

describe('document controller', () => {
  it('publishes temporary metadata on the cold handshake and gates native Save As by envelope identity', async () => {
    const messages: ExtensionMessage[] = [];
    const saves: Array<() => boolean> = [];
    const controller = new DocumentController(fakeSession(), { postMessage: async (message) => { messages.push(message); return true; } }, {
      getPreviewStatus: () => ({ status: 'temporary', recordCount: 2, sizeBytes: 24, savedCopy: false }),
      onSavePreviewAs: async (current) => { saves.push(current); },
    });
    await controller.handleMessage(request('READY'));
    expect(messages.map((message) => message.type)).toEqual(['OPENED', 'PREVIEW_STATUS']);
    await controller.handleMessage({ ...request('SAVE_PREVIEW_AS'), documentId: 'other' });
    await controller.handleMessage({ ...request('SAVE_PREVIEW_AS'), generation: 'old' });
    await controller.handleMessage(request('SAVE_PREVIEW_AS', { path: 'untrusted' }));
    expect(saves).toHaveLength(0);
    await controller.handleMessage(request('SAVE_PREVIEW_AS'));
    expect(saves).toHaveLength(1); expect(saves[0]!()).toBe(true);
    controller.dispose(); expect(saves[0]!()).toBe(false);
  });

  it('responds to READY with the current document summary', async () => {
    const messages: ExtensionMessage[] = [];
    const channel: MessageChannel = {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    };
    const controller = new DocumentController(fakeSession(), channel);
    await controller.handleMessage(request('READY'));
    expect(messages[0]?.type).toBe('OPENED');
  });

  it('reports a failed OPENED delivery and does not run post-handshake actions', async () => {
    const deliveries: boolean[] = [];
    let readyActions = 0;
    const controller = new DocumentController(fakeSession(), {
      postMessage: async () => false,
    }, {
      onOpenedDelivery: (delivered) => { deliveries.push(delivered); },
      onReady: () => { readyActions += 1; },
    });

    await controller.handleMessage(request('READY'));

    expect(deliveries).toEqual([false]);
    expect(readyActions).toBe(0);
  });

  it('records READY only after validating its document identity', async () => {
    let readyReceipts = 0;
    const controller = new DocumentController(fakeSession(), {
      postMessage: async () => true,
    }, {
      onReadyReceived: () => { readyReceipts += 1; },
    });
    const wrongDocument = request('READY');
    wrongDocument.documentId = 'another-document';

    await controller.handleMessage(wrongDocument);
    await controller.handleMessage(request('READY'));

    expect(readyReceipts).toBe(1);
  });

  it('records a rejected first row post and its successful retry', async () => {
    const events: string[] = [];
    let rowPosts = 0;
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => message.type !== 'ROWS' || ++rowPosts > 1,
    }, {
      onFirstRowsRequest: () => { events.push('requested'); },
      onFirstRowsResult: ({ status, rows, indexedRecords }) => {
        events.push([status, rows, indexedRecords].join(':'));
      },
    });

    await controller.handleMessage(request('GET_ROWS', { limit: 100 }, 'rows-1'));
    await controller.handleMessage(request('GET_ROWS', { limit: 100 }, 'rows-2'));
    await controller.handleMessage(request('GET_ROWS', { limit: 100 }, 'rows-3'));

    expect(events).toEqual(['requested', 'rejected:0:0', 'posted:0:0']);
  });

  it('hands a bounded diagnostic banner action to the host without a data response', async () => {
    const diagnostics: Array<{ code: string; message: string; action?: 'explain' | 'copy' }> = [];
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    }, {
      onDiagnosticError: (diagnostic) => { diagnostics.push(diagnostic); },
    });

    await controller.handleMessage(request('DIAGNOSE_ERROR', {
      code: 'REQUEST_FAILED',
      message: 'The request failed.',
      action: 'copy',
    }));
    const stale = request('DIAGNOSE_ERROR', {
      code: 'STALE_GENERATION',
      message: 'The banner was retained across a refresh.',
      action: 'explain',
    }, 'stale-diagnostic');
    stale.generation = 'old-generation';
    await controller.handleMessage(stale);

    expect(diagnostics).toEqual([
      { code: 'REQUEST_FAILED', message: 'The request failed.', action: 'copy' },
      { code: 'STALE_GENERATION', message: 'The banner was retained across a refresh.', action: 'explain' },
    ]);
    expect(messages).toEqual([]);
  });

  it('acknowledges a saved row-order preference only after the extension hook completes', async () => {
    const messages: ExtensionMessage[] = [];
    const saved: string[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    }, {
      onRowOrderChanged: async (direction) => { saved.push(direction); },
    });

    await controller.handleMessage(request('SET_ROW_ORDER', { direction: 'desc' }));

    expect(saved).toEqual(['desc']);
    expect(messages[0]).toMatchObject({ type: 'ROW_ORDER_CHANGED', payload: { direction: 'desc' } });
  });

  it('uses READY as a same-document re-handshake after generation changes', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });
    const staleReady = request('READY');
    staleReady.generation = 'old-generation';

    await controller.handleMessage(staleReady);

    expect(messages[0]).toMatchObject({
      type: 'OPENED',
      generation: 'generation',
      payload: { snapshot: { generation: 'generation' } },
    });
  });

  it('waits for persisted row order before acknowledging it', async () => {
    const messages: ExtensionMessage[] = [];
    let release: () => void = () => undefined;
    const persisted = new Promise<void>((resolve) => { release = resolve; });
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => { messages.push(message); return true; },
    }, { onRowOrderChanged: async () => persisted });
    try {
      const pending = controller.handleMessage(request('SET_ROW_ORDER', { direction: 'desc' }));
      await Promise.resolve();
      expect(messages).toEqual([]);
      release();
      await pending;
      expect(messages[0]).toMatchObject({ type: 'ROW_ORDER_CHANGED', payload: { direction: 'desc' } });
    } finally {
      release();
      controller.dispose();
    }
  });

  it('does not acknowledge row order when persistence fails', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => { messages.push(message); return true; },
    }, { onRowOrderChanged: async () => { throw new Error('synthetic persistence failure'); } });
    try {
      await controller.handleMessage(request('SET_ROW_ORDER', { direction: 'desc' }));
      expect(messages).toHaveLength(1);
      expect(messages[0]?.type).toBe('ERROR');
      expect(messages.some((message) => message.type === 'ROW_ORDER_CHANGED')).toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it('rejects a stale generation before invoking the session', async () => {
    const messages: ExtensionMessage[] = [];
    const channel: MessageChannel = {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    };
    const controller = new DocumentController(fakeSession(), channel);
    const stale = request('GET_ROWS', { limit: 100 });
    stale.generation = 'old';
    await controller.handleMessage(stale);
    expect(messages[0]).toMatchObject({
      type: 'ERROR',
      payload: { code: 'STALE_GENERATION' },
    });
  });

  it('keeps a moving source recoverable without reporting a destructive request failure', async () => {
    const messages: ExtensionMessage[] = [];
    let recoveryRequests = 0;
    const session = {
      ...fakeSession(),
      getDetail: async () => {
        throw Object.assign(new Error('The JSONL source has no stable baseline; rebuild after the writer settles.'), { code: 'SOURCE_CHANGED' });
      },
    };
    const controller = new DocumentController(session, {
      postMessage: async (message) => { messages.push(message); return true; },
    }, {
      onTransientSourceChange: () => { recoveryRequests += 1; return true; },
    });

    await controller.handleMessage(request('GET_DETAIL', {
      ref: {
        documentId: 'document',
        generation: 'generation',
        ordinal: '0',
        byteStart: '0',
        byteEndExclusive: '1',
        contentByteLength: '1',
        delimiterByteLength: 1,
        parseState: 'valid',
      },
    }));

    expect(recoveryRequests).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'ERROR',
      payload: { code: 'SOURCE_UPDATING', recoverable: true },
    });
  });

  it('rejects a stale lifecycle epoch before invoking the session', async () => {
    const messages: ExtensionMessage[] = [];
    const current = { ...summary(), snapshot: { ...summary().snapshot, epoch: 2 } };
    const session = { ...fakeSession(), getSummary: () => current };
    const controller = new DocumentController(session, {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });
    const stale = request('GET_PROBLEMS', { limit: 20 });
    stale.epoch = 1;

    await controller.handleMessage(stale);

    expect(messages[0]).toMatchObject({
      type: 'ERROR',
      payload: { code: 'STALE_EPOCH' },
    });
  });

  it('routes insight work through its own bounded response type', async () => {
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(fakeSession(), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    await controller.handleMessage(request('GET_INSIGHTS', { intent: {
      version: 1, intentRevision: 1, dimension: 'eventKind', scope: 'current-view',
      document: { documentId: 'document', generation: 'generation' },
      profile: { id: 'generic', version: '1' },
    } }));

    expect(messages[0]).toMatchObject({
      type: 'INSIGHTS',
      payload: { intent: { dimension: 'eventKind' }, processedRecords: '0', examinedRecords: '0' },
    });
  });

  it.each([
    { document: { documentId: 'document', generation: 'generation', sourceEpoch: 2 } },
    { profile: { id: 'generic', version: 'retired' } },
  ])('rejects an Insights source or adapter identity mismatch before scanning', async (identity) => {
    const messages: ExtensionMessage[] = [];
    let scans = 0;
    const session = fakeSession();
    const controller = new DocumentController({ ...session, getInsights: async (intent, signal) => {
      scans += 1;
      return session.getInsights(intent, signal);
    } }, { postMessage: async (message) => { messages.push(message); return true; } });

    await controller.handleMessage(request('GET_INSIGHTS', { intent: {
      version: 1, intentRevision: 1, dimension: 'eventKind', scope: 'current-view',
      document: { documentId: 'document', generation: 'generation' },
      profile: { id: 'generic', version: '1' }, ...identity,
    } }));

    expect(scans).toBe(0);
    expect(messages[0]).toMatchObject({ type: 'ERROR', payload: { code: 'STALE_ANALYSIS_INTENT' } });
  });

  it('does not post a completed old Insights result after the selected adapter changes', async () => {
    const messages: ExtensionMessage[] = [];
    let selected = summary();
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const session = fakeSession();
    const controller = new DocumentController({ ...session, getSummary: () => selected,
      getInsights: async (intent, signal) => { await paused; return session.getInsights(intent, signal); },
    }, { postMessage: async (message) => { messages.push(message); return true; } });
    const pending = controller.handleMessage(request('GET_INSIGHTS', { intent: {
      version: 1, intentRevision: 1, dimension: 'eventKind', scope: 'current-view',
      document: { documentId: 'document', generation: 'generation' },
      profile: { id: 'generic', version: '1' },
    } }));
    selected = { ...selected, profileId: 'codex', profileVersion: '2' };
    release?.();
    await pending;
    expect(messages).toEqual([]);
  });

  it('routes bounded problem scans without using the visible row page', async () => {
    const messages: ExtensionMessage[] = [];
    const problems = {
      items: [{ code: 'BLANK_RECORD', message: 'blank', severity: 'warning' as const }],
      anchorOrdinal: '3',
      hasBefore: false,
      hasAfter: true,
      indexedRecords: '4',
      observedProblemRecords: '1',
      complete: false,
      scan: { examinedRecords: '4', examinedBytes: '32', cursorOrdinal: '3', direction: 'forward' as const, truncatedReason: 'record_limit' as const },
    };
    const controller = new DocumentController({ ...fakeSession(), getProblems: async () => problems }, {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    await controller.handleMessage(request('GET_PROBLEMS', { limit: 20, anchorOrdinal: '2', direction: 'forward' }));

    expect(messages[0]).toMatchObject({
      type: 'PROBLEMS',
      payload: { anchorOrdinal: '3', hasAfter: true },
    });
  });

  it('returns the selected profile columns instead of clearing them', async () => {
    const messages: ExtensionMessage[] = [];
    const columns: ColumnSpec[] = [{ id: 'actor', label: 'Actor', source: 'profile', width: 96 }];
    const controller = new DocumentController(fakeSession(columns), {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    await controller.handleMessage(request('SET_PROFILE', { profileId: 'claude-code-session' }));

    expect(messages[0]).toMatchObject({
      type: 'PROFILE_CHANGED',
      payload: { profileId: 'claude-code-session', columns },
    });
    expect(messages[1]).toMatchObject({
      type: 'INDEX_PROGRESS',
      requestId: '',
      payload: { profileId: 'claude-code-session' },
    });
  });

  it('drops a superseded profile summary after its PROFILE_CHANGED delivery resumes', async () => {
    let selected = summary();
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController({ ...fakeSession(), getSummary: () => selected,
      setProfile: async (profileId) => { selected = { ...selected, profileId }; return selected; },
    }, { postMessage: async (message) => {
      messages.push(message);
      if (message.type === 'PROFILE_CHANGED' && message.payload.profileId === 'first') await paused;
      return true;
    } });
    const first = controller.handleMessage(request('SET_PROFILE', { profileId: 'first' }, 'profile-first'));
    await Promise.resolve();
    await controller.handleMessage(request('SET_PROFILE', { profileId: 'second' }, 'profile-second'));
    release?.();
    await first;
    expect(messages.filter((message) => message.type === 'INDEX_PROGRESS')
      .map((message) => message.payload.profileId)).toEqual(['second']);
  });

  it('does not publish an aborted SET_PROFILE even when the returned profile identity still matches', async () => {
    let selected = summary();
    let release: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const messages: ExtensionMessage[] = [];
    let calls = 0;
    const controller = new DocumentController({ ...fakeSession(), getSummary: () => selected,
      setProfile: async (profileId) => {
        selected = { ...selected, profileId };
        const updated = selected;
        if (++calls === 1) await paused;
        return updated;
      },
    }, { postMessage: async (message) => { messages.push(message); return true; } });
    const first = controller.handleMessage(request('SET_PROFILE', { profileId: 'same' }, 'profile-first'));
    await controller.handleMessage(request('SET_PROFILE', { profileId: 'same' }, 'profile-second'));
    release?.();
    await first;
    expect(messages.filter((message) => message.type === 'PROFILE_CHANGED')
      .map((message) => message.requestId)).toEqual(['profile-second']);
    expect(messages.filter((message) => message.type === 'INDEX_PROGRESS')).toHaveLength(1);
  });

  it('drops a read response when a rebuild advances the generation while it is pending', async () => {
    let generation = 'generation';
    const initial = summary();
    const page: RowPage = {
      rows: [],
      columns: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
      totalRecords: '0',
    };
    let releaseRows: (value: RowPage) => void = () => undefined;
    const pendingRows = new Promise<RowPage>((resolve) => {
      releaseRows = resolve;
    });
    const session: JsonlSessionPort = {
      ...fakeSession(),
      getSummary: () => ({ ...initial, snapshot: { ...initial.snapshot, generation } }),
      getRows: async () => pendingRows,
    };
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(session, {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    const pendingRequest = controller.handleMessage(request('GET_ROWS', { limit: 100 }));
    await Promise.resolve();
    generation = 'next-generation';
    releaseRows(page);
    await pendingRequest;

    expect(messages).toEqual([]);
  });

  it.each(['success', 'failure', 'transient-failure'] as const)('drops late %s when the epoch advances within the same generation', async (outcome) => {
    const initial = summary();
    initial.snapshot.epoch = 1;
    const page: RowPage = {
      rows: [],
      columns: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
      totalRecords: '0',
    };
    let releaseRows: (value: RowPage) => void = () => undefined;
    let rejectRows: (error: Error) => void = () => undefined;
    const pendingRows = new Promise<RowPage>((resolve, reject) => {
      releaseRows = resolve;
      rejectRows = reject;
    });
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const session: JsonlSessionPort = {
      ...fakeSession(),
      getSummary: () => initial,
      getRows: async () => { markStarted(); return pendingRows; },
    };
    const messages: ExtensionMessage[] = [];
    const onTransientSourceChange = vi.fn(() => true);
    const controller = new DocumentController(session, {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    }, { onTransientSourceChange });
    const rowsRequest = request('GET_ROWS', { limit: 100 });
    rowsRequest.epoch = 1;

    const pendingRequest = controller.handleMessage(rowsRequest);
    await started;
    initial.snapshot.epoch = 2;
    if (outcome === 'success') releaseRows(page);
    else rejectRows(Object.assign(new Error('late failure'), { code: outcome === 'transient-failure' ? 'UNEXPECTED_EOF' : 'OTHER' }));
    await pendingRequest;

    expect(messages).toEqual([]);
    expect(onTransientSourceChange).not.toHaveBeenCalled();
  });

  it('does not publish an old-epoch transient error when recovery advances the epoch', async () => {
    const initial = summary();
    initial.snapshot.epoch = 1;
    const session = { ...fakeSession(), getSummary: () => initial, getRows: async () => {
      throw Object.assign(new Error('source settling'), { code: 'UNEXPECTED_EOF' });
    } };
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(session, { postMessage: async (message) => { messages.push(message); return true; } }, {
      onTransientSourceChange: () => { initial.snapshot.epoch = 2; return true; },
    });
    const rowsRequest = request('GET_ROWS', { limit: 100 });
    rowsRequest.epoch = 1;
    await controller.handleMessage(rowsRequest);
    expect(messages).toEqual([]);
  });

  it('honors a cancellation that arrives from the previous generation', async () => {
    let generation = 'generation';
    const initial = summary();
    const page: RowPage = {
      rows: [],
      columns: [],
      anchorOrdinal: '0',
      hasBefore: false,
      hasAfter: false,
      indexedRecords: '0',
      totalRecords: '0',
    };
    let observedSignal: AbortSignal | undefined;
    let releaseRows: (value: RowPage) => void = () => undefined;
    const pendingRows = new Promise<RowPage>((resolve) => {
      releaseRows = resolve;
    });
    const session: JsonlSessionPort = {
      ...fakeSession(),
      getSummary: () => ({ ...initial, snapshot: { ...initial.snapshot, generation } }),
      getRows: async (_request, signal) => {
        observedSignal = signal;
        return pendingRows;
      },
    };
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(session, {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    const pendingRequest = controller.handleMessage(request('GET_ROWS', { limit: 100 }));
    await Promise.resolve();
    expect(observedSignal).toBeDefined();

    generation = 'next-generation';
    const cancel = request('CANCEL', { targetRequestId: 'request-GET_ROWS' });
    cancel.generation = 'generation';
    await controller.handleMessage(cancel);
    expect(observedSignal?.aborted).toBe(true);

    releaseRows(page);
    await pendingRequest;
    expect(messages).toEqual([]);
  });

  it('publishes only the latest result when rebuild calls overlap', async () => {
    let generation = 'generation';
    const initial = summary();
    const firstSummary = {
      ...initial,
      snapshot: { ...initial.snapshot, generation: 'first-generation' },
    };
    const secondSummary = {
      ...initial,
      snapshot: { ...initial.snapshot, generation: 'second-generation' },
    };
    let releaseFirst: (value: DocumentSummary) => void = () => undefined;
    let releaseSecond: (value: DocumentSummary) => void = () => undefined;
    let firstStarted: () => void = () => undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstResult = new Promise<DocumentSummary>((resolve) => {
      releaseFirst = resolve;
    });
    const secondResult = new Promise<DocumentSummary>((resolve) => {
      releaseSecond = resolve;
    });
    let rebuildCalls = 0;
    const session: JsonlSessionPort = {
      ...fakeSession(),
      getSummary: () => ({ ...initial, snapshot: { ...initial.snapshot, generation } }),
      rebuild: async () => {
        rebuildCalls += 1;
        if (rebuildCalls === 1) {
          firstStarted();
          return firstResult;
        }
        return secondResult;
      },
    };
    const messages: ExtensionMessage[] = [];
    const controller = new DocumentController(session, {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    });

    const firstRequest = controller.handleMessage(request('REBUILD_INDEX', {}, 'rebuild-first'));
    await firstStartedPromise;
    const secondRequest = controller.handleMessage(request('REBUILD_INDEX', {}, 'rebuild-second'));

    generation = 'first-generation';
    releaseFirst(firstSummary);
    await firstRequest;
    expect(messages).toEqual([]);

    generation = 'second-generation';
    releaseSecond(secondSummary);
    await secondRequest;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'OPENED',
      requestId: 'rebuild-second',
      generation: 'second-generation',
      payload: { snapshot: { generation: 'second-generation' } },
    });
  });
});
