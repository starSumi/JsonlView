import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const closeListeners = new Set<(document: { uri: unknown }) => void>();
  return {
    closeListeners,
    fireClose(uri: unknown) {
      for (const listener of closeListeners) listener({ uri });
    },
    workspace: {
      onDidCloseTextDocument(listener: (document: { uri: unknown }) => void) {
        closeListeners.add(listener);
        return { dispose: () => { closeListeners.delete(listener); } };
      },
    },
    Uri: {
      from: (parts: { scheme: string; authority?: string; path: string; query?: string; fragment?: string }) => ({
        scheme: parts.scheme,
        authority: parts.authority ?? '',
        path: parts.path,
        query: parts.query ?? '',
        fragment: parts.fragment ?? '',
        toString: () => `${parts.scheme}:${parts.path}${parts.query === undefined || parts.query === '' ? '' : `?${parts.query}`}`,
      }),
    },
  };
});

vi.mock('vscode', () => vscodeMock);

import {
  REVEAL_TEXT_LIMITS,
  REVEAL_TEXT_SCHEME,
  RevealTextDocumentContentProvider,
  RevealTextRefusal,
  type RevealTextReadPort,
  type RevealTextReadResult,
  type RevealTextReferenceInput,
} from '../../../src/extension/reveal-text/provider';

const SOURCE: RevealTextReferenceInput = Object.freeze({
  sourceId: 'C:\\private\\agent-history.jsonl',
  generation: 'source-generation-1',
  ordinal: '17',
});
const TOKEN = Object.freeze({ isCancellationRequested: false }) as vscode.CancellationToken;

function asUri(parts: { scheme: string; authority?: string; path: string; query?: string; fragment?: string }): vscode.Uri {
  return vscodeMock.Uri.from(parts) as vscode.Uri;
}

function readPort(overrides: Partial<RevealTextReadPort> = {}): RevealTextReadPort {
  return {
    authorize: vi.fn(async () => ({ authorized: true, generation: SOURCE.generation })),
    read: vi.fn(async () => ({ sourceGeneration: SOURCE.generation, text: 'complete record', complete: true })),
    ...overrides,
  };
}

describe('RevealTextDocumentContentProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMock.closeListeners.clear();
  });

  it('keeps source details out of the URI and returns only complete verified text', async () => {
    const source = readPort();
    const provider = new RevealTextDocumentContentProvider(source);
    const uri = provider.register(SOURCE);

    expect(uri.scheme).toBe(REVEAL_TEXT_SCHEME);
    expect(uri.toString()).not.toContain('private');
    expect(uri.toString()).not.toContain(SOURCE.sourceId);
    expect(uri.toString()).not.toContain('complete record');
    await expect(provider.provideTextDocumentContent(uri, TOKEN)).resolves.toBe('complete record');
    expect(source.authorize).toHaveBeenCalledTimes(2);
    expect(source.read).toHaveBeenCalledWith(expect.objectContaining(SOURCE), REVEAL_TEXT_LIMITS.maxRecordBytes);
    expect(provider.outputBytes).toBe(Buffer.byteLength('complete record', 'utf8'));
  });

  it('rejects forged URIs and wrong generation tokens before reading', async () => {
    const source = readPort();
    const provider = new RevealTextDocumentContentProvider(source);
    const uri = provider.register(SOURCE);
    const wrongGeneration = asUri({ ...uri, query: 'g=00000000-0000-4000-8000-000000000000' });
    const forged = asUri({ ...uri, query: `${uri.query}&source=${encodeURIComponent(SOURCE.sourceId)}` });

    await expect(provider.provideTextDocumentContent(wrongGeneration, TOKEN)).rejects.toMatchObject({ code: 'reference-unavailable' });
    await expect(provider.provideTextDocumentContent(forged, TOKEN)).rejects.toMatchObject({ code: 'invalid-uri' });
    expect(source.authorize).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
  });

  it('refuses the next registration at the reference cap without evicting existing references', () => {
    const provider = new RevealTextDocumentContentProvider(readPort());
    const uris = Array.from({ length: REVEAL_TEXT_LIMITS.maxReferences }, (_, index) => provider.register({ ...SOURCE, ordinal: String(index) }));

    expect(uris).toHaveLength(REVEAL_TEXT_LIMITS.maxReferences);
    expect(provider.referenceCount).toBe(REVEAL_TEXT_LIMITS.maxReferences);
    let refusal: unknown;
    try {
      provider.register({ ...SOURCE, ordinal: String(REVEAL_TEXT_LIMITS.maxReferences) });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'reference-limit' });
    expect(provider.referenceCount).toBe(REVEAL_TEXT_LIMITS.maxReferences);
    expect(provider.release(uris[0]!)).toBe(true);
    expect(provider.register({ ...SOURCE, ordinal: String(REVEAL_TEXT_LIMITS.maxReferences) })).toBeDefined();
  });

  it('rechecks authorization after reading and refuses a revoked source', async () => {
    const source = readPort({
      authorize: vi.fn()
        .mockResolvedValueOnce({ authorized: true, generation: SOURCE.generation })
        .mockResolvedValueOnce({ authorized: false, generation: SOURCE.generation }),
    });
    const provider = new RevealTextDocumentContentProvider(source);
    const uri = provider.register(SOURCE);

    await expect(provider.provideTextDocumentContent(uri, TOKEN)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(source.authorize).toHaveBeenCalledTimes(2);
    expect(provider.outputBytes).toBe(0);
  });

  it('rejects a source generation change observed during the read', async () => {
    const source = readPort({
      read: vi.fn(async () => ({ sourceGeneration: 'source-generation-2', text: 'changed', complete: true })),
    });
    const provider = new RevealTextDocumentContentProvider(source);
    const uri = provider.register(SOURCE);

    await expect(provider.provideTextDocumentContent(uri, TOKEN)).rejects.toMatchObject({ code: 'source-changed' });
    expect(source.authorize).toHaveBeenCalledTimes(1);
    expect(provider.outputBytes).toBe(0);
  });

  it('refuses oversized and incomplete records without returning a truncated prefix', async () => {
    const oversized = readPort({
      read: vi.fn(async () => ({
        sourceGeneration: SOURCE.generation,
        text: 'x'.repeat(REVEAL_TEXT_LIMITS.maxRecordBytes + 1),
        complete: true,
      })),
    });
    const oversizedProvider = new RevealTextDocumentContentProvider(oversized);
    const oversizedUri = oversizedProvider.register(SOURCE);
    await expect(oversizedProvider.provideTextDocumentContent(oversizedUri, TOKEN)).rejects.toMatchObject({ code: 'record-limit' });
    expect(oversizedProvider.outputBytes).toBe(0);

    const incomplete = readPort({
      read: vi.fn(async () => ({ sourceGeneration: SOURCE.generation, text: 'prefix...', complete: false })),
    });
    const incompleteProvider = new RevealTextDocumentContentProvider(incomplete);
    const incompleteUri = incompleteProvider.register(SOURCE);
    await expect(incompleteProvider.provideTextDocumentContent(incompleteUri, TOKEN)).rejects.toMatchObject({ code: 'content-incomplete' });
    expect(incompleteProvider.outputBytes).toBe(0);
  });

  it('applies the cumulative output ceiling without evicting references', async () => {
    const source = readPort({
      read: vi.fn(async () => ({
        sourceGeneration: SOURCE.generation,
        text: 'x'.repeat(REVEAL_TEXT_LIMITS.maxRecordBytes),
        complete: true,
      })),
    });
    const provider = new RevealTextDocumentContentProvider(source);
    const uris = Array.from({ length: 5 }, (_, index) => provider.register({ ...SOURCE, ordinal: String(index) }));

    for (const uri of uris.slice(0, 4)) await expect(provider.provideTextDocumentContent(uri, TOKEN)).resolves.toHaveLength(REVEAL_TEXT_LIMITS.maxRecordBytes);
    await expect(provider.provideTextDocumentContent(uris[4]!, TOKEN)).rejects.toMatchObject({ code: 'output-limit' });
    expect(provider.outputBytes).toBe(REVEAL_TEXT_LIMITS.maxTotalOutputBytes);
    expect(provider.referenceCount).toBe(5);
  });

  it('releases a reference and refuses an in-flight read when the document closes', async () => {
    let finishRead!: (value: { sourceGeneration: string; text: string; complete: boolean }) => void;
    const source = readPort({ read: vi.fn(() => new Promise<RevealTextReadResult>((resolve) => { finishRead = resolve; })) });
    const provider = new RevealTextDocumentContentProvider(source);
    const uri = provider.register(SOURCE);
    const pending = provider.provideTextDocumentContent(uri, TOKEN);
    await vi.waitFor(() => expect(source.read).toHaveBeenCalledTimes(1));

    vscodeMock.fireClose(uri);
    expect(provider.referenceCount).toBe(0);
    finishRead({ sourceGeneration: SOURCE.generation, text: 'must not escape', complete: true });
    await expect(pending).rejects.toMatchObject({ code: 'reference-unavailable' });
    expect(provider.outputBytes).toBe(0);
    expect(provider.release(uri)).toBe(false);
  });

  it('clears references on disposal and rejects later reads and registrations', async () => {
    const provider = new RevealTextDocumentContentProvider(readPort());
    const uri = provider.register(SOURCE);
    provider.dispose();

    expect(provider.referenceCount).toBe(0);
    expect(provider.outputBytes).toBe(0);
    expect(vscodeMock.closeListeners.size).toBe(0);
    await expect(provider.provideTextDocumentContent(uri, TOKEN)).rejects.toBeInstanceOf(RevealTextRefusal);
    expect(() => provider.register(SOURCE)).toThrow(RevealTextRefusal);
  });
});
