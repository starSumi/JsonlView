import { describe, expect, it } from 'vitest';
import { DocumentController, type JsonlSessionPort, type MessageChannel } from '../../src/extension/document-controller';
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
    profileSuggestions: [],
    indexedBytes: '0',
    indexedRecords: '0',
    indexingComplete: true,
    validRecords: '0',
    problemRecords: '0',
  };
}

function fakeSession(profileColumns: readonly ColumnSpec[] = []): JsonlSessionPort {
  const value = summary();
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
    getInsights: async (dimension) => ({
      dimension,
      categories: [],
      timeBuckets: [],
      processedRecords: '0',
      examinedRecords: '0',
      examinedBytes: '0',
      truncated: false,
      capacityReached: false,
      bucketWidthMs: 300_000,
    }),
    setProfile: async (profileId) => ({ ...value, profileId }),
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

describe('document controller', () => {
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

    await controller.handleMessage(request('GET_INSIGHTS', { dimension: 'eventKind' }));

    expect(messages[0]).toMatchObject({
      type: 'INSIGHTS',
      payload: { dimension: 'eventKind', processedRecords: '0', examinedRecords: '0' },
    });
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
