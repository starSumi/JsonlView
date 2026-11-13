export const OPEN_TELEMETRY_ADAPTER_ID = 'opentelemetry' as const;
export const OPEN_TELEMETRY_ADAPTER_VERSION = '1.0.0' as const;

export interface OpenTelemetryLimits {
  readonly resourceGroups: number;
  readonly scopes: number;
  readonly signalItems: number;
  readonly traces: number;
  readonly services: number;
  readonly serviceNameLength: number;
  readonly operations: number;
  readonly operationNameLength: number;
}

export const OPEN_TELEMETRY_LIMITS: Readonly<OpenTelemetryLimits> = Object.freeze({
  resourceGroups: 64,
  scopes: 128,
  signalItems: 2048,
  traces: 512,
  services: 16,
  serviceNameLength: 96,
  operations: 32,
  operationNameLength: 96,
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
  operations: string[];
  truncated: boolean;
}

const SIGNALS: readonly OpenTelemetrySignal[] = ['logs', 'spans', 'metrics', 'unknown'];
const CONTAINERS = ['record', 'resourceLogs', 'resourceSpans', 'resourceMetrics'] as const;
const SPAN_KINDS: readonly OpenTelemetrySpanKind[] = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer', 'unknown'];
const METRIC_KINDS: readonly OpenTelemetryMetricKind[] = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary', 'unknown'];

export function isOpenTelemetryRecordSummary(value: unknown): value is OpenTelemetryRecordSummary {
  if (!object(value) || !exact(value, ['version', 'adapterId', 'adapterVersion', 'recognized', 'valid', 'signal', 'containerKind', 'resourceGroupCount', 'scopeCount', 'spanCount', 'traceCount', 'logCount', 'metricCount', 'dataPointCount', 'errorCount', 'durationMs', 'spanKinds', 'metricKinds', 'services', 'operations', 'truncated'])) return false;
  return value.version === 1 && value.adapterId === OPEN_TELEMETRY_ADAPTER_ID && value.adapterVersion === OPEN_TELEMETRY_ADAPTER_VERSION
    && typeof value.recognized === 'boolean' && typeof value.valid === 'boolean'
    && SIGNALS.includes(value.signal as OpenTelemetrySignal) && CONTAINERS.includes(value.containerKind as typeof CONTAINERS[number])
    && count(value.resourceGroupCount) && value.resourceGroupCount <= OPEN_TELEMETRY_LIMITS.resourceGroups
    && count(value.scopeCount) && value.scopeCount <= OPEN_TELEMETRY_LIMITS.scopes
    && boundedSignalCount(value.spanCount) && count(value.traceCount) && value.traceCount <= OPEN_TELEMETRY_LIMITS.traces
    && boundedSignalCount(value.logCount) && boundedSignalCount(value.metricCount)
    && boundedSignalCount(value.dataPointCount) && boundedSignalCount(value.errorCount)
    && count(value.durationMs) && spanKinds(value.spanKinds) && metricKinds(value.metricKinds)
    && Array.isArray(value.services) && value.services.length <= OPEN_TELEMETRY_LIMITS.services
    && value.services.every((item) => typeof item === 'string' && item.length <= OPEN_TELEMETRY_LIMITS.serviceNameLength)
    && Array.isArray(value.operations) && value.operations.length <= OPEN_TELEMETRY_LIMITS.operations
    && value.operations.every((item) => typeof item === 'string' && item.length <= OPEN_TELEMETRY_LIMITS.operationNameLength)
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

function boundedSignalCount(value: unknown): value is number {
  return count(value) && value <= OPEN_TELEMETRY_LIMITS.signalItems;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
