import type { JsonScalar, RowProjection } from '../shared/types';
import { assertBucketWidth, resolveBucketCapacity, resolveLimits, throwIfAborted } from './limits';
import { selectValue } from './selectors';
import type {
  FieldSelector,
  TimeBucket,
  TimeBucketAggregationOptions,
  TimeBucketAggregationResult,
  TimestampUnit,
} from './types';

interface ExactBucket {
  startMs: number;
  count: number;
}

const DEFAULT_TIMESTAMP_SELECTOR: FieldSelector = { kind: 'profile', field: 'timestamp' };

export class TimeBucketAggregator {
  private readonly options: TimeBucketAggregationOptions;
  private readonly selector: FieldSelector;
  private readonly timestampUnit: TimestampUnit;
  private readonly maxRecords: number;
  private readonly maxKeyLength: number;
  private readonly maxBuckets: number;
  private readonly exactCapacity: number;
  private readonly bucketWidthMs: number;
  private readonly exact = new Map<number, ExactBucket>();
  private processedRecords = 0;
  private truncatedByRecordLimit = false;
  private overflowCount = 0;
  private unknownCount = 0;
  private missingCount = 0;

  public constructor(options: TimeBucketAggregationOptions) {
    this.selector = options.selector ? { ...options.selector } : { ...DEFAULT_TIMESTAMP_SELECTOR };
    this.options = { ...options, selector: this.selector };
    this.timestampUnit = options.timestampUnit ?? 'auto';
    const limits = resolveLimits(options);
    this.maxRecords = limits.maxRecords;
    this.maxKeyLength = limits.maxKeyLength;
    this.maxBuckets = resolveBucketCapacity(options.maxBuckets);
    this.exactCapacity = this.maxBuckets - 3;
    this.bucketWidthMs = assertBucketWidth(options.bucketWidthMs);
    throwIfAborted(options.signal);
  }

  public add(row: RowProjection): boolean {
    throwIfAborted(this.options.signal);
    if (this.processedRecords >= this.maxRecords) {
      this.truncatedByRecordLimit = true;
      return false;
    }
    this.processedRecords += 1;

    const selected = selectValue(row, this.selector);
    if (selected.state === 'missing') {
      this.missingCount += 1;
      return true;
    }
    if (selected.state === 'unknown') {
      this.unknownCount += 1;
      return true;
    }
    const timestampMs = toTimestampMs(selected.value, this.timestampUnit, this.maxKeyLength);
    if (timestampMs === undefined) {
      this.unknownCount += 1;
      return true;
    }
    const startMs = Math.floor(timestampMs / this.bucketWidthMs) * this.bucketWidthMs;
    const endExclusiveMs = startMs + this.bucketWidthMs;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endExclusiveMs) || !isValidDateMs(startMs)) {
      this.unknownCount += 1;
      return true;
    }
    const existing = this.exact.get(startMs);
    if (existing) {
      existing.count += 1;
      return true;
    }
    if (this.exact.size >= this.exactCapacity) {
      this.overflowCount += 1;
      return true;
    }
    this.exact.set(startMs, { startMs, count: 1 });
    return true;
  }

  public finish(): TimeBucketAggregationResult {
    throwIfAborted(this.options.signal);
    const buckets: TimeBucket[] = [...this.exact.values()]
      .sort((left, right) => left.startMs - right.startMs)
      .map(({ startMs, count }) => ({
        id: `time:${startMs}`,
        kind: 'time',
        label: new Date(startMs).toISOString(),
        count,
        startMs,
        endExclusiveMs: startMs + this.bucketWidthMs,
      }));
    if (this.overflowCount > 0) buckets.push({ id: 'overflow', kind: 'overflow', label: 'Overflow', count: this.overflowCount });
    if (this.unknownCount > 0) buckets.push({ id: 'unknown', kind: 'unknown', label: 'Unknown', count: this.unknownCount });
    if (this.missingCount > 0) buckets.push({ id: 'missing', kind: 'missing', label: 'Missing', count: this.missingCount });

    return {
      kind: 'time-buckets',
      selector: { ...this.selector },
      bucketWidthMs: this.bucketWidthMs,
      timestampUnit: this.timestampUnit,
      buckets,
      meta: {
        processedRecords: this.processedRecords,
        truncatedByRecordLimit: this.truncatedByRecordLimit,
        capacityReached: this.overflowCount > 0,
        maxRecords: this.maxRecords,
        resultCapacity: this.maxBuckets,
        retainedValueCapacity: this.exactCapacity,
        strategy: 'first-seen-exact-until-cap',
        selectionIsOrderDependent: true,
        countGuarantee: 'retained and reserved bucket counts are exact; identities merged into Other or Overflow are not retained',
      },
    };
  }
}

export function aggregateTimeBuckets(
  rows: Iterable<RowProjection>,
  options: TimeBucketAggregationOptions,
): TimeBucketAggregationResult {
  const aggregator = new TimeBucketAggregator(options);
  for (const row of rows) {
    if (!aggregator.add(row)) break;
  }
  return aggregator.finish();
}

export function toTimestampMs(value: JsonScalar, unit: TimestampUnit, maxLength: number): number | undefined {
  if (value === null || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return convertNumericTimestamp(value, unit);
  const text = value.trim();
  if (text.length === 0 || text.length > maxLength) return undefined;
  if (unit === 'iso') return parseIso(text);
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    return convertTextTimestamp(text, unit);
  }
  return unit === 'auto' ? parseIso(text) : undefined;
}

function convertTextTimestamp(text: string, unit: TimestampUnit): number | undefined {
  if (/^-?\d+$/.test(text)) {
    try {
      return convertIntegerTimestamp(BigInt(text), unit);
    } catch {
      return undefined;
    }
  }
  const numeric = Number(text);
  return convertNumericTimestamp(numeric, unit);
}

function convertIntegerTimestamp(value: bigint, unit: TimestampUnit): number | undefined {
  if (unit === 'iso') return undefined;
  let milliseconds: bigint;
  if (unit === 'auto') {
    const magnitude = value < 0n ? -value : value;
    if (magnitude >= 100_000_000_000_000_000n) milliseconds = value / 1_000_000n;
    else if (magnitude >= 100_000_000_000_000n) milliseconds = value / 1_000n;
    else if (magnitude >= 100_000_000_000n) milliseconds = value;
    else milliseconds = value * 1_000n;
  } else if (unit === 'ns') milliseconds = value / 1_000_000n;
  else if (unit === 'us') milliseconds = value / 1_000n;
  else if (unit === 'ms') milliseconds = value;
  else milliseconds = value * 1_000n;
  return validTimestampNumber(Number(milliseconds));
}

function convertNumericTimestamp(value: number, unit: TimestampUnit): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
  switch (unit) {
    case 'iso': return undefined;
    case 's': return validTimestampNumber(value * 1_000);
    case 'ms': return validTimestampNumber(value);
    case 'us': return validTimestampNumber(value / 1_000);
    case 'ns': return validTimestampNumber(value / 1_000_000);
    case 'auto': {
      const magnitude = Math.abs(value);
      if (magnitude >= 1e17) return validTimestampNumber(value / 1_000_000);
      if (magnitude >= 1e14) return validTimestampNumber(value / 1_000);
      if (magnitude >= 1e11) return validTimestampNumber(value);
      return validTimestampNumber(value * 1_000);
    }
  }
}

function parseIso(value: string): number | undefined {
  return validTimestampNumber(Date.parse(value));
}

function validTimestampNumber(value: number): number | undefined {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.trunc(value)) || !isValidDateMs(value)) return undefined;
  return value;
}

function isValidDateMs(value: number): boolean {
  return Number.isFinite(new Date(value).getTime());
}
