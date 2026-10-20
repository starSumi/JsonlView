import { describe, expect, it } from 'vitest';
import { createObservabilityEvent } from '../../src/extension/observability-contract';
import { projectQueryMetric } from '../../src/extension/otlp-projection';

describe('bounded OTLP metric projection', () => {
  const settled = createObservabilityEvent('jsonlview.query.settled', {
    stage: 'get_rows',
    request_seq: 7,
    outcome: 'completed',
    delivery: 'accepted',
    abort_observed: true,
    duration_ms: 12,
    rows: 9,
  })!;

  it('projects only settled query duration and finite dimensions', () => {
    expect(projectQueryMetric(settled)).toEqual({
      name: 'jsonlview.query.duration',
      unit: 'ms',
      value: 12,
      attributes: { outcome: 'completed', delivery: 'accepted', abort_observed: true },
    });
  });

  it('does not export identity, source, or event bookkeeping fields', () => {
    const projection = projectQueryMetric(settled);
    expect(JSON.stringify(projection)).not.toContain('request_seq');
    expect(JSON.stringify(projection)).not.toContain('rows');
    expect(JSON.stringify(projection)).not.toContain('timestamp');
    expect(projection?.attributes).not.toHaveProperty('stale_reason');
    expect(projection?.attributes).not.toHaveProperty('error_name');

    const failed = createObservabilityEvent('jsonlview.query.settled', {
      stage: 'get_rows', request_seq: 8, outcome: 'failed', delivery: 'failed',
      abort_observed: false, duration_ms: 4, error_name: 'TypeError',
    })!;
    expect(JSON.stringify(projectQueryMetric(failed))).not.toContain('TypeError');
  });

  it('accepts only validated settled query events', () => {
    const started = createObservabilityEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 7 })!;
    const lifecycle = createObservabilityEvent('jsonlview.lifecycle.snapshot_published', {
      stage: 'snapshot_publish', result: 'published', sequence: 3, causation: 'recovery_decision',
    })!;

    expect(projectQueryMetric(started)).toBeUndefined();
    expect(projectQueryMetric(lifecycle)).toBeUndefined();
    expect(projectQueryMetric(null)).toBeUndefined();
    expect(projectQueryMetric({ name: 'jsonlview.query.settled', timestamp: 'bad', attributes: {} })).toBeUndefined();
  });

  it('rejects private fields and unknown enum values instead of forwarding them', () => {
    const privateEvent = {
      ...settled,
      attributes: { ...settled.attributes, filePath: 'private-sentinel-path' },
    };
    const unknownOutcome = {
      ...settled,
      attributes: { ...settled.attributes, outcome: 'private-sentinel-outcome' },
    };

    expect(projectQueryMetric(privateEvent)).toBeUndefined();
    expect(projectQueryMetric(unknownOutcome)).toBeUndefined();
  });

  it('rejects accessor-backed attributes without evaluating changing private values', () => {
    let reads = 0;
    const attributes = { ...settled.attributes };
    Object.defineProperty(attributes, 'outcome', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'private-sentinel-outcome' : 'completed';
      },
    });

    const accessorEvent = { ...settled, attributes };
    expect(projectQueryMetric(accessorEvent)).toBeUndefined();
    expect(reads).toBe(0);
    expect(JSON.stringify(projectQueryMetric(accessorEvent) ?? null)).not.toContain('private-sentinel-outcome');
  });

  it('rejects non-enumerable accessors without evaluating them', () => {
    let reads = 0;
    const attributes = { ...settled.attributes };
    Object.defineProperty(attributes, 'privateField', {
      get: () => {
        reads += 1;
        return 'private-sentinel';
      },
    });

    expect(projectQueryMetric({ ...settled, attributes })).toBeUndefined();
    expect(reads).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid duration values %s', (durationMs) => {
      const invalid = { ...settled, attributes: { ...settled.attributes, duration_ms: durationMs } };
      expect(projectQueryMetric(invalid)).toBeUndefined();
    },
  );

  it('preserves abort observation without rewriting the operation outcome', () => {
    const lateCompletion = createObservabilityEvent('jsonlview.query.settled', {
      stage: 'get_rows',
      request_seq: 1,
      outcome: 'completed',
      delivery: 'accepted',
      abort_observed: true,
      duration_ms: 0,
    })!;

    expect(projectQueryMetric(lateCompletion)?.attributes).toEqual({
      outcome: 'completed', delivery: 'accepted', abort_observed: true,
    });
  });

  it('emits exactly the schema-valid combinations from the finite label space', () => {
    const pairs = [
      { outcome: 'completed', delivery: 'accepted' },
      { outcome: 'completed', delivery: 'rejected' },
      { outcome: 'stale', delivery: 'skipped' },
      { outcome: 'stale', delivery: 'failed' },
      { outcome: 'cancelled', delivery: 'skipped' },
      { outcome: 'cancelled', delivery: 'failed' },
      { outcome: 'failed', delivery: 'skipped' },
      { outcome: 'failed', delivery: 'failed' },
    ] as const;
    const expected = pairs.flatMap(({ outcome, delivery }) => [false, true].map((abortObserved) =>
      JSON.stringify({ outcome, delivery, abort_observed: abortObserved }),
    ));
    const signatures = new Set<string>();

    for (const { outcome, delivery } of pairs) {
      for (const abortObserved of [false, true]) {
        const event = createObservabilityEvent('jsonlview.query.settled', {
          stage: 'get_rows', request_seq: 1, outcome, delivery,
          abort_observed: abortObserved, duration_ms: 1,
          ...(outcome === 'stale' ? { stale_reason: 'epoch' } : {}),
          ...(outcome === 'failed' ? { error_name: 'TypeError' } : {}),
        });
        expect(event).toBeDefined();
        const projection = projectQueryMetric(event);
        expect(projection).toBeDefined();
        signatures.add(JSON.stringify(projection?.attributes));
      }
    }

    expect(signatures.size).toBe(16);
    expect(Array.from(signatures).sort()).toEqual(expected.sort());
    for (const signature of signatures) {
      expect(signature).not.toContain('request_seq');
      expect(signature).not.toContain('error_name');
    }
  });
});
