/**
 * Bounded semantic observations for one OTLP File Exporter JSONL record.
 *
 * The physical JSONL row remains authoritative. These counters are a
 * projection only: nested spans, logs, metrics, and data points are never
 * emitted as additional rows and attribute/body values never cross IPC.
 */
export const OPEN_TELEMETRY_ADAPTER_ID = 'opentelemetry' as const;
export const OPEN_TELEMETRY_ADAPTER_VERSION = '1.0.0' as const;

export const OPEN_TELEMETRY_LIMITS = Object.freeze({
  resourceGroups: 64,
  scopes: 128,
  signalItems: 2048,
  traces: 512,
  services: 16,
  serviceNameLength: 96,
});

export type OpenTelemetrySignal = 'logs' | 'spans' | 'metrics' | 'unknown';
export type OpenTelemetryContainerKind = 'record' | 'resourceLogs' | 'resourceSpans' | 'resourceMetrics';
export type OpenTelemetrySpanKind = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer' | 'unknown';
export type OpenTelemetryMetricKind = 'gauge' | 'sum' | 'histogram' | 'exponentialHistogram' | 'summary' | 'unknown';

export type OpenTelemetrySpanKindCounts = Record<OpenTelemetrySpanKind, number>;
export type OpenTelemetryMetricKindCounts = Record<OpenTelemetryMetricKind, number>;

export interface OpenTelemetryRecordSummary {
  version: 1;
  adapterId: typeof OPEN_TELEMETRY_ADAPTER_ID;
  adapterVersion: typeof OPEN_TELEMETRY_ADAPTER_VERSION;
  recognized: boolean;
  valid: boolean;
  signal: OpenTelemetrySignal;
  containerKind: OpenTelemetryContainerKind;
  resourceGroupCount: number;
  scopeCount: number;
  spanCount: number;
  traceCount: number;
  logCount: number;
  metricCount: number;
  dataPointCount: number;
  errorCount: number;
  /** Sum of bounded span durations, rounded down to milliseconds. */
  durationMs: number;
  spanKinds: OpenTelemetrySpanKindCounts;
  metricKinds: OpenTelemetryMetricKindCounts;
  services: string[];
  truncated: boolean;
}

const SPAN_KINDS: readonly OpenTelemetrySpanKind[] = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer', 'unknown'];
const METRIC_KINDS: readonly OpenTelemetryMetricKind[] = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary', 'unknown'];
const traceSets = new WeakMap<OpenTelemetryRecordSummary, Set<string>>();
const signalBudgets = new WeakMap<OpenTelemetryRecordSummary, number>();

/**
 * Summarize OTLP JSON shapes without retaining arbitrary payload data.
 * Unknown or malformed records remain recognized=false and are safe to show
 * through the generic JSONL projection.
 */
export function summarizeOpenTelemetryRecord(value: unknown): OpenTelemetryRecordSummary {
  const summary = emptySummary();
  if (!isObject(value)) return summary;

  if (hasEnvelopeEvidence(value, 'resourceSpans', 'scopeSpans', 'spans')) {
    summary.recognized = true;
    summary.valid = true;
    summary.signal = 'spans';
    summary.containerKind = 'resourceSpans';
    summarizeEnvelope(value, 'resourceSpans', 'scopeSpans', 'spans', summary, summarizeSpan);
    return summary;
  }
  if (hasEnvelopeEvidence(value, 'resourceLogs', 'scopeLogs', 'logRecords')) {
    summary.recognized = true;
    summary.valid = true;
    summary.signal = 'logs';
    summary.containerKind = 'resourceLogs';
    summarizeEnvelope(value, 'resourceLogs', 'scopeLogs', 'logRecords', summary, summarizeLog);
    return summary;
  }
  if (hasEnvelopeEvidence(value, 'resourceMetrics', 'scopeMetrics', 'metrics')) {
    summary.recognized = true;
    summary.valid = true;
    summary.signal = 'metrics';
    summary.containerKind = 'resourceMetrics';
    summarizeEnvelope(value, 'resourceMetrics', 'scopeMetrics', 'metrics', summary, summarizeMetric);
    return summary;
  }
  if (isSpan(value)) {
    summary.recognized = true;
    summary.valid = true;
    summary.signal = 'spans';
    summary.containerKind = 'record';
    summarizeSpan(value, summary);
    return summary;
  }
  if (isLog(value)) {
    summary.recognized = true;
    summary.valid = true;
    summary.signal = 'logs';
    summary.containerKind = 'record';
    summarizeLog(value, summary);
    return summary;
  }
  if (isMetric(value)) {
    summary.recognized = true;
    summary.valid = true;
    summary.signal = 'metrics';
    summary.containerKind = 'record';
    summarizeMetric(value, summary);
  }
  return summary;
}

function summarizeEnvelope(
  value: Record<string, unknown>,
  envelopeKey: 'resourceSpans' | 'resourceLogs' | 'resourceMetrics',
  scopeKey: 'scopeSpans' | 'scopeLogs' | 'scopeMetrics',
  itemKey: 'spans' | 'logRecords' | 'metrics',
  summary: OpenTelemetryRecordSummary,
  summarizeItem: (value: Record<string, unknown>, summary: OpenTelemetryRecordSummary) => void,
): void {
  const groups = ownArray(value, envelopeKey);
  if (groups === undefined) return;
  const boundedGroups = take(groups, OPEN_TELEMETRY_LIMITS.resourceGroups, summary);
  summary.resourceGroupCount = boundedGroups.length;
  for (const group of boundedGroups) {
    if (!isObject(group)) {
      summary.truncated = true;
      continue;
    }
    addServiceNames(group, summary);
    const scopes = ownArray(group, scopeKey);
    if (scopes === undefined) {
      summary.truncated = true;
      continue;
    }
    const boundedScopes = take(scopes, OPEN_TELEMETRY_LIMITS.scopes, summary);
    summary.scopeCount += boundedScopes.length;
    for (const scope of boundedScopes) {
      if (!isObject(scope)) {
        summary.truncated = true;
        continue;
      }
      const items = ownArray(scope, itemKey);
      if (items === undefined) {
        summary.truncated = true;
        continue;
      }
      const boundedItems = takeSignalItems(items, summary);
      for (const item of boundedItems) {
        if (!isObject(item)) {
          summary.truncated = true;
          continue;
        }
        summarizeItem(item, summary);
      }
    }
  }
}

function summarizeSpan(value: Record<string, unknown>, summary: OpenTelemetryRecordSummary): void {
  summary.spanCount += 1;
  const traceId = scalar(value, 'traceId') ?? scalar(value, 'TraceId');
  if (traceId !== undefined) addBoundedSet(summary, traceId);
  const kind = normalizeSpanKind(scalar(value, 'kind') ?? scalar(value, 'Kind'));
  summary.spanKinds[kind] += 1;
  if (spanHasError(value)) summary.errorCount += 1;
  const start = scalar(value, 'startTimeUnixNano') ?? scalar(value, 'StartTime');
  const end = scalar(value, 'endTimeUnixNano') ?? scalar(value, 'EndTime');
  if (start !== undefined && end !== undefined) summary.durationMs = addDuration(summary.durationMs, start, end);
}

function summarizeLog(value: Record<string, unknown>, summary: OpenTelemetryRecordSummary): void {
  summary.logCount += 1;
  const traceId = scalar(value, 'traceId') ?? scalar(value, 'TraceId');
  if (traceId !== undefined) addBoundedSet(summary, traceId);
  const severity = scalar(value, 'severityText') ?? scalar(value, 'SeverityText')
    ?? scalar(value, 'severityNumber') ?? scalar(value, 'SeverityNumber');
  if (severity !== undefined && /error|fatal/i.test(severity)) summary.errorCount += 1;
  const numericSeverity = Number(severity);
  if (Number.isFinite(numericSeverity) && numericSeverity >= 17) summary.errorCount += 1;
}

function summarizeMetric(value: Record<string, unknown>, summary: OpenTelemetryRecordSummary): void {
  summary.metricCount += 1;
  const kind = metricKind(value);
  summary.metricKinds[kind] += 1;
  for (const key of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary']) {
    const container = ownObject(value, key);
    if (container === undefined) continue;
    const points = ownArray(container, 'dataPoints') ?? ownArray(container, 'DataPoints');
    if (points !== undefined) summary.dataPointCount += takeSignalItems(points, summary).length;
    break;
  }
}

function hasEnvelopeEvidence(
  value: Record<string, unknown>,
  envelopeKey: 'resourceSpans' | 'resourceLogs' | 'resourceMetrics',
  scopeKey: 'scopeSpans' | 'scopeLogs' | 'scopeMetrics',
  itemKey: 'spans' | 'logRecords' | 'metrics',
): boolean {
  const groups = ownArray(value, envelopeKey);
  if (groups === undefined || groups.length === 0) return false;
  return groups.some((group) => isObject(group)
    && ownArray(group, scopeKey)?.some((scope) => isObject(scope)
      && (ownArray(scope, itemKey)?.length ?? 0) > 0) === true);
}

function isSpan(value: Record<string, unknown>): boolean {
  const lower = scalar(value, 'traceId') !== undefined && scalar(value, 'spanId') !== undefined && scalar(value, 'name') !== undefined;
  const lowerTime = scalar(value, 'startTimeUnixNano') !== undefined
    && (scalar(value, 'endTimeUnixNano') !== undefined || own(value, 'status') !== undefined || own(value, 'kind') !== undefined);
  const upper = scalar(value, 'TraceId') !== undefined && scalar(value, 'SpanId') !== undefined && scalar(value, 'Name') !== undefined;
  const upperTime = scalar(value, 'StartTime') !== undefined
    && (scalar(value, 'EndTime') !== undefined || own(value, 'Status') !== undefined);
  return (lower && lowerTime) || (upper && upperTime);
}

function isLog(value: Record<string, unknown>): boolean {
  const lowerTime = scalar(value, 'timeUnixNano') !== undefined || scalar(value, 'observedTimeUnixNano') !== undefined;
  const upperTime = scalar(value, 'Timestamp') !== undefined || scalar(value, 'ObservedTimestamp') !== undefined;
  const lowerBody = own(value, 'body') !== undefined;
  const upperBody = own(value, 'Body') !== undefined;
  const metadata = scalar(value, 'severityText') !== undefined || scalar(value, 'severityNumber') !== undefined
    || scalar(value, 'SeverityText') !== undefined || scalar(value, 'SeverityNumber') !== undefined;
  return (lowerBody && lowerTime && metadata) || (upperBody && upperTime && metadata);
}

function isMetric(value: Record<string, unknown>): boolean {
  const name = scalar(value, 'name') ?? scalar(value, 'Name');
  return name !== undefined && metricKind(value) !== 'unknown';
}

function metricKind(value: Record<string, unknown>): OpenTelemetryMetricKind {
  for (const kind of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'] as const) {
    if (ownObject(value, kind) !== undefined || ownObject(value, capitalize(kind)) !== undefined) return kind;
  }
  return 'unknown';
}

function normalizeSpanKind(value: string | undefined): OpenTelemetrySpanKind {
  if (value === undefined) return 'unspecified';
  const normalized = value.toLowerCase();
  if (normalized === '0' || normalized === 'unspecified') return 'unspecified';
  if (normalized === '1' || normalized === 'internal') return 'internal';
  if (normalized === '2' || normalized === 'server') return 'server';
  if (normalized === '3' || normalized === 'client') return 'client';
  if (normalized === '4' || normalized === 'producer') return 'producer';
  if (normalized === '5' || normalized === 'consumer') return 'consumer';
  return 'unknown';
}

function spanHasError(value: Record<string, unknown>): boolean {
  const status = ownObject(value, 'status') ?? ownObject(value, 'Status');
  if (status !== undefined) {
    const code = scalar(status, 'code') ?? scalar(status, 'Code');
    if (code !== undefined && (/error|fatal/i.test(code) || code === '2')) return true;
  }
  return false;
}

function addDuration(current: number, start: string, end: string): number {
  try {
    const startValue = BigInt(start);
    const endValue = BigInt(end);
    if (endValue <= startValue) return current;
    const millis = Number((endValue - startValue) / 1_000_000n);
    if (!Number.isSafeInteger(millis) || millis < 0) return Number.MAX_SAFE_INTEGER;
    return Math.min(Number.MAX_SAFE_INTEGER, current + millis);
  } catch {
    return current;
  }
}

function emptySummary(): OpenTelemetryRecordSummary {
  return {
    version: 1,
    adapterId: OPEN_TELEMETRY_ADAPTER_ID,
    adapterVersion: OPEN_TELEMETRY_ADAPTER_VERSION,
    recognized: false,
    valid: false,
    signal: 'unknown',
    containerKind: 'record',
    resourceGroupCount: 0,
    scopeCount: 0,
    spanCount: 0,
    traceCount: 0,
    logCount: 0,
    metricCount: 0,
    dataPointCount: 0,
    errorCount: 0,
    durationMs: 0,
    spanKinds: emptyCounts(SPAN_KINDS),
    metricKinds: emptyCounts(METRIC_KINDS),
    services: [],
    truncated: false,
  };
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function addBoundedSet(summary: OpenTelemetryRecordSummary, value: string): void {
  const traces = traceSets.get(summary) ?? new Set<string>();
  if (traces.size >= OPEN_TELEMETRY_LIMITS.traces) {
    summary.truncated = true;
    summary.traceCount = OPEN_TELEMETRY_LIMITS.traces;
    return;
  }
  traces.add(value);
  traceSets.set(summary, traces);
  summary.traceCount = traces.size;
}

function addServiceNames(value: Record<string, unknown>, summary: OpenTelemetryRecordSummary): void {
  const resource = ownObject(value, 'resource') ?? ownObject(value, 'Resource');
  const attributes = resource === undefined ? undefined : ownArray(resource, 'attributes') ?? ownArray(resource, 'Attributes');
  if (attributes === undefined) return;
  for (const attribute of attributes.slice(0, OPEN_TELEMETRY_LIMITS.signalItems)) {
    if (!isObject(attribute) || scalar(attribute, 'key') !== 'service.name') continue;
    const service = anyValueString(own(attribute, 'value'));
    if (service === undefined || summary.services.includes(service)) continue;
    if (summary.services.length >= OPEN_TELEMETRY_LIMITS.services) {
      summary.truncated = true;
      break;
    }
    summary.services.push(service.slice(0, OPEN_TELEMETRY_LIMITS.serviceNameLength));
  }
}

function anyValueString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return undefined;
  for (const key of ['stringValue', 'StringValue', 'value']) {
    const candidate = own(value, key);
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function take(values: unknown[], limit: number, summary: OpenTelemetryRecordSummary): unknown[] {
  if (values.length > limit) summary.truncated = true;
  return values.slice(0, limit);
}

function takeSignalItems(values: unknown[], summary: OpenTelemetryRecordSummary): unknown[] {
  const used = signalBudgets.get(summary) ?? 0;
  const remaining = Math.max(0, OPEN_TELEMETRY_LIMITS.signalItems - used);
  if (values.length > remaining) summary.truncated = true;
  const selected = values.slice(0, remaining);
  signalBudgets.set(summary, used + selected.length);
  return selected;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function ownArray(value: Record<string, unknown>, key: string): unknown[] | undefined {
  const candidate = own(value, key);
  return Array.isArray(candidate) ? candidate : undefined;
}

function ownObject(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = own(value, key);
  return isObject(candidate) ? candidate : undefined;
}

function scalar(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = own(value, key);
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  return undefined;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
