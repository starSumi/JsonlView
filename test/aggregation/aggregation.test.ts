import { describe, expect, it } from 'vitest';
import type { AgentRowProjection, CellProjection, JsonScalar, RowProjection } from '../../src/shared/types';
import {
  AGGREGATION_LIMITS,
  AggregationAbortedError,
  CategoricalAggregator,
  aggregateCategorical,
  aggregateTimeBuckets,
  selectValue,
  TimeBucketAggregator,
  toTimestampMs,
} from '../../src/aggregation';

describe('categorical aggregation', () => {
  it('keeps first-seen groups exact and isolates Other, Unknown and Missing within maxGroups', () => {
    const rows = [
      projected({ severity: 'info' }),
      projected({ severity: 'error' }),
      projected({ severity: 'warn' }),
      projected({ severity: 'error' }),
      projected({ severity: 'unknown' }),
      row(),
    ];
    const result = aggregateCategorical(rows, {
      selector: { kind: 'common', dimension: 'severity' },
      maxGroups: 5,
    });

    expect(result.groups).toEqual([
      expect.objectContaining({ label: 'error', kind: 'value', count: 2 }),
      expect.objectContaining({ label: 'info', kind: 'value', count: 1 }),
      { id: 'other', label: 'Other', kind: 'other', count: 1 },
      { id: 'unknown', label: 'Unknown', kind: 'unknown', count: 1 },
      { id: 'missing', label: 'Missing', kind: 'missing', count: 1 },
    ]);
    expect(result.groups).toHaveLength(5);
    expect(result.meta).toMatchObject({
      processedRecords: 6,
      capacityReached: true,
      resultCapacity: 5,
      retainedValueCapacity: 2,
      strategy: 'first-seen-exact-until-cap',
      selectionIsOrderDependent: true,
    });
    expect(result.meta.countGuarantee).toContain('counts are exact');
  });

  it('states the order-dependent non-Top-N behavior through exact Other totals', () => {
    const result = aggregateCategorical([
      cellRow('category', 'cold'),
      cellRow('category', 'hot'),
      cellRow('category', 'hot'),
      cellRow('category', 'hot'),
    ], {
      selector: { kind: 'cell', columnId: 'category' },
      maxGroups: 4,
    });

    expect(result.groups).toEqual([
      expect.objectContaining({ label: 'cold', kind: 'value', count: 1 }),
      { id: 'other', label: 'Other', kind: 'other', count: 3 },
    ]);
    expect(result.meta.selectionIsOrderDependent).toBe(true);
  });

  it('distinguishes scalar types and classifies null, preview-only and absent cells', () => {
    const result = aggregateCategorical([
      cellRow('field', 7),
      cellRow('field', '7'),
      cellRow('field', null),
      row([{ columnId: 'field', preview: '{object}', truncated: true }]),
      cellRow('field', Number.MAX_SAFE_INTEGER + 1),
      row([{ columnId: 'other', value: 'present' }]),
    ], {
      selector: { kind: 'cell', columnId: 'field' },
      maxGroups: 6,
    });

    expect(result.groups.filter((group) => group.kind === 'value')).toEqual([
      expect.objectContaining({ label: '7', value: 7, count: 1 }),
      expect.objectContaining({ label: '7', value: '7', count: 1 }),
    ]);
    expect(result.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unknown', count: 2 }),
      expect.objectContaining({ kind: 'missing', count: 2 }),
    ]));
  });

  it('selects common service/event/status dimensions from bounded projections', () => {
    const serviceRow = projected({
      eventKind: 'log',
      status: 'ok',
      derivedFields: { service: 'checkout' },
    });
    expect(selectValue(serviceRow, { kind: 'common', dimension: 'service' })).toEqual({ state: 'value', value: 'checkout' });
    expect(selectValue(serviceRow, { kind: 'common', dimension: 'eventKind' })).toEqual({ state: 'value', value: 'log' });
    expect(selectValue(serviceRow, { kind: 'common', dimension: 'status' })).toEqual({ state: 'value', value: 'ok' });
    expect(selectValue(projected({ eventKind: 'other' }), { kind: 'common', dimension: 'eventKind' })).toEqual({ state: 'unknown' });
  });

  it('stops at maxRecords without retaining input rows', () => {
    const result = aggregateCategorical([
      cellRow('field', 'a'),
      cellRow('field', 'a'),
      cellRow('field', 'a'),
    ], {
      selector: { kind: 'cell', columnId: 'field' },
      maxRecords: 2,
    });
    expect(result.meta).toMatchObject({ processedRecords: 2, truncatedByRecordLimit: true });
    expect(result.groups).toEqual([expect.objectContaining({ label: 'a', count: 2 })]);

    const exact = aggregateCategorical([cellRow('field', 'a'), cellRow('field', 'b')], {
      selector: { kind: 'cell', columnId: 'field' },
      maxRecords: 2,
    });
    expect(exact.meta.truncatedByRecordLimit).toBe(false);
  });

  it('supports incremental feeding and downgrades oversized keys to Unknown', () => {
    const aggregator = new CategoricalAggregator({
      selector: { kind: 'cell', columnId: 'field' },
      maxKeyLength: 4,
    });
    expect(aggregator.add(cellRow('field', 'safe'))).toBe(true);
    expect(aggregator.add(cellRow('field', 'too-long'))).toBe(true);
    expect(aggregator.finish().groups).toEqual([
      expect.objectContaining({ label: 'safe', count: 1 }),
      expect.objectContaining({ kind: 'unknown', count: 1 }),
    ]);
  });

  it('honors an AbortSignal before and during iteration', () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(() => new CategoricalAggregator({
      selector: { kind: 'cell', columnId: 'field' },
      signal: alreadyAborted.signal,
    })).toThrow(AggregationAbortedError);

    const controller = new AbortController();
    function* cancellableRows(): Iterable<RowProjection> {
      yield cellRow('field', 'one');
      controller.abort();
      yield cellRow('field', 'two');
    }
    expect(() => aggregateCategorical(cancellableRows(), {
      selector: { kind: 'cell', columnId: 'field' },
      signal: controller.signal,
    })).toThrowError(expect.objectContaining({ name: 'AbortError' }));
  });

  it('rejects limits that could bypass hard memory bounds', () => {
    expect(() => new CategoricalAggregator({ selector: { kind: 'cell', columnId: 'x' }, maxGroups: 3 })).toThrow(RangeError);
    expect(() => new CategoricalAggregator({
      selector: { kind: 'cell', columnId: 'x' },
      maxRecords: AGGREGATION_LIMITS.hardMaxRecords + 1,
    })).toThrow(RangeError);
    expect(() => new CategoricalAggregator({
      selector: { kind: 'cell', columnId: 'x' },
      maxKeyLength: AGGREGATION_LIMITS.hardMaxKeyLength + 1,
    })).toThrow(RangeError);
  });
});

describe('time bucket aggregation', () => {
  it('groups ISO timestamps chronologically and isolates invalid and missing values', () => {
    const result = aggregateTimeBuckets([
      projected({ timestamp: '2026-08-30T00:00:01.000Z' }),
      projected({ timestamp: '2026-08-30T00:00:59.999Z' }),
      projected({ timestamp: '2026-08-30T00:01:00.000Z' }),
      projected({ timestamp: 'not-a-time' }),
      row(),
    ], {
      bucketWidthMs: 60_000,
      timestampUnit: 'iso',
      maxBuckets: 6,
    });

    expect(result.buckets).toEqual([
      expect.objectContaining({ kind: 'time', label: '2026-08-30T00:00:00.000Z', count: 2 }),
      expect.objectContaining({ kind: 'time', label: '2026-08-30T00:01:00.000Z', count: 1 }),
      { id: 'unknown', kind: 'unknown', label: 'Unknown', count: 1 },
      { id: 'missing', kind: 'missing', label: 'Missing', count: 1 },
    ]);
    expect(result.meta).toMatchObject({ processedRecords: 5, capacityReached: false, resultCapacity: 6 });
  });

  it('parses decimal-string nanoseconds without converting the source integer through Number', () => {
    const result = aggregateTimeBuckets([
      projected({ timestamp: '1788062400000000000' }),
      projected({ timestamp: '1788062430000000000' }),
      projected({ timestamp: '1788062460000000000' }),
    ], {
      bucketWidthMs: 60_000,
      timestampUnit: 'ns',
      maxBuckets: 8,
    });

    expect(toTimestampMs('1788062400000000000', 'ns', 64)).toBe(1_788_062_400_000);
    expect(toTimestampMs('1788062400000000000', 'auto', 64)).toBe(1_788_062_400_000);
    expect(toTimestampMs(1_788_062_400_000_000_000, 'ns', 64)).toBeUndefined();
    expect(result.buckets).toEqual([
      expect.objectContaining({ kind: 'time', startMs: 1_788_062_400_000, count: 2 }),
      expect.objectContaining({ kind: 'time', startMs: 1_788_062_460_000, count: 1 }),
    ]);
  });

  it('caps observed buckets and retains exact Overflow, Unknown and Missing totals', () => {
    const result = aggregateTimeBuckets([
      projected({ timestamp: '2026-08-30T00:00:00.000Z' }),
      projected({ timestamp: '2026-08-30T00:01:00.000Z' }),
      projected({ timestamp: '2026-08-30T00:02:00.000Z' }),
      projected({ timestamp: 'bad' }),
      row(),
    ], {
      bucketWidthMs: 60_000,
      timestampUnit: 'iso',
      maxBuckets: 4,
    });

    expect(result.buckets).toHaveLength(4);
    expect(result.buckets).toEqual([
      expect.objectContaining({ kind: 'time', label: '2026-08-30T00:00:00.000Z', count: 1 }),
      { id: 'overflow', kind: 'overflow', label: 'Overflow', count: 2 },
      { id: 'unknown', kind: 'unknown', label: 'Unknown', count: 1 },
      { id: 'missing', kind: 'missing', label: 'Missing', count: 1 },
    ]);
    expect(result.meta.capacityReached).toBe(true);
  });

  it('supports selected cell timestamps and incremental record limits', () => {
    const aggregator = new TimeBucketAggregator({
      selector: { kind: 'cell', columnId: 'epoch' },
      bucketWidthMs: 1_000,
      timestampUnit: 's',
      maxRecords: 1,
    });
    expect(aggregator.add(cellRow('epoch', 1_788_062_400))).toBe(true);
    expect(aggregator.add(cellRow('epoch', 1_788_062_401))).toBe(false);
    const result = aggregator.finish();
    expect(result.meta).toMatchObject({ processedRecords: 1, truncatedByRecordLimit: true });
    expect(result.buckets[0]).toMatchObject({ startMs: 1_788_062_400_000, count: 1 });
  });

  it('rejects invalid bucket and bucket-capacity limits', () => {
    expect(() => new TimeBucketAggregator({ bucketWidthMs: 0 })).toThrow(RangeError);
    expect(() => new TimeBucketAggregator({ bucketWidthMs: 1_000, maxBuckets: 3 })).toThrow(RangeError);
  });
});

function projected(overrides: Partial<AgentRowProjection>): RowProjection {
  const profile: AgentRowProjection = {
    profileId: 'test',
    eventKind: 'message',
    summary: 'test',
    evidence: [],
    confidence: 'source',
    ...overrides,
  };
  return row([], profile);
}

function cellRow(columnId: string, value: JsonScalar): RowProjection {
  return row([{ columnId, value }]);
}

function row(cells: CellProjection[] = [], profile?: AgentRowProjection): RowProjection {
  const value: RowProjection = {
    ref: {
      generation: 'g1',
      ordinal: '1',
      byteStart: '0',
      byteEndExclusive: '1',
      contentByteLength: '1',
      delimiterByteLength: 1,
      parseState: 'valid',
    },
    cells,
    genericSummary: 'test',
  };
  if (profile) value.profile = profile;
  return value;
}
