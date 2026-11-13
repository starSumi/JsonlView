import { createObservabilityEvent, type QueryOperationDelivery, type QueryOperationOutcome } from './observability-contract';

export interface QueryMetricProjection {
  readonly name: 'jsonlview.query.duration';
  readonly unit: 'ms';
  readonly value: number;
  readonly attributes: Readonly<{
    outcome: QueryOperationOutcome;
    delivery: QueryOperationDelivery;
    abort_observed: boolean;
  }>;
}

/** Project validated local query events into a content-free, bounded metric point. */
export function projectQueryMetric(event: unknown): QueryMetricProjection | undefined {
  if (typeof event !== 'object' || event === null) return undefined;

  try {
    const candidate = snapshotDataProperties(event);
    if (candidate?.name !== 'jsonlview.query.settled' || typeof candidate.timestamp !== 'string'
      || typeof candidate.attributes !== 'object' || candidate.attributes === null) return undefined;
    const attributes = snapshotDataProperties(candidate.attributes);
    if (attributes === undefined) return undefined;

    const validated = createObservabilityEvent(
      candidate.name,
      attributes,
      candidate.timestamp,
    );
    if (validated?.name !== 'jsonlview.query.settled') return undefined;

    const { outcome, delivery, abort_observed: abortObserved, duration_ms: durationMs } = validated.attributes;
    if (typeof outcome !== 'string' || typeof delivery !== 'string' || typeof abortObserved !== 'boolean'
      || typeof durationMs !== 'number') return undefined;

    return Object.freeze({
      name: 'jsonlview.query.duration',
      unit: 'ms',
      value: durationMs,
      attributes: Object.freeze({
        outcome: outcome as QueryOperationOutcome,
        delivery: delivery as QueryOperationDelivery,
        abort_observed: abortObserved,
      }),
    });
  } catch {
    return undefined;
  }
}

function snapshotDataProperties(value: object): Record<string, unknown> | undefined {
  try {
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return undefined;
      if (!('value' in descriptor)) return undefined;
      if (!descriptor.enumerable) continue;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
