import type { AgentRowProjection, FieldPath } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  boundedSummary,
  createProjection,
  isObject,
  keyPath,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
} from './utils';

interface Located<T> {
  value: T;
  path: FieldPath;
}

export class StructuredApplicationLogProfile implements AgentProfile {
  public readonly id = 'structured-application-log';
  public readonly displayName = 'Structured Application Log';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let logShapes = 0;
    let timeSignals = 0;
    let severitySignals = 0;
    let sourceSignals = 0;
    let correlationSignals = 0;
    const reasons: DetectionResult['reasons'] = [];

    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const time = locateScalar(entry.value, TIME_PATHS);
      const severity = locateLevel(entry.value);
      const message = locateMessage(entry.value);
      const error = locateError(entry.value);
      const source = locateScalar(entry.value, LOGGER_PATHS) ?? locateService(entry.value);
      const correlation = locateScalar(entry.value, [...REQUEST_PATHS, ...TRACE_PATHS, ...SPAN_PATHS]);
      const hasPayload = Boolean(message || error);
      if (hasPayload && severity && (time || source)) {
        logShapes += 1;
        pushReason(reasons, message?.path ?? error?.path ?? keyPath(), 'Structured application log message or exception');
      }
      if (time) timeSignals += 1;
      if (severity) {
        severitySignals += 1;
        pushReason(reasons, severity.path, 'Explicit log severity field');
      }
      if (source) sourceSignals += 1;
      if (correlation) correlationSignals += 1;
    }

    const denominator = Math.max(1, sample.length);
    const score = Math.min(0.94,
      0.44 * Math.min(1, logShapes)
      + 0.19 * Math.min(1, severitySignals / denominator)
      + 0.16 * Math.min(1, timeSignals / denominator)
      + 0.09 * Math.min(1, sourceSignals / denominator)
      + 0.06 * Math.min(1, correlationSignals / denominator));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: logShapes > 0 && severitySignals > 0 && (timeSignals > 0 || sourceSignals > 0),
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }

    const value = record.value;
    const timestamp = locateScalar(value, TIME_PATHS);
    const severity = locateLevel(value);
    const message = locateMessage(value);
    const logger = locateScalar(value, LOGGER_PATHS);
    const service = locateService(value);
    const requestId = locateScalar(value, REQUEST_PATHS);
    const correlationId = locateScalar(value, CORRELATION_PATHS);
    const traceId = locateScalar(value, TRACE_PATHS);
    const spanId = locateScalar(value, SPAN_PATHS);
    const error = locateError(value);
    const isError = Boolean(error) || severityIsError(severity?.value);
    const isLog = Boolean((message || error) && severity && (timestamp || logger || service));

    if (!isLog) {
      return createProjection(this.id, 'other', boundedSummary(value, 'Unknown structured-log record'), undefined, keyPath());
    }

    const summaryValue = message?.value ?? error?.value ?? value;
    const projection = createProjection(
      this.id,
      'log',
      boundedSummary(summaryValue, logger?.value ?? service?.value ?? 'Log'),
      severity?.path ?? message?.path,
      message?.path ?? error?.path ?? keyPath(),
    );
    setActor(projection, 'system', logger?.path ?? service?.path ?? severity?.path ?? keyPath());
    if (timestamp) setStringField(projection, 'timestamp', timestamp.value, timestamp.path);
    if (severity) setStringField(projection, 'severity', severity.value, severity.path);
    if (logger) setDerivedField(projection, 'logger', logger.value, logger.path);
    if (service) setDerivedField(projection, 'service', service.value, service.path);
    if (requestId) setDerivedField(projection, 'requestId', requestId.value, requestId.path);
    if (correlationId) setDerivedField(projection, 'correlationId', correlationId.value, correlationId.path);
    if (traceId) setDerivedField(projection, 'traceId', normalizeGcpTrace(traceId.value), traceId.path);
    if (spanId) {
      setStringField(projection, 'turnId', spanId.value, spanId.path);
      setDerivedField(projection, 'spanId', spanId.value, spanId.path);
    }
    if (error) setDerivedField(projection, 'exception', error.value, error.path);

    const correlation = correlationId ?? traceId ?? requestId;
    if (correlation) {
      const stableId = correlation === traceId ? normalizeGcpTrace(correlation.value) : correlation.value;
      setStringField(projection, 'sessionId', stableId, correlation.path);
    }
    return projection;
  }
}

const TIME_PATHS = [
  ['timestamp'], ['time'], ['@timestamp'], ['@t'], ['datetime'], ['timeMillis'], ['instant', 'timeMillis'],
] as const;
const LOGGER_PATHS = [
  ['logger'], ['category'], ['component'], ['loggerName'], ['SourceContext'], ['name'], ['log', 'logger'],
] as const;
const SERVICE_PATHS = [
  ['serviceName'], ['service_name'], ['service', 'name'], ['resource', 'service', 'name'],
] as const;
const REQUEST_PATHS = [
  ['requestId'], ['request_id'], ['RequestId'], ['reqId'], ['http', 'request', 'id'], ['httpRequest', 'requestId'],
] as const;
const CORRELATION_PATHS = [
  ['correlationId'], ['correlation_id'], ['CorrelationId'],
] as const;
const TRACE_PATHS = [
  ['traceId'], ['trace_id'], ['TraceId'], ['trace', 'id'], ['logging.googleapis.com/trace'],
] as const;
const SPAN_PATHS = [
  ['spanId'], ['span_id'], ['SpanId'], ['span', 'id'], ['logging.googleapis.com/spanId'],
] as const;
const MESSAGE_PATHS = [
  ['message'], ['msg'], ['@m'], ['@mt'], ['event', 'original'],
] as const;
const ERROR_PATHS = [
  ['exception'], ['Exception'], ['error'], ['err'], ['stack'], ['stacktrace'], ['error', 'message'], ['error', 'stack'], ['error', 'stack_trace'], ['exception', 'message'], ['exception', 'stacktrace'],
] as const;

function locateLevel(value: Record<string, unknown>): Located<string> | undefined {
  const located = locateUnknown(value, [['level'], ['severity'], ['severityText'], ['@l'], ['log', 'level']]);
  if (!located) return undefined;
  if (typeof located.value === 'string' && located.value.length > 0) return { value: located.value, path: located.path };
  if (typeof located.value === 'number' && Number.isFinite(located.value)) {
    return { value: pinoLevel(located.value), path: located.path };
  }
  return undefined;
}

function locateMessage(value: Record<string, unknown>): Located<string> | undefined {
  const located = locateUnknown(value, MESSAGE_PATHS);
  if (!located) return undefined;
  return { value: boundedSummary(located.value), path: located.path };
}

function locateError(value: Record<string, unknown>): Located<string> | undefined {
  const located = locateUnknown(value, ERROR_PATHS);
  if (!located) return undefined;
  return { value: boundedSummary(located.value), path: located.path };
}

function locateService(value: Record<string, unknown>): Located<string> | undefined {
  const direct = own(value, 'service');
  if (typeof direct === 'string' && direct.length > 0) return { value: direct, path: keyPath('service') };
  return locateScalar(value, SERVICE_PATHS);
}

function locateScalar(value: Record<string, unknown>, candidates: readonly (readonly string[])[]): Located<string> | undefined {
  const located = locateUnknown(value, candidates);
  if (!located) return undefined;
  if (typeof located.value === 'string' && located.value.length > 0) return { value: located.value, path: located.path };
  if (typeof located.value === 'number' && Number.isFinite(located.value)) return { value: String(located.value), path: located.path };
  return undefined;
}

function locateUnknown(value: Record<string, unknown>, candidates: readonly (readonly string[])[]): Located<unknown> | undefined {
  for (const keys of candidates) {
    let current: unknown = value;
    for (const key of keys) {
      if (!isObject(current)) {
        current = undefined;
        break;
      }
      current = own(current, key);
    }
    if (current !== undefined && current !== null) return { value: current, path: keyPath(...keys) };
  }
  return undefined;
}

function pinoLevel(value: number): string {
  switch (value) {
    case 10: return 'trace';
    case 20: return 'debug';
    case 30: return 'info';
    case 40: return 'warn';
    case 50: return 'error';
    case 60: return 'fatal';
    default: return String(value);
  }
}

function severityIsError(value: string | undefined): boolean {
  if (!value) return false;
  return /^(error|fatal|critical|crit|emerg|alert)$/i.test(value) || Number(value) >= 50;
}

function normalizeGcpTrace(value: string): string {
  const marker = '/traces/';
  const index = value.lastIndexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}
