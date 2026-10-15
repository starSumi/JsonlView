import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { EXECUTION_IDENTITY, UNKNOWN_RUNTIME_IDENTITY } from '../../src/shared/execution-identity';
import { startStartupHandshake } from '../../src/webview/startup-handshake';

const executionReceipt = { executionIdentity: EXECUTION_IDENTITY, runtimeIdentity: UNKNOWN_RUNTIME_IDENTITY };

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ path: '/extension/dist' }) },
  workspace: { getConfiguration: () => ({ get: () => 100 }) },
}));
vi.mock('../../src/extension/webview-html', () => ({ getWebviewHtml: () => '<html>ready</html>' }));

import { JsonlViewDocument, JsonlViewProvider } from '../../src/extension/extension';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function startupFixture() {
  const output: string[] = [];
  const snapshot = {
    documentId: 'test-document', generation: 'test-generation', epoch: 2,
    uri: 'file:///fixture.jsonl', scheme: 'file', sizeBytes: '0', mtimeMs: 0,
    prefixFingerprint: 'empty', observedAt: '2026-01-01T00:00:00Z',
  };
  const summary = {
    snapshot, profileId: 'generic', profileSuggestions: [], indexedBytes: '0',
    indexedRecords: '0', indexingComplete: true, validRecords: '0', problemRecords: '0',
  };
  let receive: ((value: unknown) => void) | undefined;
  let disposePanel: (() => void) | undefined;
  const document = {
    uri: { path: '/fixture.jsonl', toString: () => snapshot.uri },
    session: { getSummary: () => summary },
    addPanel: () => ({ dispose() {} }),
    get hasPanels() { return false; },
    flushPendingReveal: vi.fn(),
  };
  const postMessage = vi.fn(async (_message: { type: string }) => true);
  const panel = {
    webview: {
      options: {},
      onDidReceiveMessage: (listener: (value: unknown) => void) => {
        receive = listener;
        return { dispose() { receive = undefined; } };
      },
      postMessage,
      set html(_value: string) {},
    },
    onDidChangeViewState: () => ({ dispose() {} }),
    onDidDispose: (listener: () => void) => { disposePanel = listener; return { dispose() {} }; },
  };
  const provider = new JsonlViewProvider(
    { extensionUri: {}, globalState: { get: () => 'asc' } } as never,
    { take: () => undefined } as never,
    async () => undefined,
    { appendLine: (line: string) => { output.push(line); } },
  );
  return { document, panel, provider, output, snapshot, postMessage,
    receive: (value: unknown) => receive?.(value), dispose: () => disposePanel?.() };
}

function cancellationFixture(initiallyCancelled = false) {
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: initiallyCancelled,
    onCancellationRequested: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
  return { token, listeners, cancel: () => {
    token.isCancellationRequested = true;
    for (const listener of [...listeners]) listener();
  } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('document creation watchdog', () => {
  it.each(['complete', 'failed'] as const)('observes a hung create once and preserves its late %s result', async (outcome) => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    const cancellation = cancellationFixture();
    const creation = deferred<JsonlViewDocument>();
    const create = vi.spyOn(JsonlViewDocument, 'create').mockReturnValue(creation.promise);
    const opening = fixture.provider.openCustomDocument(fixture.document.uri as never, {} as never, cancellation.token as never);
    const result = opening.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fixture.output.some((line) => line.includes('stage=stalled'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.output.filter((line) => line.includes('stage=stalled phase=create lastStage=create-begin'))).toHaveLength(1);
    expect(fixture.output.find((line) => line.includes('stage=stalled'))).toContain('elapsedMs=10000');
    expect(fixture.output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.output.filter((line) => line.includes('stage=stalled'))).toHaveLength(1);
    expect(create).toHaveBeenCalledOnce();
    const error = new Error('private source path must not be logged');
    if (outcome === 'complete') creation.resolve(fixture.document as never);
    else creation.reject(error);
    expect(await result).toEqual(outcome === 'complete' ? { value: fixture.document } : { error });
    expect(fixture.output.some((line) => line.includes('stage=' + outcome) && line.includes('afterStall=true'))).toBe(true);
    expect(fixture.output.join(' ')).not.toContain(error.message);
    expect(fixture.output.join(' ')).not.toContain('/fixture.jsonl');
    expect(cancellation.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'complete') {
      fixture.provider.resolveCustomEditor(fixture.document as never, fixture.panel as never);
      expect(fixture.output.some((line) => line.includes('[resolve-editor] trace=1 startup=1 stage=begin'))).toBe(true);
      fixture.dispose();
    }
  });

  it.each(['complete', 'failed'] as const)('cleans up a prompt creation %s', async (outcome) => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    const cancellation = cancellationFixture();
    const error = new Error('original failure');
    const create = vi.spyOn(JsonlViewDocument, 'create');
    if (outcome === 'complete') create.mockResolvedValue(fixture.document as never);
    else create.mockRejectedValue(error);
    const opening = fixture.provider.openCustomDocument(fixture.document.uri as never, {} as never, cancellation.token as never);
    if (outcome === 'complete') expect(await opening).toBe(fixture.document);
    else await expect(opening).rejects.toBe(error);
    expect(cancellation.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    cancellation.cancel();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.output.some((line) => line.includes('stage=stalled') || line.includes('stage=cancelled'))).toBe(false);
  });

  it.each(['before-open', 'pending', 'after-stall'] as const)('retires observation when cancellation occurs %s', async (when) => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    const cancellation = cancellationFixture(when === 'before-open');
    const creation = deferred<JsonlViewDocument>();
    vi.spyOn(JsonlViewDocument, 'create').mockReturnValue(creation.promise);
    const opening = fixture.provider.openCustomDocument(fixture.document.uri as never, {} as never, cancellation.token as never);
    if (when === 'after-stall') await vi.advanceTimersByTimeAsync(10_000);
    cancellation.cancel();
    cancellation.cancel();
    expect(cancellation.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.output.filter((line) => line.includes('stage=cancelled phase=create'))).toHaveLength(1);
    expect(fixture.output.filter((line) => line.includes('stage=stalled'))).toHaveLength(when === 'after-stall' ? 1 : 0);
    creation.resolve(fixture.document as never);
    expect(await opening).toBe(fixture.document);
    expect(fixture.output.some((line) => line.includes('stage=complete') && line.includes('cancelled=true'))).toBe(true);
    expect(fixture.output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
  });

  it('keeps concurrent opening observations independent', async () => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    const firstCancellation = cancellationFixture();
    const secondCancellation = cancellationFixture();
    const first = deferred<JsonlViewDocument>();
    const second = deferred<JsonlViewDocument>();
    vi.spyOn(JsonlViewDocument, 'create').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstOpening = fixture.provider.openCustomDocument(fixture.document.uri as never, {} as never, firstCancellation.token as never);
    const secondOpening = fixture.provider.openCustomDocument(fixture.document.uri as never, {} as never, secondCancellation.token as never);
    firstCancellation.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.output.some((line) => line.includes('trace=1 stage=stalled'))).toBe(false);
    expect(fixture.output.filter((line) => line.includes('trace=2 stage=stalled'))).toHaveLength(1);
    first.resolve(fixture.document as never);
    second.resolve({ ...fixture.document } as never);
    await Promise.all([firstOpening, secondOpening]);
    expect(firstCancellation.listeners.size + secondCancellation.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the original rejection after cancellation of a stalled creation', async () => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    const cancellation = cancellationFixture();
    const creation = deferred<JsonlViewDocument>();
    vi.spyOn(JsonlViewDocument, 'create').mockReturnValue(creation.promise);
    const opening = fixture.provider.openCustomDocument(fixture.document.uri as never, {} as never, cancellation.token as never);
    const rejection = expect(opening).rejects;
    await vi.advanceTimersByTimeAsync(10_000);
    cancellation.cancel();
    const error = new Error('original cancellation failure');
    creation.reject(error);
    await rejection.toBe(error);
    expect(fixture.output.some((line) => line.includes('stage=failed reason=Error cancelled=true') && line.includes('afterStall=true'))).toBe(true);
    expect(cancellation.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('editor startup', () => {
  it('recovers a dropped READY and rejected OPENED through the bounded handshake', async () => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    let opened = false;
    fixture.postMessage.mockResolvedValueOnce(false).mockImplementation(async () => { opened = true; return true; });
    fixture.provider.resolveCustomEditor(fixture.document as never, fixture.panel as never);
    let attempts = 0;
    const timeout = vi.fn();
    const stop = startStartupHandshake(() => {
      attempts += 1;
      if (attempts === 1) return;
      fixture.receive({ protocolVersion: PROTOCOL_VERSION, type: 'READY', documentId: fixture.snapshot.documentId,
        generation: fixture.snapshot.generation, epoch: fixture.snapshot.epoch, requestId: 'ready-' + attempts, payload: {} });
    }, () => opened, timeout);
    expect(fixture.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fixture.output.some((line) => line.includes('type=OPENED delivered=false'))).toBe(true);
    expect(fixture.document.flushPendingReveal).not.toHaveBeenCalled();
    expect(fixture.output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fixture.postMessage).toHaveBeenCalledTimes(2);
    expect(fixture.document.flushPendingReveal).toHaveBeenCalledOnce();
    expect(fixture.output.some((line) => line.includes('type=OPENED delivered=true'))).toBe(true);
    // Host acceptance remains separate from a Webview commit receipt.
    expect(fixture.output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
    fixture.receive({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed', startupId: '1',
      documentId: fixture.snapshot.documentId, generation: fixture.snapshot.generation, epoch: fixture.snapshot.epoch, rows: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(attempts).toBe(3);
    expect(timeout).not.toHaveBeenCalled();
    expect(fixture.output.filter((line) => line.includes('[startup-outcome]'))).toHaveLength(1);
    expect(fixture.output.some((line) => line.includes('status=page-committed'))).toBe(true);
    stop();
    fixture.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores every retired receipt identity before accepting a late current page', async () => {
    vi.useFakeTimers();
    const fixture = startupFixture();
    fixture.provider.resolveCustomEditor(fixture.document as never, fixture.panel as never);
    const current = { ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed', startupId: '1',
      documentId: fixture.snapshot.documentId, generation: fixture.snapshot.generation, epoch: fixture.snapshot.epoch, rows: 0 };
    const stale = [
      { documentId: 'retired-document' },
      { generation: 'retired-generation' },
      { epoch: fixture.snapshot.epoch - 1 },
      { startupId: 'retired-startup' },
      { executionIdentity: { ...EXECUTION_IDENTITY, manifestSha256: 'f'.repeat(64) } },
      { runtimeIdentity: { ...UNKNOWN_RUNTIME_IDENTITY, extensionMode: 'development' } },
    ];
    for (const identity of stale) fixture.receive({ ...current, ...identity });
    expect(fixture.output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    for (const identity of stale) fixture.receive({ ...current, ...identity });
    expect(fixture.output.some((line) => line.includes('[startup-recovered]'))).toBe(false);
    fixture.receive(current);
    expect(fixture.output.filter((line) => line.includes('[startup-outcome]'))).toHaveLength(1);
    expect(fixture.output.filter((line) => line.includes('[startup-recovered] trace=1 after=stalled rows=0'))).toHaveLength(1);
    fixture.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records a terminal stalled outcome and a valid late page receipt', async () => {
    vi.useFakeTimers();
    try {
      const output: string[] = [];
      const snapshot = {
        documentId: 'test-document', generation: 'test-generation', epoch: 2,
        uri: 'file:///fixture.jsonl', scheme: 'file', sizeBytes: '0', mtimeMs: 0,
        prefixFingerprint: 'empty', observedAt: '2026-01-01T00:00:00Z',
      };
      const summary = {
        snapshot, profileId: 'generic', profileSuggestions: [], indexedBytes: '0',
        indexedRecords: '0', indexingComplete: true, validRecords: '0', problemRecords: '0',
      };
      let receive: ((value: unknown) => void) | undefined;
      let disposePanel: (() => void) | undefined;
      const document = {
        uri: { path: '/fixture.jsonl', toString: () => snapshot.uri },
        session: { getSummary: () => summary },
        addPanel: () => ({ dispose() {} }),
        get hasPanels() { return false; },
      };
      const webview = {
        options: {},
        onDidReceiveMessage: (listener: (value: unknown) => void) => {
          receive = listener;
          return { dispose() { receive = undefined; } };
        },
        postMessage: async () => true,
        set html(_value: string) {},
      };
      const panel = {
        webview,
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: (listener: () => void) => { disposePanel = listener; return { dispose() {} }; },
      };
      const provider = new JsonlViewProvider(
        { extensionUri: {}, globalState: { get: () => 'asc' } } as never,
        { take: () => undefined } as never,
        async () => undefined,
        { appendLine: (line: string) => { output.push(line); } },
      );

      provider.resolveCustomEditor(document as never, panel as never);
      expect(output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(output.some((line) => line.includes('[startup-outcome] trace=1 status=stalled lastStage=html-assigned'))).toBe(true);

      receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
        startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 1, rows: 0 });
      receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
        startupId: 'old', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2, rows: 0 });
      expect(output.some((line) => line.includes('[startup-recovered]'))).toBe(false);
      receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
        startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2, rows: 0 });
      expect(output.some((line) => line.includes('[startup-recovered] trace=1 after=stalled rows=0'))).toBe(true);
      disposePanel?.();
      expect(output.some((line) => line.includes('[startup-outcome] trace=1 status=disposed'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['normal', 'recovery'] as const)('receives READY during HTML assignment and records %s startup', async (scenario) => {
    const events: string[] = [];
    const messages: Array<{ type: string }> = [];
    const output: string[] = [];
    const snapshot = {
      documentId: 'test-document',
      generation: 'test-generation',
      epoch: 2,
      uri: 'file:///fixture.jsonl',
      scheme: 'file',
      sizeBytes: '0',
      mtimeMs: 0,
      prefixFingerprint: 'empty',
      observedAt: '2026-01-01T00:00:00Z',
    };
    const summary = {
      snapshot,
      profileId: 'generic',
      profileSuggestions: [],
      indexedBytes: '0',
      indexedRecords: '0',
      indexingComplete: true,
      validRecords: '0',
      problemRecords: '0',
    };
    let receive: ((value: unknown) => void) | undefined;
    let disposePanel: (() => void) | undefined;
    let panels = 0;
    const document = {
      uri: { path: '/fixture.jsonl', toString: () => snapshot.uri },
      session: { getSummary: () => summary },
      addPanel: () => { panels += 1; return { dispose: () => { panels -= 1; } }; },
      get hasPanels() { return panels > 0; },
      flushPendingReveal: vi.fn(),
    };
    const webview = {
      options: {},
      onDidReceiveMessage: (listener: (value: unknown) => void) => {
        events.push('receiver-installed');
        receive = listener;
        return { dispose() { receive = undefined; } };
      },
      postMessage: async (message: { type: string }) => { messages.push(message); return true; },
      set html(_value: string) {
        events.push('html-assigned');
        receive?.({
          protocolVersion: PROTOCOL_VERSION,
          type: 'READY',
          documentId: snapshot.documentId,
          generation: snapshot.generation,
          requestId: 'ready-1',
          payload: {},
        });
      },
    };
    const panel = {
      webview,
      onDidChangeViewState: () => ({ dispose() {} }),
      onDidDispose: (listener: () => void) => { disposePanel = listener; return { dispose() {} }; },
    };
    const context = { extensionUri: {}, globalState: { get: () => 'asc' } };
    const provider = new JsonlViewProvider(
      context as never,
      { take: () => undefined } as never,
      async () => undefined,
      { appendLine: (line: string) => { output.push(line); } },
    );

    provider.resolveCustomEditor(document as never, panel as never);
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'OPENED')).toBe(true));
    await vi.waitFor(() => expect(output.some((line) => line.includes('type=OPENED delivered=true'))).toBe(true));

    expect(events).toEqual(['receiver-installed', 'html-assigned']);
    expect(output.some((line) => line.includes('[webview-ready] trace=1 received=true'))).toBe(true);
    expect(output.some((line) => line.includes('[webview-delivery] trace=1 type=OPENED delivered=true'))).toBe(true);
    receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
      startupId: '1', documentId: snapshot.documentId, generation: 'stale-generation', epoch: 2, rows: 10 });
    receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
      startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 1, rows: 10 });
    expect(output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
    receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted',
      startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2 });
    if (scenario === 'recovery') {
      receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'startup-error',
        startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2 });
      expect(output.some((line) => line.includes('[startup-outcome] trace=1 status=startup-error'))).toBe(true);
    }
    receive?.({ ...executionReceipt, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
      startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2, rows: 0 });
    expect(output.some((line) => line.includes('[webview-receipt] trace=1 stage=opened-accepted'))).toBe(true);
    if (scenario === 'recovery') {
      expect(output.some((line) => line.includes('[startup-recovered] trace=1 after=startup-error rows=0'))).toBe(true);
    } else {
      expect(output.some((line) => line.includes('[startup-outcome] trace=1 status=page-committed'))).toBe(true);
    }
    disposePanel?.();
    expect(output.some((line) => line.includes('[startup-outcome] trace=1 status=disposed'))).toBe(false);
    expect(receive).toBeUndefined();
    expect(panels).toBe(0);
  });
});
