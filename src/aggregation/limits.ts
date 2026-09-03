import { AGGREGATION_LIMITS } from './types';

export interface ResolvedLimits {
  maxRecords: number;
  maxKeyLength: number;
}

export function resolveLimits(options: { maxRecords?: number; maxKeyLength?: number }): ResolvedLimits {
  return {
    maxRecords: boundedInteger('maxRecords', options.maxRecords ?? AGGREGATION_LIMITS.defaultMaxRecords, 1, AGGREGATION_LIMITS.hardMaxRecords),
    maxKeyLength: boundedInteger('maxKeyLength', options.maxKeyLength ?? AGGREGATION_LIMITS.defaultMaxKeyLength, 1, AGGREGATION_LIMITS.hardMaxKeyLength),
  };
}

export function resolveGroupCapacity(value: number | undefined): number {
  return boundedInteger('maxGroups', value ?? AGGREGATION_LIMITS.defaultMaxGroups, 4, AGGREGATION_LIMITS.hardMaxGroups);
}

export function resolveBucketCapacity(value: number | undefined): number {
  return boundedInteger('maxBuckets', value ?? AGGREGATION_LIMITS.defaultMaxBuckets, 4, AGGREGATION_LIMITS.hardMaxBuckets);
}

export function assertBucketWidth(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('bucketWidthMs must be a positive safe integer.');
  }
  return value;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export class AggregationAbortedError extends Error {
  public override readonly name = 'AbortError';

  public constructor() {
    super('Aggregation was aborted.');
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AggregationAbortedError();
}
