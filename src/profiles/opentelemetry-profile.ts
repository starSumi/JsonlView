import type { AgentRowProjection, FieldPath } from '@shared/types';
import { summarizeOpenTelemetryRecord } from '@shared/otel-insights';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  boundedSummary,
  createProjection,
  indexedPath,
  isObject,
  keyPath,
  objectAt,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
} from './utils';

const MAX_ATTRIBUTE_SCAN = 64;
const MAX_ANY_VALUE_ITEMS = 4;

interface Located<T> {
  value: T;
  path: FieldPath;
}

type OtelRecordKind = 'log' | 'span' | 'metric' | 'resourceLogs' | 'resourceSpans' | 'resourceMetrics' | 'unknown';

export class OpenTelemetryProfile implements AgentProfile {
  public readonly id = 'opentelemetry';
  public readonly displayName = 'OpenTelemetry';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let envelopes = 0;
    let records = 0;
    let distinctive = 0;
    const reasons: DetectionResult['reasons'] = [];

    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const kind = classifyRecord(entry.value);
      if (kind === 'resourceLogs' || kind === 'resourceSpans' || kind === 'resourceMetrics') {
        envelopes += 1;
        distinctive += 1;
        pushReason(reasons, keyPath(kind), `OTLP File Exporter ${kind} envelope`);
      } else if (kind === 'log') {
        records += 1;
        distinctive += 1;
        const path = own(entry.value, 'timeUnixNano') !== undefined ? keyPath('timeUnixNano') : keyPath('Timestamp');
        pushReason(reasons, path, 'OpenTelemetry log data-model field combination');
      } else if (kind === 'span' || kind === 'metric') {
        records += 1;
        distinctive += 1;
        const path = kind === 'span'
          ? (own(entry.value, 'startTimeUnixNano') !== undefined ? keyPath('startTimeUnixNano') : keyPath('StartTime'))
          : keyPath('name');
        pushReason(reasons, path, kind === 'span' ? 'OpenTelemetry span identity and timing field combination' : 'OpenTelemetry metric identity and aggregation field combination');
      }
    }

    const denominator = Math.max(1, sample.length);
    const score = envelopes > 0
      ? Math.min(0.99, 0.9 + 0.09 * Math.min(1, envelopes / denominator))
      : Math.min(0.96, 0.5 * Math.min(1, records) + 0.22 * Math.min(1, records / denominator) + 0.24 * Math.min(1, distinctive));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: envelopes > 0 || records > 0,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }

    const insight = summarizeOpenTelemetryRecord(record.value);

    const kind = classifyRecord(record.value);
    if (kind === 'resourceLogs' || kind === 'resourceSpans' || kind === 'resourceMetrics') {
      return this.projectEnvelope(record.value, kind, insight);
    }
    if (kind === 'span') {
      return this.projectSpan(record.value, insight);
    }
    if (kind === 'log') {
      return this.projectLog(record.value, insight);
    }
    if (kind === 'metric') return this.projectMetric(record.value, insight);
    return createProjection(this.id, 'other', boundedSummary(record.value, 'Unknown OpenTelemetry record'), undefined, keyPath());
  }

  private projectEnvelope(value: Record<string, unknown>, kind: 'resourceLogs' | 'resourceSpans' | 'resourceMetrics', insight: ReturnType<typeof summarizeOpenTelemetryRecord>): AgentRowProjection {
    const groups = Array.isArray(own(value, kind)) ? own(value, kind) as unknown[] : [];
    const noun = kind === 'resourceLogs' ? 'logs' : kind === 'resourceSpans' ? 'spans' : 'metrics';
    const nestedCount = insight.spanCount + insight.logCount + insight.metricCount;
    const operation = insight.operations[0];
    const firstGroup = isObject(groups[0]) ? groups[0] : undefined;
    const resource = firstGroup ? objectAt(firstGroup, 'resource') : undefined;
    const resourcePath = indexedPath([kind], 0, 'resource');
    const service = resource ? serviceFromResource(resource, resourcePath) : undefined;
    const semanticSuffix = [
      service?.value === undefined ? undefined : `service=${service.value}`,
      operation === undefined ? undefined : `op=${operation}`,
    ].filter((value): value is string => value !== undefined);
    const projection = createProjection(
      this.id,
      kind === 'resourceLogs' ? 'log' : kind === 'resourceSpans' ? 'span' : 'metric',
      `OTLP ${noun} envelope: ${groups.length} resource group${groups.length === 1 ? '' : 's'} · ${nestedCount} nested ${noun}${semanticSuffix.length === 0 ? '' : ` · ${semanticSuffix.join(' · ')}`}`,
      keyPath(kind),
      keyPath(kind),
    );
    setDerivedField(projection, 'containerKind', kind, keyPath(kind));
    setDerivedField(projection, 'resourceGroupCount', groups.length, keyPath(kind));

    if (service) setDerivedField(projection, 'service', service.value, service.path);
    const descriptor = resource ? describeResource(resource) : undefined;
    if (descriptor) setDerivedField(projection, 'resource', descriptor, resourcePath);
    const firstSignal = firstEnvelopeSignal(value, kind);
    if (firstSignal !== undefined) {
      const timestamp = locateScalar(firstSignal.value, kind === 'resourceSpans'
        ? [['startTimeUnixNano'], ['StartTime'], ['Timestamp']]
        : [['timeUnixNano'], ['Timestamp'], ['observedTimeUnixNano'], ['ObservedTimestamp']]);
      if (timestamp) setStringField(projection, 'timestamp', timestamp.value, timestamp.path);
      const severity = kind === 'resourceSpans'
        ? locateStatus(firstSignal.value)
        : locateScalar(firstSignal.value, [['severityText'], ['SeverityText'], ['severityNumber'], ['SeverityNumber']]);
      if (severity) {
        if (kind === 'resourceSpans') {
          setStringField(projection, 'status', severity.value, severity.path);
          if (statusIsError(severity.value)) setStringField(projection, 'severity', 'error', severity.path);
        } else {
          setStringField(projection, 'severity', severity.value, severity.path);
        }
      }
    }
    addInsightFields(projection, insight, keyPath(kind));
    return projection;
  }

  private projectSpan(value: Record<string, unknown>, insight: ReturnType<typeof summarizeOpenTelemetryRecord>): AgentRowProjection {
    const name = locateScalar(value, [['name'], ['Name']]);
    const status = locateStatus(value);
    const isError = statusIsError(status?.value);
    const projection = createProjection(
      this.id,
      'span',
      boundedSummary(name?.value ?? value, 'Span'),
      name?.path,
      name?.path ?? keyPath(),
    );
    setActor(projection, 'system', name?.path ?? keyPath());
    this.addCommonFields(projection, value, true);
    if (name) setDerivedField(projection, 'name', name.value, name.path);
    if (status) {
      setStringField(projection, 'status', status.value, status.path);
      setDerivedField(projection, 'spanStatus', status.value, status.path);
      if (isError) setStringField(projection, 'severity', 'error', status.path);
    }
    addInsightFields(projection, insight, keyPath('status'));
    return projection;
  }

  private projectLog(value: Record<string, unknown>, insight: ReturnType<typeof summarizeOpenTelemetryRecord>): AgentRowProjection {
    const body = locateBody(value);
    const eventName = locateScalar(value, [['eventName'], ['EventName']]);
    const severity = locateScalar(value, [['severityText'], ['SeverityText'], ['severityNumber'], ['SeverityNumber']]);
    const isError = severityIsError(severity?.value);
    const prefix = eventName?.value ? `Log ${eventName.value}` : 'Log';
    const projection = createProjection(
      this.id,
      'log',
      boundedSummary(body?.value ?? eventName?.value ?? value, prefix),
      body?.path ?? eventName?.path,
      body?.path ?? eventName?.path ?? keyPath(),
    );
    setActor(projection, 'system', body?.path ?? eventName?.path ?? keyPath());
    this.addCommonFields(projection, value, false);
    if (body) setDerivedField(projection, 'body', body.value, body.path);
    if (eventName) setDerivedField(projection, 'eventName', eventName.value, eventName.path);
    if (severity) setStringField(projection, 'severity', severity.value, severity.path);
    addInsightFields(projection, insight, keyPath('severityText'));
    return projection;
  }

  private projectMetric(value: Record<string, unknown>, insight: ReturnType<typeof summarizeOpenTelemetryRecord>): AgentRowProjection {
    const name = locateScalar(value, [['name'], ['Name']]);
    const unit = locateScalar(value, [['unit'], ['Unit']]);
    const kind = metricKindLabel(value);
    const projection = createProjection(this.id, 'metric', boundedSummary(name?.value ?? value, 'Metric'), name?.path, name?.path ?? keyPath());
    setActor(projection, 'system', name?.path ?? keyPath());
    if (name) setDerivedField(projection, 'name', name.value, name.path);
    if (unit) setDerivedField(projection, 'unit', unit.value, unit.path);
    setDerivedField(projection, 'metricKind', kind, keyPath(kind));
    addInsightFields(projection, insight, keyPath(kind));
    return projection;
  }

  private addCommonFields(projection: AgentRowProjection, value: Record<string, unknown>, isSpan: boolean): void {
    const timestamp = locateScalar(value, isSpan
      ? [['startTimeUnixNano'], ['StartTime'], ['Timestamp']]
      : [['timeUnixNano'], ['Timestamp'], ['observedTimeUnixNano'], ['ObservedTimestamp']]);
    const traceId = locateScalar(value, [['traceId'], ['TraceId']]);
    const spanId = locateScalar(value, [['spanId'], ['SpanId']]);
    const parentSpanId = locateScalar(value, [['parentSpanId'], ['ParentSpanId']]);
    const resource = locateObject(value, [['resource'], ['Resource']]);
    const service = resource ? serviceFromResource(resource.value, resource.path) : locateScalar(value, [['service.name'], ['serviceName']]);
    const observedTimestamp = locateScalar(value, [['observedTimeUnixNano'], ['ObservedTimestamp']]);
    const scope = locateObject(value, [['instrumentationScope'], ['InstrumentationScope'], ['scope']]);
    const attributes = own(value, 'attributes') ?? own(value, 'Attributes');

    if (timestamp) setStringField(projection, 'timestamp', timestamp.value, timestamp.path);
    if (traceId) {
      setStringField(projection, 'sessionId', traceId.value, traceId.path);
      setDerivedField(projection, 'traceId', traceId.value, traceId.path);
    }
    if (spanId) {
      setStringField(projection, 'turnId', spanId.value, spanId.path);
      setDerivedField(projection, 'spanId', spanId.value, spanId.path);
      if (isSpan) {
        setStringField(projection, 'messageId', spanId.value, spanId.path);
      } else {
        setStringField(projection, 'parentId', spanId.value, spanId.path);
      }
    }
    if (parentSpanId) {
      setDerivedField(projection, 'parentSpanId', parentSpanId.value, parentSpanId.path);
      if (isSpan) setStringField(projection, 'parentId', parentSpanId.value, parentSpanId.path);
    }
    if (service) setDerivedField(projection, 'service', service.value, service.path);
    if (resource) setDerivedField(projection, 'resource', describeResource(resource.value), resource.path);
    if (observedTimestamp) setDerivedField(projection, 'observedTimestamp', observedTimestamp.value, observedTimestamp.path);
    if (scope) setDerivedField(projection, 'instrumentationScope', describeScope(scope.value), scope.path);
    if (Array.isArray(attributes)) setDerivedField(projection, 'attributeCount', attributes.length, own(value, 'attributes') !== undefined ? keyPath('attributes') : keyPath('Attributes'));
  }
}

function addInsightFields(
  projection: AgentRowProjection,
  insight: ReturnType<typeof summarizeOpenTelemetryRecord>,
  path: FieldPath,
): void {
  if (!insight.recognized) return;
  setDerivedField(projection, 'spanCount', insight.spanCount, path);
  setDerivedField(projection, 'traceCount', insight.traceCount, path);
  setDerivedField(projection, 'logCount', insight.logCount, path);
  setDerivedField(projection, 'metricCount', insight.metricCount, path);
  setDerivedField(projection, 'dataPointCount', insight.dataPointCount, path);
  setDerivedField(projection, 'errorCount', insight.errorCount, path);
  setDerivedField(projection, 'durationMs', insight.durationMs, path);
  setDerivedField(projection, 'nestedCount', insight.spanCount + insight.logCount + insight.metricCount, path);
  setDerivedField(projection, 'resourceGroupCount', insight.resourceGroupCount, path);
  setDerivedField(projection, 'scopeCount', insight.scopeCount, path);
  setDerivedField(projection, 'serviceCount', insight.services.length, path);
  if (insight.operations[0] !== undefined) setDerivedField(projection, 'operation', insight.operations[0], path);
  setDerivedField(projection, 'spanKinds', JSON.stringify(insight.spanKinds), path);
  setDerivedField(projection, 'metricKinds', JSON.stringify(insight.metricKinds), path);
}

function firstEnvelopeSignal(
  value: Record<string, unknown>,
  kind: 'resourceLogs' | 'resourceSpans' | 'resourceMetrics',
): Located<Record<string, unknown>> | undefined {
  const scopeKey = kind === 'resourceLogs' ? 'scopeLogs' : kind === 'resourceSpans' ? 'scopeSpans' : 'scopeMetrics';
  const signalKey = kind === 'resourceLogs' ? 'logRecords' : kind === 'resourceSpans' ? 'spans' : 'metrics';
  const groups = own(value, kind);
  if (!Array.isArray(groups)) return undefined;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!isObject(group)) continue;
    const scopes = own(group, scopeKey);
    if (!Array.isArray(scopes)) continue;
    for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
      const scope = scopes[scopeIndex];
      if (!isObject(scope)) continue;
      const signals = own(scope, signalKey);
      if (!Array.isArray(signals)) continue;
      for (let signalIndex = 0; signalIndex < signals.length; signalIndex += 1) {
        const signal = signals[signalIndex];
        if (isObject(signal)) {
          return {
            value: signal,
            path: appendPath(keyPath(kind), groupIndex, scopeKey, scopeIndex, signalKey, signalIndex),
          };
        }
      }
    }
  }
  return undefined;
}

function classifyRecord(value: Record<string, unknown>): OtelRecordKind {
  if (hasEnvelopeEvidence(value, 'resourceLogs', 'scopeLogs', 'logRecords')) return 'resourceLogs';
  if (hasEnvelopeEvidence(value, 'resourceSpans', 'scopeSpans', 'spans')) return 'resourceSpans';
  if (hasEnvelopeEvidence(value, 'resourceMetrics', 'scopeMetrics', 'metrics')) return 'resourceMetrics';
  if (isOtelSpanRecord(value)) return 'span';
  if (isOtelLogRecord(value)) return 'log';
  if (isOtelMetricRecord(value)) return 'metric';
  return 'unknown';
}

/**
 * An empty array is valid JSON but is not enough evidence that a record is an
 * OTLP File Exporter envelope. Require one resource group and one nested
 * scope/signal container so ordinary application fields cannot hijack the
 * semantic profile.
 */
function hasEnvelopeEvidence(
  value: Record<string, unknown>,
  envelopeKey: 'resourceLogs' | 'resourceSpans' | 'resourceMetrics',
  scopeKey: 'scopeLogs' | 'scopeSpans' | 'scopeMetrics',
  signalKey: 'logRecords' | 'spans' | 'metrics',
): boolean {
  const groups = own(value, envelopeKey);
  if (!Array.isArray(groups) || groups.length === 0) return false;
  return groups.some((group) => {
    if (!isObject(group)) return false;
    const scopes = own(group, scopeKey);
    if (!Array.isArray(scopes) || scopes.length === 0) return false;
    return scopes.some((scope) => isObject(scope) && Array.isArray(own(scope, signalKey)) && (own(scope, signalKey) as unknown[]).length > 0);
  });
}

function isOtelMetricRecord(value: Record<string, unknown>): boolean {
  const name = scalar(value, 'name') ?? scalar(value, 'Name');
  return name !== undefined && metricKindLabel(value) !== 'unknown';
}

function metricKindLabel(value: Record<string, unknown>): string {
  for (const key of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary']) {
    if (isObject(own(value, key)) || isObject(own(value, key[0]!.toUpperCase() + key.slice(1)))) return key;
  }
  return 'unknown';
}

function isOtelSpanRecord(value: Record<string, unknown>): boolean {
  const lowerIdentity = scalar(value, 'traceId') && scalar(value, 'spanId') && scalar(value, 'name');
  const lowerTiming = scalar(value, 'startTimeUnixNano') && (scalar(value, 'endTimeUnixNano') || own(value, 'status') !== undefined || scalar(value, 'kind'));
  const modelIdentity = scalar(value, 'TraceId') && scalar(value, 'SpanId') && scalar(value, 'Name');
  const modelTiming = scalar(value, 'StartTime') && (scalar(value, 'EndTime') || own(value, 'Status') !== undefined);
  return Boolean((lowerIdentity && lowerTiming) || (modelIdentity && modelTiming));
}

function isOtelLogRecord(value: Record<string, unknown>): boolean {
  const lowerBody = own(value, 'body');
  const lowerTime = scalar(value, 'timeUnixNano') ?? scalar(value, 'observedTimeUnixNano');
  const lowerMetadata = scalar(value, 'severityText') ?? scalar(value, 'severityNumber') ?? scalar(value, 'flags');
  const lowerAnyValue = isObject(lowerBody) && OTLP_ANY_VALUE_KEYS.some((key) => own(lowerBody, key) !== undefined);

  const modelBody = own(value, 'Body');
  const modelTime = scalar(value, 'Timestamp') ?? scalar(value, 'ObservedTimestamp');
  const modelMetadata = scalar(value, 'SeverityText') ?? scalar(value, 'SeverityNumber')
    ?? (own(value, 'InstrumentationScope') !== undefined ? 'scope' : undefined)
    ?? (own(value, 'Resource') !== undefined ? 'resource' : undefined);

  return Boolean(
    (lowerBody !== undefined && lowerTime && (lowerMetadata || lowerAnyValue))
    || (modelBody !== undefined && modelTime && modelMetadata),
  );
}

const OTLP_ANY_VALUE_KEYS = ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue', 'arrayValue', 'kvlistValue'] as const;

function locateBody(value: Record<string, unknown>): Located<string> | undefined {
  if (own(value, 'body') !== undefined) {
    return { value: decodeAnyValue(own(value, 'body')), path: keyPath('body') };
  }
  if (own(value, 'Body') !== undefined) {
    return { value: boundedSummary(own(value, 'Body')), path: keyPath('Body') };
  }
  return undefined;
}

function decodeAnyValue(value: unknown, depth = 0): string {
  if (depth > 2) return boundedSummary(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return boundedSummary(value);
  }
  if (!isObject(value)) return boundedSummary(value);
  for (const key of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue']) {
    const candidate = own(value, key);
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      return boundedSummary(candidate);
    }
  }
  const arrayValues = objectAt(value, 'arrayValue');
  const values = arrayValues && Array.isArray(own(arrayValues, 'values')) ? own(arrayValues, 'values') as unknown[] : undefined;
  if (values) {
    const rendered = values.slice(0, MAX_ANY_VALUE_ITEMS).map((item) => decodeAnyValue(item, depth + 1));
    return boundedSummary(`[${rendered.join(', ')}${values.length > MAX_ANY_VALUE_ITEMS ? ', ...' : ''}]`);
  }
  const kvList = objectAt(value, 'kvlistValue');
  const entries = kvList && Array.isArray(own(kvList, 'values')) ? own(kvList, 'values') as unknown[] : undefined;
  if (entries) {
    const rendered: string[] = [];
    for (const entry of entries.slice(0, MAX_ANY_VALUE_ITEMS)) {
      if (!isObject(entry)) continue;
      const key = scalar(entry, 'key');
      if (key) rendered.push(`${key}=${decodeAnyValue(own(entry, 'value'), depth + 1)}`);
    }
    return boundedSummary(`{${rendered.join(', ')}${entries.length > MAX_ANY_VALUE_ITEMS ? ', ...' : ''}}`);
  }
  return boundedSummary(value);
}

function locateStatus(value: Record<string, unknown>): Located<string> | undefined {
  for (const key of ['status', 'Status']) {
    const candidate = own(value, key);
    if (candidate === undefined) continue;
    if (isObject(candidate)) {
      const code = scalar(candidate, 'code') ?? scalar(candidate, 'Code');
      const message = scalar(candidate, 'message') ?? scalar(candidate, 'Message');
      return { value: [code, message].filter(Boolean).join(': ') || boundedSummary(candidate), path: keyPath(key) };
    }
    return { value: boundedSummary(candidate), path: keyPath(key) };
  }
  return undefined;
}

function serviceFromResource(resource: Record<string, unknown>, path: FieldPath): Located<string> | undefined {
  const direct = scalar(resource, 'service.name') ?? scalar(resource, 'serviceName');
  if (direct) return { value: direct, path: appendPath(path, typeof own(resource, 'service.name') === 'string' ? 'service.name' : 'serviceName') };
  const attributesKey = own(resource, 'attributes') !== undefined ? 'attributes' : 'Attributes';
  const attributes = own(resource, attributesKey);
  if (Array.isArray(attributes)) {
    for (let index = 0; index < Math.min(attributes.length, MAX_ATTRIBUTE_SCAN); index += 1) {
      const attribute = attributes[index];
      if (!isObject(attribute) || scalar(attribute, 'key') !== 'service.name') continue;
      return {
        value: decodeAnyValue(own(attribute, 'value')),
        path: appendPath(path, attributesKey, index, 'value'),
      };
    }
  }
  return undefined;
}

function describeResource(resource: Record<string, unknown>): string {
  const service = serviceFromResource(resource, keyPath('resource'))?.value;
  const attributes = own(resource, 'attributes') ?? own(resource, 'Attributes');
  const count = Array.isArray(attributes) ? String(attributes.length) : boundedOwnKeyCount(resource);
  return boundedSummary(service ? `service.name=${service}; ${count} resource attributes` : `${count} resource attributes`);
}

function describeScope(scope: Record<string, unknown>): string {
  const name = scalar(scope, 'name') ?? scalar(scope, 'Name');
  const version = scalar(scope, 'version') ?? scalar(scope, 'Version');
  return boundedSummary([name, version].filter(Boolean).join('@') || 'instrumentation scope');
}

function boundedOwnKeyCount(value: Record<string, unknown>): string {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > MAX_ATTRIBUTE_SCAN) return `${MAX_ATTRIBUTE_SCAN}+`;
  }
  return String(count);
}

function appendPath(base: FieldPath, ...segments: (string | number)[]): FieldPath {
  return {
    tokens: [
      ...base.tokens,
      ...segments.map((value) => typeof value === 'number'
        ? { kind: 'index' as const, value }
        : { kind: 'key' as const, value }),
    ],
  };
}

function severityIsError(value: string | undefined): boolean {
  if (!value) return false;
  if (/error|fatal/i.test(value)) return true;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 17 && numeric <= 24;
}

function statusIsError(value: string | undefined): boolean {
  if (!value) return false;
  return /error/i.test(value) || /^2(?:\b|:)/.test(value);
}

function locateScalar(value: Record<string, unknown>, candidates: readonly string[][]): Located<string> | undefined {
  for (const keys of candidates) {
    let current: unknown = value;
    for (const key of keys) {
      if (!isObject(current)) {
        current = undefined;
        break;
      }
      current = own(current, key);
    }
    if (typeof current === 'string' && current.length > 0) return { value: current, path: keyPath(...keys) };
    if (typeof current === 'number' && Number.isFinite(current)) return { value: String(current), path: keyPath(...keys) };
  }
  return undefined;
}

function locateObject(value: Record<string, unknown>, candidates: readonly string[][]): Located<Record<string, unknown>> | undefined {
  for (const keys of candidates) {
    let current: unknown = value;
    for (const key of keys) {
      if (!isObject(current)) {
        current = undefined;
        break;
      }
      current = own(current, key);
    }
    if (isObject(current)) return { value: current, path: keyPath(...keys) };
  }
  return undefined;
}

function scalar(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = own(value, key);
  if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  return undefined;
}
