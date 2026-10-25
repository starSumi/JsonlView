import { describe, expect, it } from 'vitest';
import { buildAgentEventPresentation } from '../../src/webview/providers/agent-event-presentation';
import { buildOpenTelemetryEventSections } from '../../src/webview/providers/otel-event-builder';
import type { AgentRowProjection } from '../../src/shared/types';

const profile = (derivedFields: AgentRowProjection['derivedFields'] = {}): AgentRowProjection => ({
  profileId: 'opentelemetry',
  eventKind: 'span',
  summary: 'OTLP spans envelope',
  evidence: [],
  confidence: 'source',
  derivedFields,
});

describe('OpenTelemetry detail projection', () => {
  it('renders envelope semantics without flattening or copying raw attributes', () => {
    const value = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout-service' } }] },
        scopeSpans: [{ spans: [
          { name: 'checkout', traceId: 'trace-1', spanId: 'span-1' },
          { name: 'database.query', traceId: 'trace-1', spanId: 'span-2' },
        ] }],
      }],
    };
    const sections = buildOpenTelemetryEventSections(value, value, profile({
      nestedCount: 2,
      service: 'checkout-service',
      operation: 'checkout',
      traceCount: 1,
      errorCount: 0,
      durationMs: 12,
    }));

    expect(sections).toEqual([expect.objectContaining({
      title: 'OTLP envelope',
      text: expect.stringContaining('Nested span records: 2'),
    })]);
    expect(sections[0]?.text).toContain('Service: checkout-service');
    expect(sections[0]?.text).toContain('Operation: checkout');
    expect(sections[0]?.text).toContain('Names: checkout, database.query');
    expect(sections[0]?.text).not.toContain('service.name');
    expect(sections[0]?.text).not.toContain('trace-1');
  });

  it('renders metrics as a semantic signal with bounded point counts', () => {
    const value = {
      resourceMetrics: [{
        scopeMetrics: [{ metrics: [{ name: 'request.duration', gauge: { dataPoints: [{ asDouble: 1 }] } }] }],
      }],
    };
    const sections = buildOpenTelemetryEventSections(value, value, profile({ metricCount: 1, dataPointCount: 1 }));
    expect(sections[0]?.text).toContain('Signal: metric');
    expect(sections[0]?.text).toContain('Nested metric records: 1');
  });

  it('routes the detail model to the OpenTelemetry strategy', () => {
    const model = buildAgentEventPresentation({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'checkout', traceId: 'trace-1', spanId: 'span-1' }] }] }],
    }, profile({ nestedCount: 1, operation: 'checkout' }));
    expect(model?.title).toBe('OpenTelemetry · span');
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'OTLP envelope' }),
    ]));
  });
});
