import { describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, ExtensionMessage } from '../../src/shared/types';
import type { FollowRecoveryIdentity } from '../../src/extension/follow/recovery';

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ fsPath: path }) },
  RelativePattern: class {},
  workspace: { createFileSystemWatcher: () => ({
    dispose() {}, onDidChange: () => ({ dispose() {} }),
    onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }),
  }) },
}));

import { JsonlViewDocument } from '../../src/extension/extension';

interface PublicationMethods {
  handleProgress(summary: DocumentSummary): Promise<void>;
  publishRecovered(summary: DocumentSummary): Promise<{ published: boolean; delivered: boolean }>;
  isExpectedIdentityCurrent(expected: FollowRecoveryIdentity): boolean;
  reconcileSource(): Promise<void>;
}

function summary(epoch: number): DocumentSummary {
  return { snapshot: { documentId: 'fixture', generation: 'generation', epoch,
    uri: 'file:///synthetic.jsonl', scheme: 'file', sizeBytes: '1', mtimeMs: 0,
    prefixFingerprint: 'synthetic', observedAt: '2026-01-01T00:00:00Z', device: '1', inode: '1' },
    profileId: 'generic', profileSuggestions: [], indexedBytes: '1', indexedRecords: '1',
    indexingComplete: true, validRecords: '1', problemRecords: '0' };
}

function fixture() {
  let current = summary(1);
  const messages: ExtensionMessage[] = [];
  let beforePost: (() => void) | undefined;
  const session = { getSummary: () => current, followMode: true,
    onFollowMode: () => () => undefined, onProgress: () => () => undefined,
    getProfileColumns: () => [], dispose: async () => undefined,
    classifyRefresh: vi.fn(async () => ({ kind: 'append' as const })), rebuild: vi.fn(async () => current),
  };
  // Use the actual class and its actual methods; only the VS Code boundary and
  // session port are synthetic. No source-text extraction or copied algorithm.
  const Constructor = JsonlViewDocument as unknown as { new(uri: unknown, session: unknown): JsonlViewDocument };
  const document = new Constructor({ fsPath: '/synthetic.jsonl' }, session);
  document.addPanel({ webview: { postMessage: async (message: ExtensionMessage) => {
    messages.push(message); beforePost?.(); return true;
  } } } as never);
  return { document, methods: document as unknown as PublicationMethods, session, messages,
    setCurrent: (value: DocumentSummary) => { current = value; },
    onPost: (callback: () => void) => { beforePost = callback; } };
}

describe('document publication correlation', () => {
  it('drops old-epoch progress instead of relabeling its payload with current epoch', async () => {
    const value = fixture();
    try {
      value.setCurrent(summary(2));
      await value.methods.handleProgress(summary(1));
      expect(value.messages).toEqual([]);
    } finally { value.document.dispose(); }
  });

  it('rechecks after profile delivery when the same generation advances epoch', async () => {
    const value = fixture();
    try {
      value.onPost(() => { value.setCurrent(summary(2)); });
      await value.methods.handleProgress({ ...summary(1), profileId: 'codex' });
      expect(value.messages.map((message) => [message.type, message.epoch])).toEqual([['PROFILE_CHANGED', 1]]);
    } finally { value.document.dispose(); }
  });

  it.each(['documentId', 'generation', 'epoch'] as const)('rejects recovered summary with stale %s', async (field) => {
    const value = fixture();
    try {
      const current = summary(1);
      current.snapshot = { ...current.snapshot, [field]: field === 'epoch' ? 2 : 'new' };
      value.setCurrent(current);
      await expect(value.methods.publishRecovered(summary(1))).resolves.toEqual({ published: false, delivered: false });
      expect(value.messages).toEqual([]);
    } finally { value.document.dispose(); }
  });

  it('publishes a matching recovered payload with exactly its own tuple', async () => {
    const value = fixture();
    try {
      await expect(value.methods.publishRecovered(summary(1))).resolves.toEqual({ published: true, delivered: true });
      const opened = value.messages[0]!;
      expect(opened).toMatchObject({ type: 'OPENED', documentId: 'fixture', generation: 'generation', epoch: 1 });
      expect((opened.payload as DocumentSummary).snapshot.epoch).toBe(opened.epoch);
    } finally { value.document.dispose(); }
  });

  it('rejects pre-recovery expected epoch even if all file identity fields match', () => {
    const value = fixture();
    try {
      const expected = { ...summary(1).snapshot };
      value.setCurrent(summary(2));
      expect(value.methods.isExpectedIdentityCurrent(expected)).toBe(false);
    } finally { value.document.dispose(); }
  });

  it('does not apply a late source classification to a new epoch', async () => {
    const value = fixture();
    let release!: (value: { kind: 'append' }) => void;
    let started!: () => void;
    const accepted = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<{ kind: 'append' }>((resolve) => { release = resolve; });
    value.session.classifyRefresh.mockImplementation(() => { started(); return pending; });
    try {
      const operation = value.methods.reconcileSource();
      await accepted;
      value.setCurrent(summary(2));
      release({ kind: 'append' });
      await operation;
      expect(value.messages).toEqual([]);
      expect(value.session.rebuild).not.toHaveBeenCalled();
    } finally { value.document.dispose(); }
  });
});
