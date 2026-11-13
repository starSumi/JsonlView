import { describe, expect, it } from 'vitest';
import {
  createCausalLifecycleTrace,
  createObservabilityEvent,
  NOOP_OBSERVABILITY,
} from '../../../src/extension/observability/observability-contract';

describe('contract-first observability boundary', () => {
  it('accepts bounded scalar diagnostic attributes only', () => {
    expect(createObservabilityEvent('jsonlview.webview.error', { stage: 'editor-webview', error_name: 'InvalidStateError' })).toMatchObject({
      name: 'jsonlview.webview.error',
      attributes: { stage: 'editor-webview', error_name: 'InvalidStateError' },
    });
  });

  it('rejects source, identity, unbounded, and non-scalar data', () => {
    expect(createObservabilityEvent('jsonlview.query.completed', { path: 'C:/secret/session.jsonl' })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.completed', { rows: { count: 1 } })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.completed', { result: 'x'.repeat(161) })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.completed', { rows: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('has no-op behavior until an explicit exporter is introduced', () => {
    expect(() => NOOP_OBSERVABILITY.record({ name: 'jsonlview.index.completed', timestamp: new Date().toISOString(), attributes: {} })).not.toThrow();
  });

  it('records the bounded causal lifecycle without source or session identity', () => {
    const events: string[] = [];
    const trace = createCausalLifecycleTrace({
      record: (event) => events.push(`${event.name}:${String(event.attributes.sequence)}`),
    }, () => '2026-10-13T00:00:00.000Z');

    const classified = trace.record('source_classification', 'unknown');
    const decided = trace.record('recovery_decision', 'retry');
    const published = trace.record('snapshot_publish', 'published');
    const delivered = trace.record('webview_delivery', 'delivered');

    expect(events).toEqual([
      'jsonlview.lifecycle.source_classified:1',
      'jsonlview.lifecycle.recovery_decided:2',
      'jsonlview.lifecycle.snapshot_published:3',
      'jsonlview.lifecycle.webview_delivered:4',
    ]);
    expect(delivered).toMatchObject({
      timestamp: '2026-10-13T00:00:00.000Z',
      attributes: {
        stage: 'webview_delivery',
        result: 'delivered',
        sequence: 4,
        causation: 'snapshot_publish',
      },
    });
    expect(classified?.attributes).not.toHaveProperty('trace_id');
    expect(decided?.attributes).not.toHaveProperty('path');
    expect(published?.attributes).not.toHaveProperty('session_id');
    expect(trace.sequence).toBe(4);
    expect(trace.complete).toBe(true);
  });

  it('rejects out-of-order stages and isolates sink failures', () => {
    const sink = { record: () => { throw new Error('sink unavailable'); } };
    const trace = createCausalLifecycleTrace(sink, () => '2026-10-13T00:00:00.000Z');

    expect(trace.record('snapshot_publish', 'published')).toBeUndefined();
    expect(() => trace.record('source_classification', 'append')).not.toThrow();
    expect(trace.sequence).toBe(1);
    expect(trace.complete).toBe(false);
  });

  it('rejects an event name that is outside the contract even at runtime', () => {
    expect(createObservabilityEvent('jsonlview.private.export' as never, { result: 'accepted' })).toBeUndefined();
  });
});

describe('local query operation event contract', () => {
  const terminal = { stage: 'get_rows', request_seq: 1, outcome: 'completed',
    delivery: 'accepted', abort_observed: false, duration_ms: 0, rows: 0 };

  it('accepts a bounded begin and settled event without trace context', () => {
    expect(createObservabilityEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 1 }))
      .toMatchObject({ attributes: { stage: 'get_rows', request_seq: 1 } });
    expect(createObservabilityEvent('jsonlview.query.settled', terminal)).toMatchObject({ attributes: terminal });
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'stale', delivery: 'skipped', stale_reason: 'epoch' }))
      .toBeDefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'failed', delivery: 'failed', error_name: 'TypeError' }))
      .toBeDefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'stale', delivery: 'failed', stale_reason: 'generation' }))
      .toBeDefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'cancelled', delivery: 'failed', abort_observed: true }))
      .toBeDefined();
  });

  it('accepts a complete timing receipt and rejects partial or invalid timing metadata', () => {
    const timing = {
      queue_wait_ms: 10,
      engine_exec_ms: 20,
      queue_blocked_by: 'index_more',
      index_work_ms: 8,
      read_wait_ms: 3,
      parse_ms: 2,
      projection_ms: 1,
      snapshot_check_ms: 4,
    };
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, ...timing }))
      .toMatchObject({ attributes: { ...terminal, ...timing } });
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, queue_wait_ms: 10 })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, ...timing, parse_ms: 1.5 })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, ...timing, queue_blocked_by: 'private_operation' })).toBeUndefined();
  });

  const timingWithReads = {
    queue_wait_ms: 10, engine_exec_ms: 20, queue_blocked_by: 'index_more',
    index_work_ms: 8, read_wait_ms: 3, parse_ms: 2, projection_ms: 1, snapshot_check_ms: 4,
    read_calls: 3, read_bytes: 64, read_max_wait_ms: 2,
  };

  it('accepts all 19 bounded attributes for a stale query with complete read diagnostics', () => {
    const attributes = { ...terminal, ...timingWithReads, outcome: 'stale', delivery: 'skipped', stale_reason: 'generation' };
    expect(Object.keys(attributes)).toHaveLength(19);
    expect(createObservabilityEvent('jsonlview.query.settled', attributes)?.attributes).toEqual(attributes);
  });

  it.each(['read_calls', 'read_bytes', 'read_max_wait_ms'])('rejects a diagnostics group missing %s', (missing) => {
    const partial = Object.fromEntries(Object.entries(timingWithReads).filter(([key]) => key !== missing));
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, ...partial })).toBeUndefined();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid read diagnostic values %s', (value) => {
      for (const key of ['read_calls', 'read_bytes', 'read_max_wait_ms']) {
        expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, ...timingWithReads, [key]: value })).toBeUndefined();
      }
    },
  );

  it('requires the complete timing receipt when read diagnostics are present', () => {
    expect(createObservabilityEvent('jsonlview.query.settled', {
      ...terminal, read_calls: 0, read_bytes: 0, read_max_wait_ms: 0,
    })).toBeUndefined();
  });

  it.each(['requestId', 'documentId', 'generation', 'epoch', 'correlationId', 'trace_id', 'span_id', 'query', 'path', 'message', 'stack'])(
    'rejects raw identity or source key %s', (key) => {
      expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, [key]: 'private' })).toBeUndefined();
    },
  );

  it.each([
    { stage: 'private' }, { request_seq: 0 }, { request_seq: Number.MAX_SAFE_INTEGER + 1 },
    { request_seq: 1.5 }, { outcome: 'private' }, { delivery: 'private' },
    { abort_observed: 'false' }, { duration_ms: -1 }, { duration_ms: Infinity },
    { rows: -1 }, { rows: 0.5 }, { error_name: 'private_Error' },
    { stale_reason: 'private' }, { profile: 'private' },
  ])('rejects invalid terminal metadata %j', (invalid) => {
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, ...invalid })).toBeUndefined();
  });

  it('requires terminal fields and forbids metadata inconsistent with the outcome', () => {
    expect(createObservabilityEvent('jsonlview.query.started', terminal)).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { stage: 'get_rows', request_seq: 1 })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, stale_reason: 'epoch' })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, error_name: 'Error' })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'stale', delivery: 'skipped' })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'cancelled', delivery: 'accepted' })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.settled', { ...terminal, outcome: 'failed', error_name: 'Error' })).toBeUndefined();
  });
});
