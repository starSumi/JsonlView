import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevealIntentRegistry } from '../../src/experimental/session-navigator/reveal-intents';
afterEach(() => vi.useRealTimers());
const intent = { sourceId: 'source', catalogGeneration: 'catalog-1', nativeId: 'event-1', anchorOrdinal: '42' };
describe('one-shot reveal result handoff', () => {
  it('consumes once and resolves only on the matching delivery completion', async () => {
    const registry = new RevealIntentRegistry(); const ticket = registry.set('opaque-uri', intent);
    const delivery = registry.take('opaque-uri')!;
    expect(registry.take('opaque-uri')).toBeUndefined(); expect(ticket.taken).toBe(true);
    delivery.complete({ outcome: 'shown', anchorOrdinal: '42', requestId: 'reveal-1', documentId: 'doc', generation: 'g', epoch: 1 });
    await expect(ticket.result).resolves.toMatchObject({ outcome: 'shown', requestId: 'reveal-1' });
  });
  it('supersedes an old consumed ticket and contains its late completion', async () => {
    const registry = new RevealIntentRegistry(); const first = registry.set('uri', intent); const old = registry.take('uri')!;
    const second = registry.set('uri', intent);
    await expect(first.result).resolves.toMatchObject({ outcome: 'superseded' });
    old.complete({ outcome: 'shown', anchorOrdinal: '42', requestId: 'old', documentId: 'doc', generation: 'g' });
    registry.clear('uri'); await expect(second.result).resolves.toMatchObject({ outcome: 'no-view' });
  });
  it('bounds unopened handoffs and settles them when the registry is cleared', async () => {
    vi.useFakeTimers(); const registry = new RevealIntentRegistry({ ttlMs: 5000, maxPending: 1 });
    const first = registry.set('one', intent); const second = registry.set('two', intent);
    await expect(first.result).resolves.toMatchObject({ outcome: 'superseded' });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(second.result).resolves.toMatchObject({ outcome: 'no-view' });
    expect(registry.take('two')).toBeUndefined();
  });
  it('contains observer failures and treats an unavailable grant as revoked', async () => {
    const registry = new RevealIntentRegistry();
    registry.onQueued(() => { throw new Error('observer unavailable'); });
    const ticket = registry.set('uri', intent, () => { throw new Error('grant unavailable'); });
    const delivery = registry.take('uri')!;
    expect(delivery.isAuthorized()).toBe(false);
    delivery.complete({ outcome: 'shown', anchorOrdinal: '42', requestId: 'reveal-1', documentId: 'doc', generation: 'g' });
    await expect(ticket.result).resolves.toMatchObject({ outcome: 'unauthorized' });
    expect(registry.take('uri')).toBeUndefined();
  });
  it('does not let an older opener clear a newer consumed ticket', async () => {
    const registry = new RevealIntentRegistry();
    const first = registry.set('uri', intent);
    const second = registry.set('uri', { ...intent, anchorOrdinal: '43' });
    const current = registry.take('uri')!;
    first.clear();
    await expect(first.result).resolves.toMatchObject({ outcome: 'superseded' });
    current.complete({ outcome: 'shown', anchorOrdinal: '43', requestId: 'reveal-2', documentId: 'doc', generation: 'g' });
    await expect(second.result).resolves.toMatchObject({ outcome: 'shown' });
  });
});
