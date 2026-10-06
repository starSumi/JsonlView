import { describe, expect, it } from 'vitest';
import { createOptInNavigationFacade, ReadOnlyNavigationFacade, type NavigationProvider, type NavigationSnapshot } from '../../src/experimental';

function snapshot(): NavigationSnapshot {
  return {
    snapshotId: 'snap-1',
    sourceId: 'codex-local',
    sourceGeneration: 'gen-1',
    capturedAt: '2026-10-07T00:00:00.000Z',
    redaction: 'metadata-only',
    truncated: false,
    entities: [
      { sourceId: 'codex-local', nativeId: 'thread-1', kind: 'thread', label: 'Root thread', confidence: 'source' },
      { sourceId: 'codex-local', nativeId: 'agent-1', kind: 'subagent', label: 'Build worker', parentNativeId: 'thread-1', confidence: 'correlated' },
      { sourceId: 'codex-local', nativeId: 'goal-1', kind: 'goal', label: 'hidden details', parentNativeId: 'thread-1', confidence: 'source', opaqueRef: 'opaque:goal-1' },
    ],
    relations: [
      { sourceId: 'codex-local', fromNativeId: 'thread-1', toNativeId: 'agent-1', kind: 'spawn' },
    ],
  };
}

function provider(): NavigationProvider {
  return {
    sourceId: 'codex-local',
    readSnapshot: async (_signal, budget) => {
      const value = snapshot();
      expect(budget.maxEntities).toBeGreaterThan(0);
      return value;
    },
  };
}

describe('read-only navigation facade', () => {
  it('returns bounded, metadata-only entities and related edges', async () => {
    const facade = new ReadOnlyNavigationFacade({ providers: [provider()], allowedSourceIds: ['codex-local'] });
    const result = await facade.query('op-1', { kind: 'subagent' }, new AbortController().signal);

    expect(result).toMatchObject({ protocolVersion: 1, operationId: 'op-1', snapshotId: 'snap-1', sourceId: 'codex-local' });
    expect(result.entities.map((entity) => entity.nativeId)).toEqual(['agent-1']);
    expect(result.relations).toEqual([{ sourceId: 'codex-local', fromNativeId: 'thread-1', toNativeId: 'agent-1', kind: 'spawn' }]);
  });

  it('requires explicit source authorization and rejects arbitrary paths by contract', async () => {
    const facade = new ReadOnlyNavigationFacade({ providers: [provider()], allowedSourceIds: [] });
    await expect(facade.query('op-2', { sourceId: 'codex-local' }, new AbortController().signal)).rejects.toThrow('not allowlisted');
    await expect(facade.query('op-3', { sourceId: String.raw`C:\private\sessions` }, new AbortController().signal)).rejects.toThrow('not allowlisted');
  });

  it('pins a snapshot and rejects a cross-source snapshot id', async () => {
    const facade = new ReadOnlyNavigationFacade({ providers: [provider()], allowedSourceIds: ['codex-local'] });
    await expect(facade.query('op-4', { snapshotId: 'missing' }, new AbortController().signal)).rejects.toThrow('Unknown navigation snapshot');
    const first = await facade.query('op-5', {}, new AbortController().signal);
    const second = await facade.query('op-6', { snapshotId: first.snapshotId, text: 'worker' }, new AbortController().signal);
    expect(second.entities.map((entity) => entity.label)).toEqual(['Build worker']);
  });

  it('propagates cancellation and rejects invalid operation identifiers', async () => {
    const controller = new AbortController();
    controller.abort();
    const facade = new ReadOnlyNavigationFacade({ providers: [provider()], allowedSourceIds: ['codex-local'] });
    await expect(facade.query('op-7', {}, controller.signal)).rejects.toThrow('cancelled');
    await expect(facade.query('path/../../secret', {}, new AbortController().signal)).rejects.toThrow('operationId is invalid');
  });

  it('rejects an unredacted provider snapshot', async () => {
    const unredacted: NavigationProvider = {
      sourceId: 'codex-local',
      readSnapshot: async () => ({ ...snapshot(), redaction: 'full' as never }),
    };
    const facade = new ReadOnlyNavigationFacade({ providers: [unredacted], allowedSourceIds: ['codex-local'] });
    await expect(facade.query('op-8', {}, new AbortController().signal)).rejects.toThrow('unredacted snapshot');
  });

  it('rejects path-shaped and unbounded metadata labels', async () => {
    const unsafe: NavigationProvider = {
      sourceId: 'codex-local',
      readSnapshot: async () => ({
        ...snapshot(),
        entities: [{ ...snapshot().entities[0]!, label: String.raw`C:\Users\private\prompt.txt` }],
      }),
    };
    const facade = new ReadOnlyNavigationFacade({ providers: [unsafe], allowedSourceIds: ['codex-local'] });
    await expect(facade.query('op-9', {}, new AbortController().signal)).rejects.toThrow('path in a metadata label');
  });

  it('rejects a provider that exceeds the negotiated entity budget', async () => {
    const oversized: NavigationProvider = {
      sourceId: 'codex-local',
      readSnapshot: async () => ({ ...snapshot(), entities: Array.from({ length: 501 }, (_, index) => ({
        sourceId: 'codex-local', nativeId: `entity-${String(index)}`, kind: 'event' as const, label: 'event', confidence: 'source' as const,
      })) }),
    };
    const facade = new ReadOnlyNavigationFacade({ providers: [oversized], allowedSourceIds: ['codex-local'] });
    await expect(facade.query('op-10', {}, new AbortController().signal)).rejects.toThrow('exceeded its declared budget');
  });

  it('cancels a provider that does not resolve after the caller aborts', async () => {
    const pending: NavigationProvider = {
      sourceId: 'codex-local',
      readSnapshot: async () => new Promise<NavigationSnapshot>(() => undefined),
    };
    const controller = new AbortController();
    const facade = new ReadOnlyNavigationFacade({ providers: [pending], allowedSourceIds: ['codex-local'] });
    const request = facade.query('op-11', {}, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow('cancelled');
  });

  it('keeps the host seam inert until opt-in is explicit', () => {
    let reads = 0;
    const inert: NavigationProvider = {
      sourceId: 'codex-local',
      readSnapshot: async () => { reads += 1; return snapshot(); },
    };
    expect(createOptInNavigationFacade({ enabled: false, providers: [inert], allowedSourceIds: ['codex-local'] })).toBeUndefined();
    expect(reads).toBe(0);
    expect(() => createOptInNavigationFacade({ enabled: true, providers: [inert], allowedSourceIds: [] })).toThrow('explicit source allowlist');
  });
});
