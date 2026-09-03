import { describe, expect, it } from 'vitest';
import { RequestRegistry } from '../../src/extension/request-registry';

describe('request registry', () => {
  it('cancels the previous request in a latest-wins channel', () => {
    const registry = new RequestRegistry();
    const first = registry.startLatest('viewport', 'first');
    registry.startLatest('viewport', 'second');
    expect(first.aborted).toBe(true);
    expect(registry.size).toBe(1);
  });
});

