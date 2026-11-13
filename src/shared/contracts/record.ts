import type { DatasetRecordSummary } from './dataset-summary';
import type { BfclV3RecordSummary } from './bfcl-v3-insights';
import type { OpenTelemetryRecordSummary } from './otel-insights';
import type { SnapshotIdentity } from './identity';
import type { RowProjectionPlan, RowSort, ScanTruncationReason } from './query';

export const MAX_CONVERSATION_CHARACTERS = 2048;
export const MAX_CONVERSATION_PARTS = 8;
export const MAX_CONVERSATION_DEPTH = 12;
export const MAX_CONVERSATION_VISITS = 96;
export const MAX_CONVERSATION_ROLE_CHARACTERS = 32;
export const MAX_CONVERSATION_LABEL_CHARACTERS = 40;

export type JsonScalar = string | number | boolean | null;
export type JsonKind = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
export type ParseState = 'unknown' | 'valid' | 'invalid_json' | 'blank' | 'encoding_error' | 'oversized';

export interface PathToken { kind: 'key' | 'index'; value: string | number }
export interface FieldPath { tokens: PathToken[] }

export interface RecordRef {
  generation: string;
  ordinal: string;
  byteStart: string;
  byteEndExclusive: string;
  contentByteLength: string;
  delimiterByteLength: 0 | 1 | 2;
  parseState: ParseState;
}

const RECORD_REF_KEYS = new Set([
  'generation', 'ordinal', 'byteStart', 'byteEndExclusive', 'contentByteLength', 'delimiterByteLength', 'parseState',
]);
const RECORD_REF_PARSE_STATES = new Set<ParseState>([
  'unknown', 'valid', 'invalid_json', 'blank', 'encoding_error', 'oversized',
]);

/** Strict shape and current-generation validation; host code still verifies indexed-location evidence. */
export function isCurrentRecordRef(value: unknown, generation: string): value is RecordRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== RECORD_REF_KEYS.size || keys.some((key) => typeof key !== 'string' || !RECORD_REF_KEYS.has(key))) return false;

  const ref = value as Record<string, unknown>;
  const decimal = (item: unknown): item is string => typeof item === 'string'
    && item.length <= 64 && /^(?:0|[1-9]\d*)$/u.test(item);
  if (ref.generation !== generation || !decimal(ref.ordinal) || !decimal(ref.byteStart)
    || !decimal(ref.byteEndExclusive) || !decimal(ref.contentByteLength)
    || (ref.delimiterByteLength !== 0 && ref.delimiterByteLength !== 1 && ref.delimiterByteLength !== 2)
    || typeof ref.parseState !== 'string' || !RECORD_REF_PARSE_STATES.has(ref.parseState as ParseState)) return false;

  // byteEndExclusive excludes the delimiter, including for LF and CRLF records.
  return BigInt(ref.byteEndExclusive) - BigInt(ref.byteStart) === BigInt(ref.contentByteLength);
}

export interface CellProjection {
  columnId: string;
  kind?: JsonKind;
  value?: JsonScalar;
  preview?: string;
  truncated?: boolean;
}

export interface ProblemRef {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  ref?: RecordRef;
}

export type AgentEventKind =
  | 'session' | 'turn' | 'message' | 'log' | 'span' | 'metric' | 'task' | 'action' | 'observation' | 'patch' | 'test'
  | 'result' | 'reasoning' | 'tool_call' | 'tool_result' | 'subagent' | 'approval' | 'usage' | 'error' | 'checkpoint' | 'other';

export interface AgentEvidence { field: string; path: FieldPath }

export interface AgentRowProjection {
  profileId: string;
  eventKind: AgentEventKind;
  timestamp?: string;
  actor?: 'user' | 'assistant' | 'tool' | 'system' | 'developer' | 'agent' | 'unknown';
  sessionId?: string;
  turnId?: string;
  parentId?: string;
  messageId?: string;
  toolCallId?: string;
  subagentId?: string;
  model?: string;
  status?: string;
  severity?: string;
  summary: string;
  usage?: { input?: number; output?: number; cached?: number; total?: number };
  derivedFields?: Record<string, JsonScalar>;
  evidence: AgentEvidence[];
  confidence: 'source' | 'correlated' | 'inferred';
}

/** Bounded source text, separate from lossy table-cell previews. Never a full transcript. */
export interface ConversationProjection {
  parts: Array<{ role: string; label: string; text: string; path: FieldPath }>;
  truncated: boolean;
}

export interface RowProjection {
  ref: RecordRef;
  kind?: JsonKind;
  cells: CellProjection[];
  genericSummary: string;
  conversation?: ConversationProjection;
  /** Generic record observations; never attached to provider session profiles. */
  dataset?: DatasetRecordSummary;
  /** Optional profile-owned dataset observations; source bodies never cross IPC. */
  datasetInsights?: { bfclV3?: BfclV3RecordSummary; opentelemetry?: OpenTelemetryRecordSummary };
  profile?: AgentRowProjection;
  problems?: ProblemRef[];
}

export interface FieldStats {
  path: FieldPath;
  displayPath: string;
  seenRecords: string;
  validRecordsObserved: string;
  kinds: Partial<Record<JsonKind, string>>;
  missingRecords: string;
  nullRecords: string;
  examples: string[];
  firstSeenOrdinal: string;
  lastSeenOrdinal: string;
  confidence: 'sampled' | 'complete' | 'stale';
}

export interface ColumnSpec {
  id: string;
  label: string;
  path?: FieldPath;
  source: 'record' | 'profile' | 'system';
  width?: number;
}

/** Maximum number of explicit table fields carried by one rows request. */
export const MAX_TABLE_COLUMNS = 64;

export interface RowPage {
  rows: RowProjection[];
  columns: ColumnSpec[];
  projection?: RowProjectionPlan;
  anchorOrdinal: string;
  hasBefore: boolean;
  hasAfter: boolean;
  indexedRecords: string;
  totalRecords?: string;
  sort?: RowSort;
  sortOffset?: string;
  sortNextOffset?: string;
  matchedRecords?: string;
  scan?: RowScanStats;
}

/** A bounded page of individual problem entries, independent of visible rows. */
export interface ProblemPage {
  items: ProblemRef[];
  anchorOrdinal: string;
  hasBefore: boolean;
  hasAfter: boolean;
  indexedRecords: string;
  observedProblemRecords: string;
  complete: boolean;
  scan: RowScanStats;
}

export interface RowScanStats {
  examinedRecords: string;
  examinedBytes: string;
  cursorOrdinal?: string;
  direction?: 'forward' | 'backward';
  truncatedReason?: ScanTruncationReason;
}

export interface RecordDetail {
  ref: RecordRef;
  rawPreview: string;
  rawComplete: boolean;
  value?: unknown;
  profile?: AgentRowProjection;
  problems: ProblemRef[];
}

export type DatasetShapeV1 = 'sft' | 'preference' | 'tool-use' | 'multimodal' | 'sharegpt' | 'virtualhome'
  | 'sft-master-conversation' | 'keyword-result' | 'unknown';

export interface DatasetHeadPlanV1 { strategy: 'head'; maxRecords: 32; maxBytes: 262144 }
export interface DatasetHeadCoverageV1 {
  sampledRecords: number;
  validRecords: number;
  invalidRecords: number;
  examinedBytes: string;
  partial: boolean;
  stoppedBy?: 'record_limit' | 'byte_limit' | 'time_limit' | 'hydration_limit' | 'uninspectable_record';
}
export interface DatasetResultV1 {
  version: 1;
  framing: 'jsonl';
  samplePlan: DatasetHeadPlanV1;
  adapterId: 'llamafactory-v1' | 'sharegpt-v1' | 'virtualhome-v1' | 'sft-master-conversation-v1' | 'sft-master-keyword-result-v1' | 'generic-jsonl';
  adapterVersion: '1.0.0';
  shape: DatasetShapeV1;
  confidence: 'high' | 'medium' | 'none';
  clockBasis: 'none' | 'record-order';
  coverage: DatasetHeadCoverageV1;
}
export type DatasetDetectionStageV1 = 'not-started' | 'head-hydration' | 'head-inspection' | 'profile-sampling' | 'profile-classification';
export type DatasetDetectionTerminalStatusV1 = 'failed' | 'timeout' | 'cancelled' | 'disabled';
export interface DatasetDetectionTerminalV1 {
  stage: DatasetDetectionStageV1;
  code: 'detection_failed' | 'deadline_exceeded' | 'operation_cancelled' | 'auto_detection_disabled';
  retryable: boolean;
  action: 'reload' | 'none' | 'enable-auto-detection';
}
export type DatasetRuntimeProvenanceV1 =
  | { version: 1; status: 'pending'; samplePlan: DatasetHeadPlanV1 }
  | { version: 1; status: DatasetDetectionTerminalStatusV1; samplePlan: DatasetHeadPlanV1; terminal: DatasetDetectionTerminalV1 }
  | (DatasetResultV1 & { status: 'ready' | 'partial'; fallback?: never })
  | (DatasetResultV1 & { status: 'fallback'; fallback: {
    code: 'unknown_shape' | 'conflicting_shapes' | 'invalid_sample' | 'unsupported_framing' | 'sample_unavailable' | 'inspection_failed';
    candidateShapes: readonly DatasetShapeV1[];
  } });

export interface DocumentSummary {
  snapshot: SnapshotIdentity;
  profileId: string;
  profileVersion?: string | undefined;
  profileEpoch?: number | undefined;
  datasetProvenance?: DatasetRuntimeProvenanceV1 | undefined;
  profileSuggestions: ProfileSuggestion[];
  indexedBytes: string;
  indexedRecords: string;
  indexingComplete: boolean;
  validRecords: string;
  problemRecords: string;
}
export interface ProfileSuggestion { id: string; displayName: string; score: number; reasons: string[] }

/** Metadata about an owned temporary source; saved denotes a separate copy. */
export interface TemporaryPreviewStatus { status: 'temporary' | 'saving' | 'saved'; recordCount: number; sizeBytes: number; savedCopy: boolean }

export function keyPath(...keys: string[]): FieldPath {
  return { tokens: keys.map((value) => ({ kind: 'key' as const, value })) };
}

export function displayFieldPath(path: FieldPath): string {
  if (path.tokens.length === 0) return '$';
  return path.tokens.reduce<string>((result, token) => {
    if (token.kind === 'index') return `${result}[${String(token.value)}]`;
    const key = String(token.value);
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${result}.${key}` : `${result}[${JSON.stringify(key)}]`;
  }, '$');
}
