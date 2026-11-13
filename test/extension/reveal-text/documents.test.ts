import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  register: vi.fn(), close: vi.fn(() => ({ dispose() {} })), open: vi.fn(), show: vi.fn(), warning: vi.fn(),
  from: (parts: object) => ({ authority: '', fragment: '', ...parts }),
}));
vi.mock('vscode', () => ({ Uri: { from: host.from }, workspace: {
  registerTextDocumentContentProvider: host.register, onDidCloseTextDocument: host.close, openTextDocument: host.open,
}, window: { showTextDocument: host.show, showWarningMessage: host.warning } }));
import { RevealTextDocuments } from '../../../src/extension/reveal-text/documents';
import { REVEAL_TEXT_SCHEME } from '../../../src/extension/reveal-text/provider';

const input = { sourceId: 'doc', generation: 'g', ordinal: '1' };
beforeEach(() => {
  vi.clearAllMocks();
  host.register.mockReturnValue({ dispose() {} });
  host.open.mockResolvedValue({ uri: {} });
  host.show.mockResolvedValue(undefined);
});
describe('registered read-only record documents', () => {
  it('registers the native provider and opens only an opaque URI with one explicit action', async () => {
    const service = new RevealTextDocuments({ authorize: async () => ({ authorized: true, generation: 'g' }),
      read: async () => ({ sourceGeneration: 'g', text: 'record', complete: true }) });
    expect(host.register).toHaveBeenCalledWith(REVEAL_TEXT_SCHEME, expect.any(Object));
    await expect(service.open(input, () => true)).resolves.toBe(true);
    expect(host.open).toHaveBeenCalledWith(expect.objectContaining({ scheme: REVEAL_TEXT_SCHEME }));
    expect(host.open.mock.calls[0]?.[0]).not.toHaveProperty('sourceId');
    expect(host.show).toHaveBeenCalledWith(expect.any(Object), { preview: true });
    service.dispose();
  });
  it('suppresses a late open after document retirement and releases failed references', async () => {
    const service = new RevealTextDocuments({ authorize: async () => ({ authorized: true, generation: 'g' }),
      read: async () => ({ sourceGeneration: 'g', text: 'record', complete: true }) });
    let current = true;
    host.open.mockImplementationOnce(async () => { current = false; return {}; });
    await expect(service.open(input, () => current)).resolves.toBe(false);
    expect(host.show).not.toHaveBeenCalled();
    const registered = host.register.mock.calls[0]?.[1] as { referenceCount: number };
    expect(registered.referenceCount).toBe(0);
    host.open.mockRejectedValueOnce(new Error('private path secret'));
    await expect(service.open(input, () => true)).resolves.toBe(false);
    expect(registered.referenceCount).toBe(0);
    expect(JSON.stringify(host.warning.mock.calls)).not.toContain('private path secret');
    service.dispose();
  });
  it('rejects overlapping open actions and disposes both registrations', async () => {
    const unregistered = vi.fn();
    host.register.mockReturnValueOnce({ dispose: unregistered });
    const service = new RevealTextDocuments({ authorize: async () => ({ authorized: true, generation: 'g' }),
      read: async () => ({ sourceGeneration: 'g', text: 'record', complete: true }) });
    let complete!: (document: vscode.TextDocument) => void;
    host.open.mockImplementationOnce(() => new Promise<vscode.TextDocument>((resolve) => { complete = resolve; }));
    const first = service.open(input, () => true);
    await expect(service.open(input, () => true)).resolves.toBe(false);
    service.dispose();
    complete({} as vscode.TextDocument);
    await expect(first).resolves.toBe(false);
    expect(unregistered).toHaveBeenCalledOnce();
    expect(host.show).not.toHaveBeenCalled();
  });
});
