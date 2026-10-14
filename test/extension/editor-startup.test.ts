import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/shared/types';

vi.mock('vscode', () => ({
  Uri: { joinPath: () => ({ path: '/extension/dist' }) },
  workspace: { getConfiguration: () => ({ get: () => 100 }) },
}));
vi.mock('../../src/extension/webview-html', () => ({ getWebviewHtml: () => '<html>ready</html>' }));

import { JsonlViewProvider } from '../../src/extension/extension';

describe('editor startup', () => {
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

      receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
        startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 1, rows: 0 });
      receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
        startupId: 'old', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2, rows: 0 });
      expect(output.some((line) => line.includes('[startup-recovered]'))).toBe(false);
      receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
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
    receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
      startupId: '1', documentId: snapshot.documentId, generation: 'stale-generation', epoch: 2, rows: 10 });
    receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
      startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 1, rows: 10 });
    expect(output.some((line) => line.includes('[startup-outcome]'))).toBe(false);
    receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted',
      startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2 });
    if (scenario === 'recovery') {
      receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'startup-error',
        startupId: '1', documentId: snapshot.documentId, generation: snapshot.generation, epoch: 2 });
      expect(output.some((line) => line.includes('[startup-outcome] trace=1 status=startup-error'))).toBe(true);
    }
    receive?.({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed',
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
