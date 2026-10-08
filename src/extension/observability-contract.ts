export type ObservabilityScalar = string | number | boolean;

export type ObservabilityEventName =
  | 'jsonlview.index.completed'
  | 'jsonlview.query.completed'
  | 'jsonlview.webview.error';

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
const ALLOWED_KEYS = new Set([
  'duration_ms',
  'rows',
  'bytes',
  'result',
  'profile',
  'stage',
  'error_name',
]);
const BLOCKED_KEY = /(body|content|prompt|response|path|uri|workspace|token|secret|header|user|account|credential)/iu;

/** Contract-first, no-op-by-default boundary for future OTEL/OTLP export. */
export const NOOP_OBSERVABILITY: ObservabilitySink = Object.freeze({ record: () => undefined });

export function createObservabilityEvent(
  name: ObservabilityEventName,
  attributes: Readonly<Record<string, unknown>>,
  timestamp = new Date().toISOString(),
): ObservabilityEvent | undefined {
  if (!Number.isFinite(Date.parse(timestamp))) return undefined;
  const entries = Object.entries(attributes);
  if (entries.length > MAX_ATTRIBUTES) return undefined;
  const normalized: Record<string, ObservabilityScalar> = {};
  for (const [key, value] of entries) {
    if (!ALLOWED_KEYS.has(key) || BLOCKED_KEY.test(key) || key.length === 0 || key.length > MAX_KEY_LENGTH) return undefined;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined;
    if (typeof value === 'string' && (value.length === 0 || value.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value))) return undefined;
    normalized[key] = value;
  }
  return Object.freeze({ name, timestamp, attributes: Object.freeze(normalized) });
}
