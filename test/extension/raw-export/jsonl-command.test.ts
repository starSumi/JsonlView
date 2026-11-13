import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNKNOWN_RUNTIME_IDENTITY } from '../../../src/shared/execution-identity';

const host = vi.hoisted(() => ({
  choose: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn(), exportSource: vi.fn(),
  cancelled: false,
}));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => fsPath }) },
  ProgressLocation: { Notification: 15 },
  window: {
    showSaveDialog: host.choose, showInformationMessage: host.info,
    showErrorMessage: host.error, showWarningMessage: host.warning,
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) => task({}, {
      isCancellationRequested: host.cancelled,
      onCancellationRequested: () => ({ dispose() {} }),
    }),
  },
}));
vi.mock('../../../src/extension/raw-export/open-jsonl', () => ({ exportOpenRawJsonl: host.exportSource }));
import { JsonlViewProvider } from '../../../src/extension/extension';

function fixture() {
  const provider = new JsonlViewProvider({} as never, {} as never, () => undefined, undefined, UNKNOWN_RUNTIME_IDENTITY);
  const document = { hasPanels: true, uri: { scheme: 'file', fsPath: 'source.jsonl', toString: () => 'source.jsonl' } };
  const state = provider as unknown as {
    resolvedDocuments: Set<unknown>; lastResolvedDocument: unknown;
  };
  state.resolvedDocuments.add(document);
  state.lastResolvedDocument = document;
  return { provider, document };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.cancelled = false;
  host.choose.mockResolvedValue({ scheme: 'file', fsPath: 'export.jsonl' });
  host.exportSource.mockResolvedValue({ status: 'committed', receipt: {} });
});

describe('native raw export command', () => {
  it('does not read or write a source when the save dialog is cancelled', async () => {
    host.choose.mockResolvedValue(undefined);
    await fixture().provider.exportRawSource();
    expect(host.exportSource).not.toHaveBeenCalled();
    expect(host.choose.mock.calls[0]?.[0].title).toContain('all physical rows');
  });

  it('shares a single save dialog and export for concurrent requests on one document', async () => {
    const { provider } = fixture();
    const first = provider.exportRawSource();
    const second = provider.exportRawSource();
    expect(first).toBe(second);
    await first;
    expect(host.choose).toHaveBeenCalledTimes(1);
    expect(host.exportSource).toHaveBeenCalledTimes(1);
  });

  it('propagates an already-cancelled VS Code progress token to bounded source IO', async () => {
    host.cancelled = true;
    await fixture().provider.exportRawSource();
    expect(host.exportSource.mock.calls[0]?.[2].aborted).toBe(true);
  });

  it('requires an open source and never accepts a URI that is not a resolved document', async () => {
    const { provider, document } = fixture();
    document.hasPanels = false;
    await provider.exportRawSource();
    await provider.exportRawSource({ toString: () => 'another.jsonl' } as never);
    expect(host.choose).not.toHaveBeenCalled();
    expect(host.exportSource).not.toHaveBeenCalled();
  });

  it('reports uncertain publication without claiming cancellation or deleting a target', async () => {
    host.exportSource.mockResolvedValue({ status: 'commit-unknown' });
    const result = await fixture().provider.exportRawSource();
    expect(result?.status).toBe('commit-unknown');
    expect(host.warning).toHaveBeenCalledTimes(1);
    expect(host.info).not.toHaveBeenCalled();
  });
});
