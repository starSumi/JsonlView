import {
  OPEN_TELEMETRY_ADAPTER_ID,
  OPEN_TELEMETRY_ADAPTER_VERSION,
  OPEN_TELEMETRY_LIMITS,
  type OpenTelemetryMetricKind,
  type OpenTelemetryMetricKindCounts,
  type OpenTelemetryRecordSummary,
  type OpenTelemetrySignal,
  type OpenTelemetrySpanKind,
  type OpenTelemetrySpanKindCounts,
} from '../otel-insights';

const SIGNALS: readonly OpenTelemetrySignal[] = ['logs', 'spans', 'metrics', 'unknown'];
const CONTAINERS = ['record', 'resourceLogs', 'resourceSpans', 'resourceMetrics'] as const;
const SPAN_KINDS: readonly OpenTelemetrySpanKind[] = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer', 'unknown'];
const METRIC_KINDS: readonly OpenTelemetryMetricKind[] = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary', 'unknown'];

export function isOpenTelemetryRecordSummary(value: unknown): value is OpenTelemetryRecordSummary {
  if (!object(value) || !exact(value, ['version', 'adapterId', 'adapterVersion', 'recognized', 'valid', 'signal', 'containerKind', 'resourceGroupCount', 'scopeCount', 'spanCount', 'traceCount', 'logCount', 'metricCount', 'dataPointCount', 'errorCount', 'durationMs', 'spanKinds', 'metricKinds', 'services', 'truncated'])) return false;
  return value.version === 1 && value.adapterId === OPEN_TELEMETRY_ADAPTER_ID && value.adapterVersion === OPEN_TELEMETRY_ADAPTER_VERSION
    && typeof value.recognized === 'boolean' && typeof value.valid === 'boolean'
    && SIGNALS.includes(value.signal as OpenTelemetrySignal) && CONTAINERS.includes(value.containerKind as typeof CONTAINERS[number])
    && count(value.resourceGroupCount) && value.resourceGroupCount <= OPEN_TELEMETRY_LIMITS.resourceGroups
    && count(value.scopeCount) && value.scopeCount <= OPEN_TELEMETRY_LIMITS.scopes
    && count(value.spanCount) && count(value.traceCount) && value.traceCount <= OPEN_TELEMETRY_LIMITS.traces
    && count(value.logCount) && count(value.metricCount) && count(value.dataPointCount) && count(value.errorCount)
    && count(value.durationMs) && spanKinds(value.spanKinds) && metricKinds(value.metricKinds)
    && Array.isArray(value.services) && value.services.length <= OPEN_TELEMETRY_LIMITS.services
    && value.services.every((item) => typeof item === 'string' && item.length <= OPEN_TELEMETRY_LIMITS.serviceNameLength)
    && typeof value.truncated === 'boolean';
}

function spanKinds(value: unknown): value is OpenTelemetrySpanKindCounts {
  return counts(value, SPAN_KINDS);
}

function metricKinds(value: unknown): value is OpenTelemetryMetricKindCounts {
  return counts(value, METRIC_KINDS);
}

function counts<T extends string>(value: unknown, keys: readonly T[]): value is Record<T, number> {
  return object(value) && exact(value, keys) && keys.every((key) => count(value[key]));
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
