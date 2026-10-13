import { describe, expect, it } from 'vitest';
import {
  createCausalLifecycleTrace,
  createObservabilityEvent,
  NOOP_OBSERVABILITY,
} from '../../src/extension/observability-contract';

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
    const accepted = trace.record('webview_acceptance', 'accepted');

    expect(events).toEqual([
      'jsonlview.lifecycle.source_classified:1',
      'jsonlview.lifecycle.recovery_decided:2',
      'jsonlview.lifecycle.snapshot_published:3',
      'jsonlview.lifecycle.webview_accepted:4',
    ]);
    expect(accepted).toMatchObject({
      timestamp: '2026-10-13T00:00:00.000Z',
      attributes: {
        stage: 'webview_acceptance',
        result: 'accepted',
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
