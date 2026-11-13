import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservabilityEvent } from '../../../src/extension/observability/observability-contract';
import { createCdpQueryTap, isCdpQueryTapEnabled } from '../../../src/extension/observability/cdp-query-tap';
import { isExtensionMessage } from '../../../src/shared/transport/extension-message';

const identity = { traceId: '12', startupId: '34' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

function queryEvent(
  name: ObservabilityEvent['name'],
  attributes: Readonly<Record<string, string | number | boolean>> = { stage: 'get_rows', request_seq: 7 },
): ObservabilityEvent {
  return { name, timestamp: '2026-10-20T00:00:00.000Z', attributes };
}

describe('development-only CDP query tap', () => {
  it('requires development mode and the exact opt-in value', () => {
    expect(isCdpQueryTapEnabled('development', '1')).toBe(true);
    for (const value of [undefined, '', '0', 'true', ' 1', '1 ']) {
      expect(isCdpQueryTapEnabled('development', value)).toBe(false);
    }
    for (const mode of ['production', 'test', 'unknown'] as const) {
      expect(isCdpQueryTapEnabled(mode, '1')).toBe(false);
    }
  });

  it('is silent by default and does not call the transport', () => {
    const postMessage = vi.fn(async (_message: unknown) => true);
    const tap = createCdpQueryTap({ postMessage }, identity, false);
    tap.record(queryEvent('jsonlview.query.started'));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends a sanitized fixed envelope and ignores arbitrary event attributes', () => {
    const postMessage = vi.fn(async (_message: unknown) => true);
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    tap.record(queryEvent('jsonlview.query.started', {
      stage: 'get_rows', request_seq: 7, path: 'C:/private/session.jsonl', prompt: 'private prompt',
    }));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const envelope = postMessage.mock.calls[0]?.[0];
    expect(envelope).toEqual({
      __jsonlViewCdpQueryTap: 1,
      traceId: '12',
      startupId: '34',
      eventName: 'jsonlview.query.started',
      attributes: { stage: 'get_rows', request_seq: 7 },
    });
    expect(envelope).not.toHaveProperty('timestamp');
    expect(isExtensionMessage(envelope)).toBe(false);
  });

  it('includes only validated bounded settlement fields', () => {
    const postMessage = vi.fn(async (_message: unknown) => true);
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    tap.record(queryEvent('jsonlview.query.settled', {
      stage: 'get_rows', request_seq: 9, outcome: 'failed', delivery: 'failed',
      abort_observed: false, duration_ms: 18, rows: 0, error_name: 'TypeError',
      queue_wait_ms: 12, engine_exec_ms: 6, queue_blocked_by: 'index_more',
      index_work_ms: 4, read_wait_ms: 2, parse_ms: 1, projection_ms: 0, snapshot_check_ms: 2,
      read_calls: 3, read_bytes: 64, read_max_wait_ms: 1,
      uri: 'file:///private.jsonl', payload: 'private',
    }));

    expect(postMessage.mock.calls[0]?.[0]).toEqual({
      __jsonlViewCdpQueryTap: 1, traceId: '12', startupId: '34',
      eventName: 'jsonlview.query.settled',
      attributes: {
        stage: 'get_rows', request_seq: 9, outcome: 'failed', delivery: 'failed',
        abort_observed: false, duration_ms: 18, rows: 0, error_name: 'TypeError',
      },
    });
  });

  it('drops malformed events and rejects invalid correlation IDs', () => {
    const postMessage = vi.fn(async (_message: unknown) => true);
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'other', request_seq: 7 }));
    tap.record(queryEvent('jsonlview.query.settled', {
      stage: 'get_rows', request_seq: 9, outcome: 'failed', delivery: 'failed',
      abort_observed: false, duration_ms: Number.MAX_SAFE_INTEGER + 1, error_name: 'TypeError',
    }));
    createCdpQueryTap({ postMessage }, { traceId: '../private', startupId: '34' }, true)
      .record(queryEvent('jsonlview.query.started'));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('contains synchronous throws and closes without retrying', () => {
    vi.useFakeTimers();
    const throwingTap = createCdpQueryTap({ postMessage: () => { throw new Error('disposed'); } }, identity, true);
    expect(() => throwingTap.record(queryEvent('jsonlview.query.started'))).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    throwingTap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 2 }));
  });

  it('closes after rejected delivery and drops the queued pair', async () => {
    vi.useFakeTimers();
    const first = deferred<boolean>();
    const postMessage = vi.fn((_message: unknown) => first.promise);
    const rejectedTap = createCdpQueryTap({ postMessage }, identity, true);
    rejectedTap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 1 }));
    rejectedTap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 2 }));
    first.reject(new Error('closed'));
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    rejectedTap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 3 }));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('closes after a resolved false delivery and drops the queued pair', async () => {
    vi.useFakeTimers();
    const first = deferred<boolean>();
    const postMessage = vi.fn((_message: unknown) => first.promise);
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 1 }));
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 2 }));

    first.resolve(false);
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 3 }));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('closes after a hung send times out, drops pending events, and removes its timer', async () => {
    vi.useFakeTimers();
    const pending = deferred<boolean>();
    const postMessage = vi.fn((_message: unknown) => pending.promise);
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 1 }));
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 2 }));
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(vi.getTimerCount()).toBe(0);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 3 }));
    pending.resolve(true);
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledTimes(1);
    tap.dispose();
  });

  it('disposal clears the timeout and queued messages while a send is unresolved', async () => {
    vi.useFakeTimers();
    const pending = deferred<boolean>();
    const postMessage = vi.fn((_message: unknown) => pending.promise);
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 1 }));
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 2 }));
    tap.dispose();

    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(true);
    await Promise.resolve();
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 3 }));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('fails closed on overflow and drops queued events', async () => {
    const pending = deferred<boolean>();
    const sent: number[] = [];
    const postMessage = vi.fn((message: unknown) => {
      const envelope = message as { attributes: { request_seq: number } };
      sent.push(envelope.attributes.request_seq);
      return sent.length === 1 ? pending.promise : Promise.resolve(true);
    });
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    for (let requestSeq = 1; requestSeq <= 10; requestSeq += 1) {
      tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: requestSeq }));
    }
    expect(sent).toEqual([1]);

    pending.resolve(true);
    await Promise.resolve();
    expect(sent).toEqual([1]);
    tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 11 }));
    expect(sent).toEqual([1]);
  });

  it('serializes successful delivery through one in-flight message', async () => {
    const pending = deferred<boolean>();
    const sent: number[] = [];
    const postMessage = vi.fn((message: unknown) => {
      const envelope = message as { attributes: { request_seq: number } };
      sent.push(envelope.attributes.request_seq);
      return sent.length === 1 ? pending.promise : Promise.resolve(true);
    });
    const tap = createCdpQueryTap({ postMessage }, identity, true);
    for (let requestSeq = 1; requestSeq <= 9; requestSeq += 1) {
      tap.record(queryEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: requestSeq }));
    }
    expect(sent).toEqual([1]);
    pending.resolve(true);
    await vi.waitFor(() => expect(sent).toHaveLength(9));
    expect(sent).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
