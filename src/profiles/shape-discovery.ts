import {
  displayFieldPath,
  type FieldPath,
  type JsonKind,
  type PathToken,
} from '../shared/types';
import { isObject, own } from './utils';

/** A bounded structural view of records. It is evidence, not a schema claim. */
export interface ShapeDiscovery {
  sampleCount: number;
  objectRecords: number;
  fields: ShapeField[];
  discriminator?: InferredField;
}

export interface ShapeField {
  path: FieldPath;
  displayPath: string;
  presentRecords: number;
  kinds: JsonKind[];
  stringValues: string[];
}

export interface InferredField {
  path: FieldPath;
  key: string;
  value: string;
  score: number;
}

export interface RecordSignals {
  discriminator?: InferredField;
  timestamp?: InferredField;
  actor?: InferredField;
  summary?: InferredField;
  identities: InferredField[];
}

export type SourceSurfaceKind =
  | 'codex-history'
  | 'codex-session-index'
  | 'codex-rollout'
  | 'codex-exec-jsonl'
  | 'codex-trace'
  | 'codex-tui-session-log'
  | 'codex-analytics-capture'
  | 'codex-app-server'
  | 'codex-app-server-log'
  | 'codex-compressed-rollout'
  | 'claude-job-timeline'
  | 'claude-history'
  | 'claude-transcript';

export type SourceSurfaceDisposition = 'profiled' | 'generic-compatible' | 'explicitly-unsupported';
export type SourceSurfaceLocator = 'content' | 'path' | 'companion';

export interface SourceSurfaceEvidence {
  kind: SourceSurfaceKind;
  strength: 'strong' | 'weak';
  disposition: SourceSurfaceDisposition;
  locator: SourceSurfaceLocator;
  companionFiles?: readonly string[];
  /** The normalized path pattern which produced this hint. */
  pattern: string;
}

export interface SourceSurfaceDescriptor {
  kind: SourceSurfaceKind;
  profileId: string;
  disposition: SourceSurfaceDisposition;
  locator: SourceSurfaceLocator;
  strongPatterns: readonly RegExp[];
  weakBasenames?: readonly string[];
  producerRepository?: string;
  producerRevision?: string;
  serializationAnchor?: string;
  requiredPaths?: readonly string[];
  companionFiles?: readonly string[];
  sourceAnchors: readonly string[];
}

/** Local source-study snapshot used to make adapter updates auditable. */
export const CODEX_SOURCE_REVISION = 'ac192cd7937b0d73edc6dffe009940ae53782dd4';

/**
 * The small, reviewable catalog produced by source study. Keep producer paths
 * and anchors here; runtime code consumes only the path patterns and never
 * opens these repositories.
 */
export const SOURCE_SURFACE_CATALOG: readonly SourceSurfaceDescriptor[] = [
  {
    kind: 'codex-history',
    profileId: 'codex-history',
    disposition: 'profiled',
    locator: 'path',
    strongPatterns: [/(^|\/)\.codex\/history\.jsonl$/],
    weakBasenames: ['history.jsonl'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'serde_json::to_string(HistoryEntry)',
    requiredPaths: ['session_id', 'ts', 'text'],
    sourceAnchors: ['codex-rs/message-history/src/lib.rs:HistoryEntry', 'codex-rs/message-history/src/lib.rs:serde_json::to_string'],
  },
  {
    kind: 'codex-session-index',
    profileId: 'codex-session-index',
    disposition: 'profiled',
    locator: 'path',
    strongPatterns: [/(^|\/)\.codex\/session_index\.jsonl$/],
    weakBasenames: ['session_index.jsonl'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'serde_json::to_string(SessionIndexEntry)',
    requiredPaths: ['id', 'thread_name', 'updated_at'],
    sourceAnchors: ['codex-rs/rollout/src/session_index.rs:SessionIndexEntry'],
  },
  {
    kind: 'claude-job-timeline',
    profileId: 'claude-code-session',
    disposition: 'profiled',
    locator: 'path',
    strongPatterns: [/(^|\/)\.claude\/jobs\/[^/]+\/timeline\.jsonl$/],
    sourceAnchors: ['.claude/jobs/<job>/timeline.jsonl runtime-observation'],
  },
  {
    kind: 'codex-rollout',
    profileId: 'codex-rollout',
    disposition: 'profiled',
    locator: 'path',
    strongPatterns: [
      /(^|\/)sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/,
      /(^|\/)archived_sessions\/rollout-[^/]+\.jsonl$/,
    ],
    weakBasenames: ['rollout-*.jsonl'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/rollout/src/recorder.rs:JsonlWriter::write_rollout_item',
    sourceAnchors: ['codex-rs/rollout/src/lib.rs:SESSIONS_DIR', 'codex-rs/rollout/src/recorder.rs:JsonlWriter::write_rollout_item', 'codex-rs/rollout/src/metadata.rs:collect_rollout_paths'],
  },
  {
    kind: 'claude-history',
    profileId: 'claude-code-session',
    disposition: 'profiled',
    locator: 'content',
    strongPatterns: [],
    weakBasenames: ['history.jsonl'],
    sourceAnchors: ['Claude history.jsonl runtime-observation'],
  },
  {
    kind: 'claude-transcript',
    profileId: 'claude-code-session',
    disposition: 'profiled',
    locator: 'content',
    strongPatterns: [],
    sourceAnchors: ['Claude transcript runtime-observation'],
  },
  {
    kind: 'codex-exec-jsonl',
    profileId: 'codex-exec-jsonl',
    disposition: 'profiled',
    locator: 'content',
    strongPatterns: [],
    requiredPaths: ['type', 'item.id', 'item.type'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/exec/src/event_processor_with_jsonl_output.rs:serde_json::to_string + println',
    sourceAnchors: ['codex-rs/exec/src/exec_events.rs:ThreadEvent', 'codex-rs/exec/src/exec_events.rs:ThreadItem'],
  },
  {
    kind: 'codex-trace',
    profileId: 'codex-trace',
    disposition: 'profiled',
    // A basename is only a weak hint. A sibling manifest is not available in
    // the current detection API, so bytes carry the runtime identity.
    locator: 'content',
    strongPatterns: [],
    weakBasenames: ['trace.jsonl'],
    companionFiles: ['manifest.json', 'payloads/', 'state.json'],
    requiredPaths: ['schema_version', 'seq', 'wall_time_unix_ms', 'rollout_id', 'payload'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/rollout-trace/src/writer.rs:serde_json::to_writer + newline',
    sourceAnchors: ['codex-rs/rollout-trace/src/raw_event.rs:RawTraceEvent', 'codex-rs/rollout-trace/src/bundle.rs:trace.jsonl'],
  },
  {
    kind: 'codex-tui-session-log',
    profileId: 'generic',
    disposition: 'generic-compatible',
    locator: 'content',
    strongPatterns: [/(^|\/)\.codex\/log\/session-\d{8}t\d{6}z\.jsonl$/],
    weakBasenames: ['session-*.jsonl'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/tui/src/session_log.rs:write_json_line',
    requiredPaths: ['ts', 'dir', 'kind'],
    sourceAnchors: ['codex-rs/tui/src/session_log.rs:CODEX_TUI_RECORD_SESSION'],
  },
  {
    kind: 'codex-analytics-capture',
    profileId: 'generic',
    disposition: 'generic-compatible',
    locator: 'content',
    strongPatterns: [],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/analytics/src/analytics_capture.rs:serde_json::to_vec + newline',
    requiredPaths: ['events'],
    sourceAnchors: ['codex-rs/analytics/src/analytics_capture.rs:CODEX_ANALYTICS_EVENTS_CAPTURE_FILE'],
  },
  {
    kind: 'codex-app-server',
    profileId: 'generic',
    disposition: 'generic-compatible',
    locator: 'content',
    strongPatterns: [],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/app-server-transport/src/transport/stdio.rs:serialize + newline',
    requiredPaths: ['method|id|result|error'],
    sourceAnchors: ['codex-rs/app-server/README.md:stdio JSONL', 'codex-rs/app-server-protocol/src/rpc.rs:JSONRPCMessage'],
  },
  {
    kind: 'codex-app-server-log',
    profileId: 'structured-application-log',
    disposition: 'profiled',
    locator: 'content',
    strongPatterns: [],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/app-server/src/lib.rs:tracing_subscriber::fmt::layer().json -> stderr',
    requiredPaths: ['timestamp', 'level', 'fields.message', 'target'],
    sourceAnchors: ['codex-rs/app-server/src/lib.rs:LOG_FORMAT_ENV_VAR', 'codex-rs/app-server/src/lib.rs:LogFormat::Json'],
  },
  {
    kind: 'codex-compressed-rollout',
    profileId: 'generic',
    disposition: 'explicitly-unsupported',
    locator: 'path',
    strongPatterns: [],
    weakBasenames: ['*.jsonl.zst'],
    producerRepository: 'openai/codex',
    producerRevision: CODEX_SOURCE_REVISION,
    serializationAnchor: 'codex-rs/rollout/src/recorder.rs:JsonlWriter::write_rollout_item',
    sourceAnchors: ['codex-rs/rollout:compressed rollout artifacts'],
  },
];

export interface ShapeDiscoveryOptions {
  maxDepth?: number;
  maxNodesPerRecord?: number;
  maxArrayEntries?: number;
  maxDistinctValues?: number;
}

const DEFAULT_OPTIONS: Required<ShapeDiscoveryOptions> = {
  maxDepth: 4,
  maxNodesPerRecord: 256,
  maxArrayEntries: 8,
  maxDistinctValues: 16,
};

/**
 * Discover repeated field shapes without depending on a provider vocabulary.
 * Provider adapters can use this as a second signal beside source contracts.
 */
export function discoverShape(
  samples: readonly { value: unknown }[],
  options: ShapeDiscoveryOptions = {},
): ShapeDiscovery {
  const bounded = { ...DEFAULT_OPTIONS, ...options };
  const fields = new Map<string, MutableShapeField>();
  let objectRecords = 0;

  for (const sample of samples) {
    if (isObject(sample.value)) objectRecords += 1;
    const seen = new Set<string>();
    walk(sample.value, { tokens: [] }, 0, bounded, (path, value) => {
      const encoded = JSON.stringify(path.tokens);
      if (seen.has(encoded)) return;
      seen.add(encoded);
      let field = fields.get(encoded);
      if (field === undefined) {
        field = {
          path,
          presentRecords: 0,
          kinds: new Set<JsonKind>(),
          stringValues: new Map<string, number>(),
        };
        fields.set(encoded, field);
      }
      field.presentRecords += 1;
      field.kinds.add(jsonKindOf(value));
      if (typeof value === 'string' && value.length <= 256) {
        field.stringValues.set(value, (field.stringValues.get(value) ?? 0) + 1);
      }
    });
  }

  const ordered = [...fields.values()]
    .sort((left, right) => left.path.tokens.length - right.path.tokens.length
      || displayFieldPath(left.path).localeCompare(displayFieldPath(right.path)))
    .map((field): ShapeField => ({
      path: field.path,
      displayPath: displayFieldPath(field.path),
      presentRecords: field.presentRecords,
      kinds: [...field.kinds].sort(),
      stringValues: [...field.stringValues.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, bounded.maxDistinctValues)
        .map(([value]) => value),
    }));

  const discriminator = inferDiscriminatorFromShape(ordered, samples.length);
  return {
    sampleCount: samples.length,
    objectRecords,
    fields: ordered,
    ...(discriminator === undefined ? {} : { discriminator }),
  };
}

/** Infer common semantic signals from one record, including nested envelopes. */
export function inferRecordSignals(
  value: unknown,
  options: ShapeDiscoveryOptions = {},
): RecordSignals {
  const bounded = { ...DEFAULT_OPTIONS, ...options };
  const candidates: Candidate[] = [];
  walk(value, { tokens: [] }, 0, bounded, (path, fieldValue) => {
    if (path.tokens.length === 0) return;
    const token = path.tokens.at(-1);
    if (token?.kind !== 'key') return;
    const key = String(token.value);
    if (typeof fieldValue === 'string' && fieldValue.length > 0) {
      candidates.push({ path, key, value: fieldValue, kind: 'string' });
      return;
    }
    if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
      candidates.push({ path, key, value: String(fieldValue), kind: 'number' });
    }
  });

  const discriminator = bestCandidate(candidates, discriminatorScore);
  const timestamp = bestCandidate(candidates, timestampScore, (candidate) => isTimestamp(candidate.key, candidate.value));
  const actor = bestCandidate(candidates, actorScore);
  const summary = bestCandidate(candidates, summaryScore, (candidate) => candidate.kind === 'string');
  const identities = candidates
    .filter((candidate) => identityScore(candidate) > 0)
    .sort((left, right) => identityScore(right) - identityScore(left) || left.path.tokens.length - right.path.tokens.length)
    .slice(0, 6)
    .map(toInferredField);

  return {
    ...(discriminator === undefined ? {} : { discriminator: toInferredField(discriminator) }),
    ...(timestamp === undefined ? {} : { timestamp: toInferredField(timestamp) }),
    ...(actor === undefined ? {} : { actor: toInferredField(actor) }),
    ...(summary === undefined ? {} : { summary: toInferredField(summary) }),
    identities,
  };
}

/** Read a field by a structured path; never evaluates a path as code. */
export function valueAtPath(value: unknown, path: FieldPath): unknown {
  let current = value;
  for (const token of path.tokens) {
    if (token.kind === 'key') {
      if (!isObject(current)) return undefined;
      current = own(current, String(token.value));
    } else {
      if (!Array.isArray(current)) return undefined;
      if (typeof token.value !== 'number') return undefined;
      current = current[token.value];
    }
  }
  return current;
}

/** Filename hints are deliberately weak; callers must still validate shape. */
export function sourceSurfaceHint(sourcePathHint: string | undefined): string | undefined {
  return sourceSurfaceEvidence(sourcePathHint)?.kind;
}

/**
 * Classify only the producer path shapes we can defend from source study.
 * Basenames alone are weak evidence because users routinely rename/copy logs;
 * callers must combine this result with record-shape evidence before selecting
 * a specialized profile.
 */
export function sourceSurfaceEvidence(sourcePathHint: string | undefined): SourceSurfaceEvidence | undefined {
  if (sourcePathHint === undefined) return undefined;
  const normalized = sourcePathHint.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  for (const descriptor of SOURCE_SURFACE_CATALOG) {
    if (descriptor.strongPatterns.some((pattern) => pattern.test(normalized))) {
      return evidenceFromDescriptor(descriptor, 'strong');
    }
  }
  // Weak hints are retained for suggestions and diagnostics, never treated as
  // identity proof by a profile.
  const weakMatches = SOURCE_SURFACE_CATALOG.filter((descriptor) =>
    descriptor.weakBasenames?.some((pattern) => matchesBasename(basename, pattern)) === true,
  );
  // `history.jsonl` is used by multiple producers. An ambiguous basename is
  // intentionally not a hint at all; the bytes must carry the decision.
  if (weakMatches.length === 1) {
    const descriptor = weakMatches[0]!;
    return evidenceFromDescriptor(descriptor, 'weak', patternForWeakName(descriptor));
  }
  if (/(^|\/)(sessions|archived_sessions)\//.test(normalized)) {
    const descriptor = SOURCE_SURFACE_CATALOG.find((item) => item.kind === 'codex-rollout');
    return descriptor === undefined ? undefined : evidenceFromDescriptor(descriptor, 'weak', 'sessions/**');
  }
  return undefined;
}

function evidenceFromDescriptor(
  descriptor: SourceSurfaceDescriptor,
  strength: 'strong' | 'weak',
  pattern = descriptor.sourceAnchors[0] ?? descriptor.kind,
): SourceSurfaceEvidence {
  return {
    kind: descriptor.kind,
    strength,
    disposition: descriptor.disposition,
    locator: descriptor.locator,
    ...(descriptor.companionFiles === undefined ? {} : { companionFiles: descriptor.companionFiles }),
    pattern,
  };
}

function matchesBasename(basename: string, pattern: string): boolean {
  if (!pattern.includes('*')) return basename === pattern;
  const prefix = pattern.slice(0, pattern.indexOf('*'));
  const suffix = pattern.slice(pattern.indexOf('*') + 1);
  return basename.startsWith(prefix) && basename.endsWith(suffix);
}

function patternForWeakName(descriptor: SourceSurfaceDescriptor): string {
  return descriptor.weakBasenames?.[0] ?? descriptor.kind;
}

interface MutableShapeField {
  path: FieldPath;
  presentRecords: number;
  kinds: Set<JsonKind>;
  stringValues: Map<string, number>;
}

interface Candidate {
  path: FieldPath;
  key: string;
  value: string;
  kind: 'string' | 'number';
}

function walk(
  value: unknown,
  path: FieldPath,
  depth: number,
  options: Required<ShapeDiscoveryOptions>,
  visit: (path: FieldPath, value: unknown) => void,
  state: { nodes: number } = { nodes: 0 },
): void {
  if (state.nodes >= options.maxNodesPerRecord) return;
  state.nodes += 1;
  visit(path, value);
  if (depth >= options.maxDepth) return;

  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, options.maxArrayEntries); index += 1) {
      walk(value[index], appendPath(path, { kind: 'index', value: index }), depth + 1, options, visit, state);
      if (state.nodes >= options.maxNodesPerRecord) return;
    }
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    walk(child, appendPath(path, { kind: 'key', value: key }), depth + 1, options, visit, state);
    if (state.nodes >= options.maxNodesPerRecord) return;
  }
}

function appendPath(path: FieldPath, token: PathToken): FieldPath {
  return { tokens: [...path.tokens, token] };
}

function inferDiscriminatorFromShape(fields: readonly ShapeField[], sampleCount: number): InferredField | undefined {
  const candidates = fields
    .filter((field) => field.stringValues.length > 0)
    .map((field) => {
      const token = field.path.tokens.at(-1);
      if (token?.kind !== 'key') return undefined;
      const key = String(token.value);
      const values = field.stringValues;
      const repetition = values.length === 1 && sampleCount > 1 ? 0.4 : Math.min(1, values.length / 4);
      const score = discriminatorKeyScore(key) + 0.25 * (field.presentRecords / Math.max(1, sampleCount)) + 0.15 * repetition;
      return { path: field.path, key, value: values[0]!, score };
    })
    .filter((candidate): candidate is InferredField => candidate !== undefined && candidate.score > 0.35)
    .sort((left, right) => right.score - left.score || left.path.tokens.length - right.path.tokens.length);
  return candidates[0];
}

function bestCandidate(
  candidates: readonly Candidate[],
  scorer: (candidate: Candidate) => number,
  predicate: (candidate: Candidate) => boolean = () => true,
): Candidate | undefined {
  return candidates
    .filter(predicate)
    .map((candidate) => ({ candidate, score: scorer(candidate) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.path.tokens.length - right.candidate.path.tokens.length)[0]?.candidate;
}

function toInferredField(candidate: Candidate): InferredField {
  return {
    path: candidate.path,
    key: candidate.key,
    value: candidate.value,
    score: Math.min(1, Math.max(0, candidateScore(candidate))),
  };
}

function candidateScore(candidate: Candidate): number {
  return Math.max(
    discriminatorScore(candidate),
    timestampScore(candidate),
    actorScore(candidate),
    summaryScore(candidate),
    identityScore(candidate),
  );
}

function discriminatorScore(candidate: Candidate): number {
  return discriminatorKeyScore(candidate.key);
}

function discriminatorKeyScore(key: string): number {
  const normalized = normalizeKey(key);
  if (normalized === 'type' || normalized === 'event' || normalized === 'eventtype' || normalized === 'eventkind' || normalized === 'kind') return 0.95;
  if (normalized === 'operation' || normalized === 'op' || normalized === 'state' || normalized === 'status') return 0.7;
  return 0;
}

function timestampScore(candidate: Candidate): number {
  const key = normalizeKey(candidate.key);
  if (key === 'timestamp' || key === 'datetime' || key === 'time' || key === 'at') return 0.9;
  if (key.endsWith('timestamp') || key.endsWith('time') || key.endsWith('at') || key === 'ts' || key === 'date') return 0.72;
  return 0;
}

function actorScore(candidate: Candidate): number {
  const key = normalizeKey(candidate.key);
  return key === 'role' || key === 'actor' || key === 'author' || key === 'speaker' || key === 'sender' ? 0.9 : 0;
}

function summaryScore(candidate: Candidate): number {
  if (candidate.kind !== 'string') return 0;
  const key = normalizeKey(candidate.key);
  if (key === 'text' || key === 'message' || key === 'msg' || key === 'content' || key === 'body') return 0.9;
  if (key === 'summary' || key === 'description' || key === 'display' || key === 'title' || key === 'threadname') return 0.82;
  if (key === 'id' || key.endsWith('id') || key.includes('path') || key.includes('url')) return 0;
  return candidate.value.length >= 8 ? 0.28 : 0;
}

function identityScore(candidate: Candidate): number {
  const key = normalizeKey(candidate.key);
  if (key === 'id' || key === 'uuid' || key === 'sessionid' || key === 'session' || key === 'threadid' || key === 'turnid') return 0.88;
  if (key.endsWith('id')) return 0.65;
  return 0;
}

function isTimestamp(key: string, value: string): boolean {
  const normalized = normalizeKey(key);
  if (!(normalized.includes('time') || normalized.includes('date') || normalized.endsWith('at') || normalized === 'ts' || normalized === 'at')) return false;
  if (/^\d+(?:\.\d+)?$/.test(value)) return true;
  return !Number.isNaN(Date.parse(value));
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function jsonKindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isInteger(value) ? 'integer' : 'number';
    case 'object': return 'object';
    default: return 'null';
  }
}
