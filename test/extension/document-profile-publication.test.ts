import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, ExtensionMessage } from '../../src/shared/types';
import { PROTOCOL_VERSION } from '../../src/shared/types';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';
import { createInitialState, workspaceReducer, type WorkspaceState } from '../../src/webview/state';
import { DocumentController } from '../../src/extension/document-controller';
import { IntegratedJsonlSession } from '../../src/extension/integrated-session/integrated-session';

vi.mock('vscode', () => {
  const disposable = () => ({ dispose() {} });
  return {
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    RelativePattern: class {},
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      createFileSystemWatcher: () => ({ dispose() {},
        onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }),
    },
  };
});

import { JsonlViewProvider } from '../../src/extension/extension';

describe('document profile publication', () => {
  it('does not publish a captured background summary after an explicit profile wins during delivery', async () => {
    let selected: DocumentSummary = {
      snapshot: { documentId: 'document', generation: 'generation', epoch: 1,
        uri: 'file:///fixture.jsonl', scheme: 'file', sizeBytes: '10', mtimeMs: 0,
        prefixFingerprint: 'fixture', observedAt: '2026-01-01T00:00:00Z' },
      profileId: 'codex', profileVersion: '1', profileSuggestions: [],
      indexedBytes: '10', indexedRecords: '1', indexingComplete: true, validRecords: '1', problemRecords: '0',
    };
    let progress: ((summary: DocumentSummary) => void | Promise<void>) | undefined;
    const session = {
      getSummary: () => selected, getProfileColumns: () => [],
      onProgress: (listener: typeof progress) => { progress = listener; return () => {}; },
      onFollowMode: () => () => {}, dispose: async () => {},
      setProfile: async (profileId: string) => { selected = { ...selected, profileId }; return selected; },
    };
    const open = vi.spyOn(IntegratedJsonlSession, 'open').mockResolvedValue(session as never);
    const provider = new JsonlViewProvider({} as never, {} as never, async () => {}, undefined);
    const document = await provider.openCustomDocument({ scheme: 'file', fsPath: '/fixture.jsonl' } as never,
      {} as never, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never);
    try {
      let state: WorkspaceState = { ...createInitialState(), summary: selected };
      const client = new VsCodeMessageClient({ postMessage: () => {} },
        { documentId: 'document', generation: 'generation', epoch: 1 });
      const delivered: ExtensionMessage[] = [];
      let release: (() => void) | undefined;
      const paused = new Promise<void>((resolve) => { release = resolve; });
      const channel = { postMessage: async (message: ExtensionMessage) => {
        delivered.push(message);
        const accepted = client.accept(message);
        if (accepted !== undefined) state = workspaceReducer(state, { type: 'MESSAGE_RECEIVED', message: accepted });
        if (message.type === 'PROFILE_CHANGED' && message.payload.profileId === 'generic') await paused;
        return true;
      } };
      document.addPanel({ webview: channel } as never);
      const controller = new DocumentController(session as never, channel);
      selected = { ...selected, profileId: 'generic' };
      const background = progress?.(selected);
      await Promise.resolve();
      expect(state.summary?.profileId).toBe('generic');
      const pending = client.send('SET_PROFILE', { profileId: 'codex' });
      state = workspaceReducer(state, { type: 'REQUEST_SENT', request: pending });
      await controller.handleMessage({ protocolVersion: PROTOCOL_VERSION, type: 'SET_PROFILE',
        documentId: 'document', generation: 'generation', epoch: 1, requestId: pending.id,
        payload: { profileId: 'codex' } });
      release?.();
      await background;
      expect(selected.profileId).toBe('codex');
      expect(state.summary?.profileId).toBe('codex');
      expect(delivered.filter((message) => message.type === 'INDEX_PROGRESS')
        .map((message) => message.payload.profileId)).toEqual(['codex']);
    } finally {
      document.dispose();
      open.mockRestore();
    }
  });
});
