import { describe, expect, it } from 'vitest';
import type { AgentRowProjection } from '../../src/shared/types';
import { AgentProfileRegistry, type GenericRecordSample } from '../../src/profiles';
import {
  ordinaryJsonlFixture,
  otelEnvelopeFixture,
  otelFixture,
  softwareEngineeringAgentFixture,
  softwareEngineeringTrajectoryFixture,
  structuredApplicationLogFixture,
} from './fixtures';

const context = { generation: 'generation-domain-profiles' };
const samples = (values: readonly unknown[]): GenericRecordSample[] => values.map((value, index) => ({ value, ordinal: String(index + 1) }));
const derived = (projection: AgentRowProjection): Record<string, unknown> => projection.derivedFields ?? {};

describe('OpenTelemetry profile', () => {
  it('detects individual OTel logs and spans from protocol-specific field combinations', () => {
    const decision = new AgentProfileRegistry().detect(samples(otelFixture));

    expect(decision.selectedProfileId).toBe('opentelemetry');
    expect(decision.detections.find((item) => item.profileId === 'opentelemetry')).toMatchObject({ requiredEvidenceMet: true });
  });

  it('detects File Exporter envelopes but summarizes containers without inventing child rows', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples(otelEnvelopeFixture)).selectedProfileId).toBe('opentelemetry');

    const logs = registry.project('opentelemetry', { value: otelEnvelopeFixture[0] }, context);
    const spans = registry.project('opentelemetry', { value: otelEnvelopeFixture[1] }, context);
    expect(logs).toMatchObject({ eventKind: 'log', summary: 'OTLP logs envelope: 1 resource group' });
    expect(derived(logs)).toMatchObject({ containerKind: 'resourceLogs', resourceGroupCount: 1, service: 'api-service' });
    expect(derived(logs)).not.toHaveProperty('traceId');
    expect(derived(logs)).not.toHaveProperty('spanId');
    expect(spans).toMatchObject({ eventKind: 'span', summary: 'OTLP spans envelope: 2 resource groups' });
    expect(derived(spans)).toMatchObject({ containerKind: 'resourceSpans', resourceGroupCount: 2, service: 'worker-service' });
  });

  it('projects log/span semantics, keeps unknown records, and preserves decimal nanoseconds as strings', () => {
    const registry = new AgentProfileRegistry();
    const rows = otelFixture.map((value) => registry.project('opentelemetry', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual(['span', 'span', 'log', 'log', 'other']);
    expect(rows[0]).toMatchObject({
      timestamp: '1788062400000000000',
      sessionId: 'trace-redacted',
      turnId: 'span-root',
      messageId: 'span-root',
      status: 'STATUS_CODE_OK',
    });
    expect(derived(rows[0]!)).toMatchObject({
      traceId: 'trace-redacted', spanId: 'span-root', name: 'checkout', service: 'checkout-service',
    });
    expect(rows[1]).toMatchObject({ parentId: 'span-root', severity: 'error' });
    expect(derived(rows[1]!)).toMatchObject({ parentSpanId: 'span-root', spanStatus: 'STATUS_CODE_ERROR: redacted query failure' });
    expect(rows[2]).toMatchObject({ parentId: 'span-child', severity: 'ERROR' });
    expect(derived(rows[2]!)).toMatchObject({
      body: 'database call failed',
      eventName: 'exception',
      service: 'checkout-service',
      instrumentationScope: 'checkout.instrumentation@1.0.0',
      attributeCount: 1,
    });
    expect(rows[2]?.evidence).toContainEqual({
      field: 'service',
      path: {
        tokens: [
          { kind: 'key', value: 'resource' },
          { kind: 'key', value: 'attributes' },
          { kind: 'index', value: 0 },
          { kind: 'key', value: 'value' },
        ],
      },
    });
    expect(rows[4]).toMatchObject({ profileId: 'opentelemetry', eventKind: 'other' });
  });

  it('maps numeric OTel error severity and status codes', () => {
    const registry = new AgentProfileRegistry();
    const log = registry.project('opentelemetry', { value: {
      timeUnixNano: '1788062400020000000',
      severityNumber: 17,
      body: { stringValue: 'numeric severity' },
    } }, context);
    const span = registry.project('opentelemetry', { value: {
      traceId: 'trace-numeric',
      spanId: 'span-numeric',
      name: 'numeric status',
      startTimeUnixNano: '1788062400020000000',
      endTimeUnixNano: '1788062400030000000',
      status: { code: 2 },
    } }, context);

    expect(log).toMatchObject({ eventKind: 'log', severity: '17' });
    expect(span).toMatchObject({ eventKind: 'span', severity: 'error', status: '2' });
  });

  it('correlates span parent-child and log-to-span only from explicit IDs', () => {
    const registry = new AgentProfileRegistry();
    const inputs = otelFixture.slice(0, 3).map((value, index) => ({
      recordKey: String(index + 1),
      projection: registry.project('opentelemetry', { value }, { generation: 'otel-correlation' }),
    }));
    const result = registry.correlate('opentelemetry', 'otel-correlation', inputs);

    expect(result.records).toHaveLength(3);
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'parent_child', stableId: 'span-root', sourceRecordKey: '1', targetRecordKey: '2' }),
      expect.objectContaining({ kind: 'parent_child', stableId: 'span-child', sourceRecordKey: '2', targetRecordKey: '3' }),
      expect.objectContaining({ kind: 'session_member', stableId: 'trace-redacted' }),
    ]));
  });

  it('does not treat an ordinary trace-correlated application log as OTel', () => {
    const values = [{
      timestamp: '2026-08-30T04:30:00.000Z',
      level: 'info',
      message: 'ordinary service log',
      traceId: 'trace-redacted',
      spanId: 'span-redacted',
    }];
    const decision = new AgentProfileRegistry().detect(samples(values));

    expect(decision.selectedProfileId).toBe('structured-application-log');
    expect(decision.detections.find((item) => item.profileId === 'opentelemetry')).toMatchObject({ requiredEvidenceMet: false });
  });
});

describe('Software engineering Agent profile', () => {
  it('detects vendor-neutral trajectory events and containers', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples(softwareEngineeringAgentFixture)).selectedProfileId).toBe('software-engineering-agent');
    expect(registry.detect(samples(softwareEngineeringTrajectoryFixture)).selectedProfileId).toBe('software-engineering-agent');
  });

  it('projects task, step, tool and outcome while conserving unknown events', () => {
    const registry = new AgentProfileRegistry();
    const rows = softwareEngineeringAgentFixture.map((value) => registry.project('software-engineering-agent', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual(['task', 'action', 'observation', 'patch', 'test', 'other']);
    expect(rows[1]).toMatchObject({ sessionId: 'task-redacted', turnId: '1', toolCallId: 'call-redacted', actor: 'agent' });
    expect(derived(rows[1]!)).toMatchObject({ task: 'task-redacted', step: '1', tool: 'shell', action: 'pnpm test' });
    expect(derived(rows[3]!)).toMatchObject({ patch: 'diff --git a/redacted b/redacted', parentStep: '1' });
    expect(rows[4]).toMatchObject({ status: 'success' });
    expect(derived(rows[4]!)).toMatchObject({ outcome: 'success' });
    expect(rows[5]).toMatchObject({ profileId: 'software-engineering-agent', eventKind: 'other' });
  });

  it('summarizes a multi-step trajectory as one container projection', () => {
    const row = new AgentProfileRegistry().project(
      'software-engineering-agent',
      { value: softwareEngineeringTrajectoryFixture[0] },
      context,
    );
    expect(row).toMatchObject({ eventKind: 'task', summary: 'Trajectory container: 3 steps' });
    expect(derived(row)).toMatchObject({ containerKind: 'trajectory', stepCount: 3 });
    expect(derived(row)).not.toHaveProperty('action');
    expect(derived(row)).not.toHaveProperty('observation');
  });

  it('correlates explicit task, step-parent and tool-call identities', () => {
    const registry = new AgentProfileRegistry();
    const inputs = softwareEngineeringAgentFixture.slice(0, 5).map((value, index) => ({
      recordKey: String(index + 1),
      projection: registry.project('software-engineering-agent', { value }, { generation: 'swe-correlation' }),
    }));
    const result = registry.correlate('software-engineering-agent', 'swe-correlation', inputs);

    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_pair', stableId: 'call-redacted' }),
      expect.objectContaining({ kind: 'parent_child', stableId: '1', sourceRecordKey: '2', targetRecordKey: '4' }),
      expect.objectContaining({ kind: 'parent_child', stableId: '2', sourceRecordKey: '4', targetRecordKey: '5' }),
      expect.objectContaining({ kind: 'session_member', stableId: 'task-redacted' }),
    ]));
  });

  it('does not classify ordinary domain JSON as a software-engineering Agent trajectory', () => {
    const decision = new AgentProfileRegistry().detect(samples([
      ...ordinaryJsonlFixture,
      { task: 'shipping', step: 2, result: 'packed' },
    ]));
    expect(decision.detections.find((item) => item.profileId === 'software-engineering-agent')).toMatchObject({ requiredEvidenceMet: false });
    expect(decision.selectedProfileId).toBe('generic');
  });
});

describe('Structured application log profile', () => {
  it('detects Pino/Winston/Serilog/log4j2/ECS/GCP-style log semantics without vendor identity', () => {
    const decision = new AgentProfileRegistry().detect(samples(structuredApplicationLogFixture));
    expect(decision.selectedProfileId).toBe('structured-application-log');
    expect(decision.detections.find((item) => item.profileId === 'opentelemetry')).toMatchObject({ requiredEvidenceMet: false });
  });

  it('projects time, severity, message source, request and trace correlations, and exceptions', () => {
    const registry = new AgentProfileRegistry();
    const rows = structuredApplicationLogFixture.map((value) => registry.project('structured-application-log', { value }, context));

    expect(rows.map((row) => row.eventKind)).toEqual(['log', 'log', 'log', 'log', 'other']);
    expect(rows[0]).toMatchObject({ timestamp: '1788069600000', severity: 'info', sessionId: 'correlation-redacted' });
    expect(derived(rows[0]!)).toMatchObject({ logger: 'api', requestId: 'request-redacted', correlationId: 'correlation-redacted' });
    expect(rows[1]).toMatchObject({ severity: 'WARN', sessionId: 'trace-log-redacted', turnId: 'span-log-redacted' });
    expect(derived(rows[1]!)).toMatchObject({ logger: 'checkout.handler', service: 'checkout-service', traceId: 'trace-log-redacted' });
    expect(derived(rows[2]!)).toMatchObject({ exception: 'System.InvalidOperationException: redacted' });
    expect(derived(rows[3]!)).toMatchObject({ traceId: 'gcp-trace-redacted', spanId: 'gcp-span-redacted' });
    expect(rows[4]).toMatchObject({ profileId: 'structured-application-log', eventKind: 'other' });
  });

  it('correlates a traditional request chain only through explicit stable IDs', () => {
    const registry = new AgentProfileRegistry();
    const inputs = [structuredApplicationLogFixture[0], structuredApplicationLogFixture[2]].map((value, index) => ({
      recordKey: String(index + 1),
      projection: registry.project('structured-application-log', { value }, { generation: 'log-correlation' }),
    }));
    const result = registry.correlate('structured-application-log', 'log-correlation', inputs);
    expect(result.relations).toEqual([
      expect.objectContaining({ kind: 'session_member', stableId: 'correlation-redacted' }),
    ]);
  });

  it('recognizes an exception-only log and rejects arbitrary message-like JSON', () => {
    const registry = new AgentProfileRegistry();
    expect(registry.detect(samples([{
      timestamp: '2026-08-30T06:30:00.000Z',
      level: 'error',
      logger: 'worker',
      exception: { message: 'redacted', stack: 'redacted stack' },
    }])).selectedProfileId).toBe('structured-application-log');

    const ordinary = registry.detect(samples([
      { timestamp: '2026-08-30', message: 'newsletter copy', traceId: 'customer-field' },
      { level: 'gold', message: 'subscription tier', source: 'catalog' },
      ...ordinaryJsonlFixture,
    ]));
    expect(ordinary.detections.find((item) => item.profileId === 'structured-application-log')).toMatchObject({ requiredEvidenceMet: false });
    expect(ordinary.selectedProfileId).toBe('generic');
  });
});
