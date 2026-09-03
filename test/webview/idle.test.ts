import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferIdle } from '../../src/webview/idle';

describe('deferIdle', () => {
  afterEach(() => vi.useRealTimers());

  it('defers work to the timer fallback when idle callbacks are unavailable', () => {
    vi.useFakeTimers();
    const work = vi.fn();
    deferIdle(work);
    expect(work).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(work).toHaveBeenCalledOnce();
  });

  it('cancels deferred work before it runs', () => {
    vi.useFakeTimers();
    const work = vi.fn();
    const cancel = deferIdle(work);
    cancel();
    vi.runOnlyPendingTimers();
    expect(work).not.toHaveBeenCalled();
  });
});
