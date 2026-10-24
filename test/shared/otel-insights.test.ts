import { describe, expect, it } from 'vitest';
import { summarizeOpenTelemetryRecord } from '../../src/shared/otel-insights';
import { isOpenTelemetryRecordSummary } from '../../src/shared/transport/otel-insights';

describe('OpenTelemetry row insights', () => {
  it('accepts the bounded record contract and rejects payload leakage', () => {
    const summary = summarizeOpenTelemetryRecord({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'service' } }] },
        scopeSpans: [{ spans: [{ traceId: 't', spanId: 's', name: 'span', startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000' }] }],
      }],
    });
    expect(isOpenTelemetryRecordSummary(summary)).toBe(true);
    expect(Object.keys(summary)).not.toContain('attributes');
    expect(Object.keys(summary)).not.toContain('body');
    expect(isOpenTelemetryRecordSummary({ ...summary, raw: 'private' })).toBe(false);
    expect(isOpenTelemetryRecordSummary({ ...summary, spanCount: -1 })).toBe(false);
  });

  it('bounds service and nested signal observations', () => {
    const summary = summarizeOpenTelemetryRecord({
      resourceMetrics: [{ resource: {}, scopeMetrics: [{ metrics: [{ name: 'gauge', gauge: { dataPoints: [] } }] }] }],
    });
    expect(summary).toMatchObject({ recognized: true, signal: 'metrics', metricCount: 1, dataPointCount: 0 });
    expect(summary.services).toEqual([]);
  });
});
