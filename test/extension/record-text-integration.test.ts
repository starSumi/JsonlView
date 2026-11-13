import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  provider: undefined as { provideTextDocumentContent(uri: unknown, token: unknown): Promise<string> } | undefined,
  documents: [] as Array<{ text: string; uri: unknown }>,
  show: vi.fn(),
  from: (parts: object) => ({ authority: '', fragment: '', ...parts }),
}));
vi.mock('vscode', () => ({
  Uri: { from: host.from, joinPath: () => ({ path: '/extension/dist' }) },
  workspace: {
    getConfiguration: () => ({ get: () => 100 }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    registerTextDocumentContentProvider: (_scheme: string, provider: typeof host.provider) => {
      host.provider = provider;
      return { dispose() { host.provider = undefined; } };
    },
    openTextDocument: async (uri: unknown) => {
      const text = await host.provider!.provideTextDocumentContent(uri, { isCancellationRequested: false });
      const document = { uri, text };
      host.documents.push(document);
      return document;
    },
  },
  window: { showTextDocument: host.show, showWarningMessage: vi.fn() },
}));
vi.mock('../../src/extension/webview-html', () => ({ getWebviewHtml: () => '<html>ready</html>' }));
import { JsonlViewProvider } from '../../src/extension/extension';
import { IntegratedJsonlSession } from '../../src/extension/integrated-session/integrated-session';

afterEach(() => { host.documents.length = 0; host.show.mockClear(); });
describe('native record-text production route', () => {
  it('routes the Webview ref through the current host source and engine into a read-only native document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-text-integration-'));
    const path = join(root, 'private-source.jsonl');
    const text = '  { "message": "synthetic 中文 record" }';
    await writeFile(path, `${text}\r\n`);
    const session = await IntegratedJsonlSession.open(path, { uri: pathToFileURL(path).href, autoDetectProfiles: false, backgroundIndexing: false });
    const registrations: vscode.Disposable[] = [];
    let receive: ((message: unknown) => void) | undefined;
    let disposePanel: (() => void) | undefined;
    let hasPanels = true;
    const document = {
      uri: { toString: () => pathToFileURL(path).href }, session,
      get hasPanels() { return hasPanels; },
      addPanel: () => ({ dispose() { hasPanels = false; } }),
    };
    const provider = new JsonlViewProvider({ extensionUri: {}, globalState: { get: () => 'asc' }, subscriptions: registrations } as never,
      { take: () => undefined } as never, () => undefined, undefined);
    try {
      provider.registerRecordTextDocuments();
      provider.resolveCustomEditor(document as never, {
        webview: { options: {}, html: '', postMessage: async () => true,
          onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return { dispose() { receive = undefined; } }; } },
        onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose: (listener: () => void) => { disposePanel = listener; return { dispose() {} }; },
      } as never);
      const ref = (await session.getRows({ limit: 1 }, new AbortController().signal)).rows[0]!.ref;
      const snapshot = session.getSummary().snapshot;
      receive!({ protocolVersion: 1, direction: 'webview-to-host', type: 'OPEN_RECORD_TEXT', requestId: 'record-text-action',
        documentId: snapshot.documentId, generation: snapshot.generation, epoch: snapshot.epoch, payload: { ref } });
      await vi.waitFor(() => expect(host.show).toHaveBeenCalledOnce());
      expect(host.documents).toHaveLength(1);
      expect(host.documents[0]?.text).toBe(text);
      expect(JSON.stringify(host.documents[0]?.uri)).not.toContain('private-source');
      expect(host.show).toHaveBeenCalledWith(host.documents[0], { preview: true });
    } finally {
      disposePanel?.();
      for (const registration of registrations) registration.dispose();
      await session.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
