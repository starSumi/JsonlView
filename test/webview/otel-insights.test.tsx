import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { summarizeOpenTelemetryRecord, aggregateOpenTelemetrySummaries } from '../../src/shared/otel-insights';
import { OpenTelemetryInsights } from '../../src/webview/widgets/insights-panel/otel-insights';

describe('OpenTelemetryInsights', () => {
  it('renders bounded signal, nested-record, service, and operation observations', () => {
    const summary = aggregateOpenTelemetrySummaries([
      summarizeOpenTelemetryRecord({
        resourceSpans: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout-service' } }] },
          scopeSpans: [{ spans: [{ name: 'checkout', traceId: 'trace-1', spanId: 'span-1', startTimeUnixNano: '0', endTimeUnixNano: '1000000' }] }],
        }],
      }),
    ], { partial: true, requestedRecords: 4 });
    const markup = renderToStaticMarkup(React.createElement(OpenTelemetryInsights, { summary }));

    expect(markup).toContain('OpenTelemetry insights');
    expect(markup).toContain('Signals');
    expect(markup).toContain('Nested records');
    expect(markup).toContain('checkout-service');
    expect(markup).toContain('checkout');
    expect(markup).toContain('data-insight-kind="opentelemetry"');
    expect(markup).toContain('partial sample');
  });
});
