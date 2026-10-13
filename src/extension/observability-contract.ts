export type ObservabilityScalar = string | number | boolean;

export type ObservabilityEventName =
  | 'jsonlview.index.completed'
  | 'jsonlview.query.completed'
  | 'jsonlview.webview.error'
  | 'jsonlview.lifecycle.source_classified'
  | 'jsonlview.lifecycle.recovery_decided'
  | 'jsonlview.lifecycle.snapshot_published'
  | 'jsonlview.lifecycle.webview_accepted';

export interface ObservabilityEvent {
  readonly name: ObservabilityEventName;
  readonly timestamp: string;
  readonly attributes: Readonly<Record<string, ObservabilityScalar>>;
}

export interface ObservabilitySink {
  record(event: ObservabilityEvent): void;
}

const MAX_ATTRIBUTES = 16;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 160;
const LIFECYCLE_STAGE_ORDER = [
  'source_classification',
  'recovery_decision',
  'snapshot_publish',
  'webview_acceptance',
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
  | 'skipped';

export interface CausalLifecycleTrace {
  /** Record the next stage in the bounded source-to-Webview lifecycle. */
  record(stage: LifecycleTraceStage, result: LifecycleTraceResult): ObservabilityEvent | undefined;
  readonly sequence: number;
  readonly complete: boolean;
}

const LIFECYCLE_EVENT_NAMES: Readonly<Record<LifecycleTraceStage, ObservabilityEventName>> = Object.freeze({
  source_classification: 'jsonlview.lifecycle.source_classified',
  recovery_decision: 'jsonlview.lifecycle.recovery_decided',
  snapshot_publish: 'jsonlview.lifecycle.snapshot_published',
  webview_acceptance: 'jsonlview.lifecycle.webview_accepted',
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
const EVENT_NAMES = new Set<ObservabilityEventName>([
  'jsonlview.index.completed',
  'jsonlview.query.completed',
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
  if (entries.length > MAX_ATTRIBUTES) return undefined;
  const normalized: Record<string, ObservabilityScalar> = {};
  for (const [key, value] of entries) {
    if (!ALLOWED_KEYS.has(key) || BLOCKED_KEY.test(key) || key.length === 0 || key.length > MAX_KEY_LENGTH) return undefined;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    if (typeof value === 'string' && (value.length === 0 || value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value))) return undefined;
    if (key === 'sequence' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > LIFECYCLE_STAGE_ORDER.length)) return undefined;
    if (key === 'causation' && (typeof value !== 'string' || !CAUSATION_VALUES.has(value))) return undefined;
    normalized[key] = value;
  }
  return Object.freeze({ name, timestamp, attributes: Object.freeze(normalized) });
}
