import { isSafeErrorName } from './error-metadata';

export type ObservabilityScalar = string | number | boolean;

export type ObservabilityEventName =
  | 'jsonlview.index.completed'
  | 'jsonlview.query.completed'
  | 'jsonlview.query.started'
  | 'jsonlview.query.settled'
  | 'jsonlview.webview.error'
  | 'jsonlview.lifecycle.source_classified'
  | 'jsonlview.lifecycle.recovery_decided'
  | 'jsonlview.lifecycle.snapshot_published'
  | 'jsonlview.lifecycle.webview_delivered';

export interface ObservabilityEvent {
  readonly name: ObservabilityEventName;
  readonly timestamp: string;
  readonly attributes: Readonly<Record<string, ObservabilityScalar>>;
}

export interface ObservabilitySink {
  record(event: ObservabilityEvent): void;
}

export type QueryOperationOutcome = 'completed' | 'stale' | 'cancelled' | 'failed';
export type QueryOperationDelivery = 'accepted' | 'rejected' | 'skipped' | 'failed';
export type QueryStaleReason = 'document' | 'generation' | 'epoch';

const MAX_ATTRIBUTES = 16;
const MAX_QUERY_ATTRIBUTES = 19;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 160;
const LIFECYCLE_STAGE_ORDER = [
  'source_classification',
  'recovery_decision',
  'snapshot_publish',
  'webview_delivery',
] as const;

export type LifecycleTraceStage = typeof LIFECYCLE_STAGE_ORDER[number];

export type LifecycleTraceResult =
  | 'unchanged'
  | 'append'
  | 'truncate'
  | 'replace'
  | 'delete'
  | 'unknown'
  | 'error'
  | 'retry'
  | 'rebuild'
  | 'invalidate'
  | 'cancelled'
  | 'blocked'
  | 'recovered'
  | 'published'
  | 'stale'
  | 'failed'
  | 'accepted'
  | 'rejected'
  | 'delivered'
  | 'skipped';

export interface CausalLifecycleTrace {
  /** Record the next stage in the bounded source-to-Webview delivery lifecycle. */
  record(stage: LifecycleTraceStage, result: LifecycleTraceResult): ObservabilityEvent | undefined;
  readonly sequence: number;
  readonly complete: boolean;
}

const LIFECYCLE_EVENT_NAMES: Readonly<Record<LifecycleTraceStage, ObservabilityEventName>> = Object.freeze({
  source_classification: 'jsonlview.lifecycle.source_classified',
  recovery_decision: 'jsonlview.lifecycle.recovery_decided',
  snapshot_publish: 'jsonlview.lifecycle.snapshot_published',
  webview_delivery: 'jsonlview.lifecycle.webview_delivered',
});

const ALLOWED_KEYS = new Set([
  'duration_ms',
  'rows',
  'bytes',
  'result',
  'profile',
  'stage',
  'error_name',
  'sequence',
  'causation',
]);
const BLOCKED_KEY = /(body|content|prompt|response|path|uri|workspace|token|secret|header|user|account|credential)/iu;
const QUERY_KEYS = new Set(['stage', 'request_seq', 'outcome', 'delivery', 'abort_observed',
  'duration_ms', 'rows', 'stale_reason', 'error_name', 'queue_wait_ms', 'engine_exec_ms',
  'queue_blocked_by', 'index_work_ms', 'read_wait_ms', 'parse_ms', 'projection_ms', 'snapshot_check_ms',
  'read_calls', 'read_bytes', 'read_max_wait_ms']);
const QUERY_OUTCOMES = new Set(['completed', 'stale', 'cancelled', 'failed']);
const QUERY_DELIVERIES = new Set(['accepted', 'rejected', 'skipped', 'failed']);
const QUERY_STALE_REASONS = new Set(['document', 'generation', 'epoch']);
const QUERY_TIMING_NUMERIC_KEYS = [
  'queue_wait_ms', 'engine_exec_ms', 'index_work_ms', 'read_wait_ms',
  'parse_ms', 'projection_ms', 'snapshot_check_ms',
] as const;
const QUERY_TIMING_KEYS = [...QUERY_TIMING_NUMERIC_KEYS, 'queue_blocked_by'] as const;
const QUERY_READ_DIAGNOSTIC_KEYS = ['read_calls', 'read_bytes', 'read_max_wait_ms'] as const;
const QUERY_QUEUE_BLOCKERS = new Set([
  'none', 'index_more', 'finish_indexing', 'get_rows', 'inspect_rows', 'get_problems',
  'get_detail', 'get_schema', 'classify_refresh',
]);
const EVENT_NAMES = new Set<ObservabilityEventName>([
  'jsonlview.index.completed',
  'jsonlview.query.completed',
  'jsonlview.query.started',
  'jsonlview.query.settled',
  'jsonlview.webview.error',
  ...Object.values(LIFECYCLE_EVENT_NAMES),
]);
const CAUSATION_VALUES = new Set(['root', ...LIFECYCLE_STAGE_ORDER]);

/** Contract-first, no-op-by-default boundary for future OTEL/OTLP export. */
export const NOOP_OBSERVABILITY: ObservabilitySink = Object.freeze({ record: () => undefined });

/**
 * Build a local, bounded causal chain without introducing a trace or session
 * identifier. The default sink is a no-op and sink failures are isolated from
 * the product lifecycle.
 */
export function createCausalLifecycleTrace(
  sink: ObservabilitySink = NOOP_OBSERVABILITY,
  timestamp = (): string => new Date().toISOString(),
): CausalLifecycleTrace {
  let sequence = 0;
  let complete = false;

  return {
    get sequence() {
      return sequence;
    },
    get complete() {
      return complete;
    },
    record(stage, result) {
      if (complete || LIFECYCLE_STAGE_ORDER[sequence] !== stage) return undefined;
      let event: ObservabilityEvent | undefined;
      try {
        event = createObservabilityEvent(
          LIFECYCLE_EVENT_NAMES[stage],
          {
            stage,
            result,
            sequence: sequence + 1,
            causation: sequence === 0 ? 'root' : LIFECYCLE_STAGE_ORDER[sequence - 1],
          },
          timestamp(),
        );
      } catch {
        return undefined;
      }
      if (event === undefined) return undefined;
      sequence += 1;
      complete = sequence === LIFECYCLE_STAGE_ORDER.length;
      try {
        sink.record(event);
      } catch {
        // Observability must never change source, recovery, or delivery behavior.
      }
      return event;
    },
  };
}

export function createObservabilityEvent(
  name: ObservabilityEventName,
  attributes: Readonly<Record<string, unknown>>,
  timestamp = new Date().toISOString(),
): ObservabilityEvent | undefined {
  if (!EVENT_NAMES.has(name)) return undefined;
  if (!Number.isFinite(Date.parse(timestamp))) return undefined;
  const entries = Object.entries(attributes);
  const queryEvent = name === 'jsonlview.query.started' || name === 'jsonlview.query.settled';
  if (entries.length > (queryEvent ? MAX_QUERY_ATTRIBUTES : MAX_ATTRIBUTES)) return undefined;
  const allowedKeys = queryEvent ? QUERY_KEYS : ALLOWED_KEYS;
  if (queryEvent && !validQueryAttributes(name, attributes)) return undefined;
  const normalized: Record<string, ObservabilityScalar> = {};
  for (const [key, value] of entries) {
    if (!allowedKeys.has(key) || BLOCKED_KEY.test(key) || key.length === 0 || key.length > MAX_KEY_LENGTH) return undefined;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    if (typeof value === 'string' && (value.length === 0 || value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value))) return undefined;
    if (key === 'sequence' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > LIFECYCLE_STAGE_ORDER.length)) return undefined;
    if (key === 'causation' && (typeof value !== 'string' || !CAUSATION_VALUES.has(value))) return undefined;
    normalized[key] = value;
  }
  return Object.freeze({ name, timestamp, attributes: Object.freeze(normalized) });
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validQueryAttributes(name: ObservabilityEventName, value: Readonly<Record<string, unknown>>): boolean {
  if (value.stage !== 'get_rows' || !nonnegativeSafeInteger(value.request_seq) || value.request_seq === 0) return false;
  if (name === 'jsonlview.query.started') return Object.keys(value).length === 2;
  const timingKeysPresent = QUERY_TIMING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (timingKeysPresent.length !== 0) {
    if (timingKeysPresent.length !== QUERY_TIMING_KEYS.length
      || !QUERY_TIMING_NUMERIC_KEYS.every((key) => nonnegativeSafeInteger(value[key]))
      || typeof value.queue_blocked_by !== 'string'
      || !QUERY_QUEUE_BLOCKERS.has(value.queue_blocked_by)) return false;
  }
  const readKeysPresent = QUERY_READ_DIAGNOSTIC_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (readKeysPresent.length !== 0 && (timingKeysPresent.length === 0
    || readKeysPresent.length !== QUERY_READ_DIAGNOSTIC_KEYS.length
    || !QUERY_READ_DIAGNOSTIC_KEYS.every((key) => nonnegativeSafeInteger(value[key])))) return false;
  if (typeof value.outcome !== 'string' || !QUERY_OUTCOMES.has(value.outcome)
    || typeof value.delivery !== 'string' || !QUERY_DELIVERIES.has(value.delivery)
    || typeof value.abort_observed !== 'boolean' || !nonnegativeSafeInteger(value.duration_ms)) return false;
  if (value.rows !== undefined && !nonnegativeSafeInteger(value.rows)) return false;
  if (value.outcome === 'stale') {
    if (typeof value.stale_reason !== 'string' || !QUERY_STALE_REASONS.has(value.stale_reason)) return false;
  } else if (value.stale_reason !== undefined) return false;
  if (value.outcome === 'failed') {
    return isSafeErrorName(value.error_name) && (value.delivery === 'skipped' || value.delivery === 'failed');
  }
  if (value.error_name !== undefined) return false;
  return value.outcome === 'completed'
    ? value.delivery === 'accepted' || value.delivery === 'rejected'
    : value.delivery === 'skipped' || value.delivery === 'failed';
}
