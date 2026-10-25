import type { AgentRowProjection } from '@shared/types';
import type { EventPresentationSection } from '@features/event-presentation/model';

const MAX_NAMES = 8;
const MAX_TEXT = 360;

/**
 * Renders the semantic part of an OTLP JSONL row without flattening nested
 * spans or copying arbitrary resource attributes into the presentation model.
 * Raw remains the source of truth for the complete envelope.
 */
export function buildOpenTelemetryEventSections(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
  profile: AgentRowProjection | undefined,
): EventPresentationSection[] {
  const envelopeKind = signalKind(envelope);
  if (envelopeKind !== undefined) return envelopeSections(envelope, profile);
  const source = firstSignalObject(envelope) ?? firstSignalObject(payload);
  const kind = profile?.eventKind ?? signalKind(envelope) ?? signalKind(payload) ?? 'event';
  if (source === undefined && profile?.profileId === 'opentelemetry') {
    return [{ title: 'OTLP signal', text: `OpenTelemetry ${kind} record` }];
  }
  if (source === undefined) return [];

  if (kind === 'span' || hasSpanIdentity(source)) return spanSections(source, profile);
  if (kind === 'log' || hasLogIdentity(source)) return logSections(source, profile);
  if (kind === 'metric' || hasMetricIdentity(source)) return metricSections(source, profile);
  return [];
}

function envelopeSections(value: Record<string, unknown>, profile: AgentRowProjection | undefined): EventPresentationSection[] {
  const kind = signalKind(value) ?? profile?.eventKind ?? 'event';
  const groups = signalGroups(value, kind);
  const scopes = groups.reduce((total, group) => total + scopeCount(group, kind), 0);
  const items = groups.reduce((total, group) => total + signalCount(group, kind), 0);
  const names = groups.flatMap((group) => signalNames(group, kind)).slice(0, MAX_NAMES);
  const derived = profile?.derivedFields;
  const lines = [
    `Signal: ${kind}`,
    `Resource groups: ${String(groups.length)}`,
    `Instrumentation scopes: ${String(scopes)}`,
    `Nested ${kind} records: ${String(items)}`,
    ...(derived?.service === undefined ? [] : [`Service: ${String(derived.service)}`]),
    ...(derived?.operation === undefined ? [] : [`Operation: ${String(derived.operation)}`]),
    ...(derived?.traceCount === undefined ? [] : [`Traces: ${String(derived.traceCount)}`]),
    ...(derived?.errorCount === undefined ? [] : [`Errors: ${String(derived.errorCount)}`]),
    ...(derived?.durationMs === undefined ? [] : [`Duration: ${String(derived.durationMs)} ms`]),
    ...(names.length > 0 ? [`Names: ${names.join(', ')}`] : []),
  ];
  return [{ title: 'OTLP envelope', text: lines.join('\n') }];
}

function spanSections(value: Record<string, unknown>, profile: AgentRowProjection | undefined): EventPresentationSection[] {
  const fields = [
    ['Name', scalar(value, 'name') ?? scalar(value, 'Name')],
    ['Trace ID', profile?.derivedFields?.traceId?.toString() ?? scalar(value, 'traceId') ?? scalar(value, 'TraceId')],
    ['Span ID', profile?.derivedFields?.spanId?.toString() ?? scalar(value, 'spanId') ?? scalar(value, 'SpanId')],
    ['Parent span', profile?.derivedFields?.parentSpanId?.toString() ?? scalar(value, 'parentSpanId') ?? scalar(value, 'ParentSpanId')],
    ['Status', profile?.status ?? scalar(value, 'status') ?? scalar(value, 'Status')],
    ['Duration', durationText(value)],
    ['Attributes', profile?.derivedFields?.attributeCount?.toString() ?? attributeCount(value)],
  ].filter(([, value]) => value !== undefined);
  return [{ title: 'Span', text: fields.map(([label, item]) => `${label}: ${item}`).join('\n') }];
}

function logSections(value: Record<string, unknown>, profile: AgentRowProjection | undefined): EventPresentationSection[] {
  const body = scalar(value, 'body') ?? scalar(value, 'Body') ?? profile?.derivedFields?.body?.toString();
  const fields = [
    ['Body', body],
    ['Event', scalar(value, 'eventName') ?? scalar(value, 'EventName') ?? profile?.derivedFields?.eventName?.toString()],
    ['Severity', profile?.severity ?? scalar(value, 'severityText') ?? scalar(value, 'SeverityText')],
    ['Trace ID', profile?.derivedFields?.traceId?.toString() ?? scalar(value, 'traceId')],
    ['Span ID', profile?.derivedFields?.spanId?.toString() ?? scalar(value, 'spanId')],
    ['Attributes', profile?.derivedFields?.attributeCount?.toString() ?? attributeCount(value)],
  ].filter(([, value]) => value !== undefined);
  return [{ title: 'Log record', text: fields.map(([label, item]) => `${label}: ${item}`).join('\n') }];
}

function metricSections(value: Record<string, unknown>, profile: AgentRowProjection | undefined): EventPresentationSection[] {
  const fields = [
    ['Name', scalar(value, 'name') ?? scalar(value, 'Name')],
    ['Description', scalar(value, 'description') ?? scalar(value, 'Description')],
    ['Unit', scalar(value, 'unit') ?? scalar(value, 'Unit')],
    ['Aggregation', metricAggregation(value)],
    ['Data points', profile?.derivedFields?.dataPointCount?.toString() ?? metricPointCount(value)],
  ].filter(([, value]) => value !== undefined);
  return [{ title: 'Metric', text: fields.map(([label, item]) => `${label}: ${item}`).join('\n') }];
}

function firstSignalObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ['resourceSpans', 'resourceLogs', 'resourceMetrics', 'span', 'log', 'metric']) {
    const candidate = value[key];
    if (isRecord(candidate)) return candidate;
    if (Array.isArray(candidate)) {
      const first = candidate.find(isRecord);
      if (first) return first;
    }
  }
  return value;
}

function signalKind(value: Record<string, unknown>): string | undefined {
  if (Array.isArray(value.resourceSpans)) return 'span';
  if (Array.isArray(value.resourceLogs)) return 'log';
  if (Array.isArray(value.resourceMetrics)) return 'metric';
  return undefined;
}

function signalGroups(value: Record<string, unknown>, kind: string): Record<string, unknown>[] {
  const key = kind === 'span' ? 'resourceSpans' : kind === 'log' ? 'resourceLogs' : 'resourceMetrics';
  return Array.isArray(value[key]) ? value[key].filter(isRecord).slice(0, 64) : [];
}

function scopeCount(group: Record<string, unknown>, kind: string): number {
  const key = kind === 'span' ? 'scopeSpans' : kind === 'log' ? 'scopeLogs' : 'scopeMetrics';
  return Array.isArray(group[key]) ? group[key].filter(isRecord).length : 0;
}

function signalCount(group: Record<string, unknown>, kind: string): number {
  const scopeKey = kind === 'span' ? 'scopeSpans' : kind === 'log' ? 'scopeLogs' : 'scopeMetrics';
  const signalKey = kind === 'span' ? 'spans' : kind === 'log' ? 'logRecords' : 'metrics';
  const scopes = Array.isArray(group[scopeKey]) ? group[scopeKey].filter(isRecord) : [];
  return scopes.reduce((total, scope) => total + (Array.isArray(scope[signalKey]) ? scope[signalKey].length : 0), 0);
}

function signalNames(group: Record<string, unknown>, kind: string): string[] {
  const scopeKey = kind === 'span' ? 'scopeSpans' : kind === 'log' ? 'scopeLogs' : 'scopeMetrics';
  const signalKey = kind === 'span' ? 'spans' : kind === 'log' ? 'logRecords' : 'metrics';
  const scopes = Array.isArray(group[scopeKey]) ? group[scopeKey].filter(isRecord) : [];
  return scopes.flatMap((scope) => (Array.isArray(scope[signalKey]) ? scope[signalKey] : []))
    .filter(isRecord)
    .map((item) => scalar(item, 'name') ?? scalar(item, 'Name'))
    .filter((name): name is string => name !== undefined)
    .map((name) => bounded(name));
}

function hasSpanIdentity(value: Record<string, unknown>): boolean {
  return scalar(value, 'traceId') !== undefined && scalar(value, 'spanId') !== undefined;
}

function hasLogIdentity(value: Record<string, unknown>): boolean {
  return value.body !== undefined || value.Body !== undefined;
}

function hasMetricIdentity(value: Record<string, unknown>): boolean {
  return value.gauge !== undefined || value.sum !== undefined || value.histogram !== undefined
    || value.exponentialHistogram !== undefined || value.summary !== undefined;
}

function metricAggregation(value: Record<string, unknown>): string | undefined {
  for (const key of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary']) {
    if (value[key] !== undefined) return key;
  }
  return undefined;
}

function metricPointCount(value: Record<string, unknown>): string | undefined {
  const point = Object.values(value).find((candidate) => isRecord(candidate) && (
    candidate.dataPoints !== undefined || candidate.data_points !== undefined
  ));
  if (!isRecord(point)) return undefined;
  const points = point.dataPoints ?? point.data_points;
  return Array.isArray(points) ? String(points.length) : undefined;
}

function durationText(value: Record<string, unknown>): string | undefined {
  const start = scalar(value, 'startTimeUnixNano') ?? scalar(value, 'StartTime');
  const end = scalar(value, 'endTimeUnixNano') ?? scalar(value, 'EndTime');
  if (start === undefined || end === undefined) return undefined;
  try {
    const duration = BigInt(end) - BigInt(start);
    return duration >= 0n ? `${duration.toString()} ns` : undefined;
  } catch {
    return undefined;
  }
}

function attributeCount(value: Record<string, unknown>): string | undefined {
  const attributes = value.attributes ?? value.Attributes;
  return Array.isArray(attributes) ? String(attributes.length) : undefined;
}

function scalar(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (typeof candidate === 'string' && candidate.length > 0) return bounded(candidate);
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  if (typeof candidate === 'boolean') return String(candidate);
  if (isRecord(candidate)) {
    for (const nested of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
      const result = scalar(candidate, nested);
      if (result !== undefined) return result;
    }
  }
  return undefined;
}

function bounded(value: string): string {
  return value.length <= MAX_TEXT ? value : value.slice(0, MAX_TEXT - 1) + '…';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
