export const PROTOCOL_VERSION = 1 as const;
export const MAX_DIAGNOSTIC_CODE_LENGTH = 128;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 512;

export type JsonScalar = string | number | boolean | null;
export type JsonKind =
  | 'object'
  | 'array'
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'null';

export type ParseState =
  | 'unknown'
  | 'valid'
  | 'invalid_json'
  | 'blank'
  | 'encoding_error'
  | 'oversized';

export interface PathToken {
  kind: 'key' | 'index';
  value: string | number;
}

export interface FieldPath {
  tokens: PathToken[];
}

export interface SnapshotIdentity {
  documentId: string;
  generation: string;
  /** Optional monotonic lifecycle epoch. Older protocol fixtures may omit it. */
  epoch?: number;
  uri: string;
  scheme: string;
  sizeBytes: string;
  mtimeMs: number;
  device?: string;
  inode?: string;
  prefixFingerprint: string;
  observedAt: string;
}

export interface RecordRef {
  generation: string;
  ordinal: string;
  byteStart: string;
  byteEndExclusive: string;
  contentByteLength: string;
  delimiterByteLength: 0 | 1 | 2;
  parseState: ParseState;
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
  | 'session'
  | 'turn'
  | 'message'
  | 'log'
  | 'span'
  | 'task'
  | 'action'
  | 'observation'
  | 'patch'
  | 'test'
  | 'result'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'subagent'
  | 'approval'
  | 'usage'
  | 'error'
  | 'checkpoint'
  | 'other';

export interface AgentEvidence {
  field: string;
  path: FieldPath;
}

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
  usage?: {
    input?: number;
    output?: number;
    cached?: number;
    total?: number;
  };
  derivedFields?: Record<string, JsonScalar>;
  evidence: AgentEvidence[];
  confidence: 'source' | 'correlated' | 'inferred';
}

export interface RowProjection {
  ref: RecordRef;
  kind?: JsonKind;
  cells: CellProjection[];
  genericSummary: string;
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

export type CompareOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

export type RowFilterOperator =
  | CompareOperator
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'exists'
  | 'is_null'
  | 'kind_is';

/** A serializable field filter that the Webview can turn into a Predicate. */
export interface RowFilter {
  columnId: string;
  operator: RowFilterOperator;
  value?: JsonScalar;
  caseSensitive?: boolean;
  kind?: JsonKind;
  /**
   * Captured at apply time so a restored filter remains executable while the
   * first post-rebuild page is still waiting for fresh column metadata.
   */
  source?: 'record' | 'profile';
  path?: FieldPath;
}

export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | { op: 'compare'; path: FieldPath; cmp: CompareOperator; value: JsonScalar }
  | { op: 'contains' | 'starts_with' | 'ends_with'; path: FieldPath; value: string; caseSensitive: boolean }
  | { op: 'exists' | 'is_null'; path: FieldPath }
  | { op: 'kind_is'; path: FieldPath; kind: JsonKind }
  | { op: 'text_search'; value: string; caseSensitive: boolean; paths?: FieldPath[] }
  | { op: 'profile_field'; field: string; cmp: CompareOperator; value: JsonScalar }
  | { op: 'profile_text'; field: string; cmp: 'contains' | 'starts_with' | 'ends_with'; value: string; caseSensitive: boolean }
  | { op: 'profile_exists' | 'profile_is_null'; field: string };

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
  anchorOrdinal: string;
  hasBefore: boolean;
  hasAfter: boolean;
  indexedRecords: string;
  totalRecords?: string;
  /** Echoes the logical ordering used for this page, when present. */
  sort?: RowSort;
  /** Logical zero-based rank; absent for physical ordinal cursor pages. */
  sortOffset?: string;
  /** Next logical offset when a bounded sorted page returned fewer rows than requested. */
  sortNextOffset?: string;
  /** Number of records matching the predicate in the bounded scan result. */
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
  /** Schema-tracker problem records observed during hydration; not a complete-file total. */
  observedProblemRecords: string;
  /** True only when the problem scan reached the source boundary without truncation. */
  complete: boolean;
  scan: RowScanStats;
}

/** Bounded work allowance for a potentially sparse row/filter scan. */
export interface RowScanBudget {
  maxExaminedRecords?: number;
  maxExaminedBytes?: string | bigint;
  deadlineEpochMs?: number;
}

export type ScanTruncationReason =
  | 'record_limit'
  | 'byte_limit'
  | 'time_limit'
  | 'hydration_limit'
  | 'uninspectable_record';

export interface RowScanStats {
  examinedRecords: string;
  examinedBytes: string;
  cursorOrdinal?: string;
  /** Physical direction needed to resume a truncated unsorted scan. */
  direction?: 'forward' | 'backward';
  truncatedReason?: ScanTruncationReason;
}

export type SortDirection = 'asc' | 'desc';

export interface RowSort {
  columnId: string;
  direction: SortDirection;
}

export interface RecordDetail {
  ref: RecordRef;
  rawPreview: string;
  rawComplete: boolean;
  value?: unknown;
  profile?: AgentRowProjection;
  problems: ProblemRef[];
}

export type DatasetShapeV1 = 'sft' | 'preference' | 'tool-use' | 'multimodal' | 'unknown';

export interface DatasetHeadPlanV1 {
  strategy: 'head';
  maxRecords: 32;
  maxBytes: 262144;
}

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
  adapterId: 'llamafactory-v1' | 'generic-jsonl';
  adapterVersion: '1.0.0';
  shape: DatasetShapeV1;
  confidence: 'high' | 'medium' | 'none';
  clockBasis: 'none' | 'record-order';
  coverage: DatasetHeadCoverageV1;
}

export type DatasetDetectionStageV1 = 'not-started' | 'head-hydration' | 'head-inspection'
  | 'profile-sampling' | 'profile-classification';
export type DatasetDetectionTerminalStatusV1 = 'failed' | 'timeout' | 'cancelled' | 'disabled';
export interface DatasetDetectionTerminalV1 {
  stage: DatasetDetectionStageV1;
  code: 'detection_failed' | 'deadline_exceeded' | 'operation_cancelled' | 'auto_detection_disabled';
  retryable: boolean;
  action: 'reload' | 'none' | 'enable-auto-detection';
}

/** Metadata only. Inspector records, values, reasons, and source hints never cross IPC. */
export type DatasetRuntimeProvenanceV1 =
  | { version: 1; status: 'pending'; samplePlan: DatasetHeadPlanV1 }
  | { version: 1; status: DatasetDetectionTerminalStatusV1; samplePlan: DatasetHeadPlanV1; terminal: DatasetDetectionTerminalV1 }
  | (DatasetResultV1 & { status: 'ready' | 'partial'; fallback?: never })
  | (DatasetResultV1 & { status: 'fallback'; fallback: {
    code: 'unknown_shape' | 'conflicting_shapes' | 'invalid_sample' | 'sample_unavailable' | 'inspection_failed';
    candidateShapes: readonly DatasetShapeV1[];
  } });

export interface DocumentSummary {
  snapshot: SnapshotIdentity;
  profileId: string;
  /** Selected semantic adapter revision. Older protocol fixtures may omit it. */
  profileVersion?: string | undefined;
  /** Monotonic profile publication identity; older protocol fixtures may omit it. */
  profileEpoch?: number | undefined;
  datasetProvenance?: DatasetRuntimeProvenanceV1 | undefined;
  profileSuggestions: ProfileSuggestion[];
  indexedBytes: string;
  indexedRecords: string;
  indexingComplete: boolean;
  validRecords: string;
  problemRecords: string;
}

export interface ProfileSuggestion {
  id: string;
  displayName: string;
  score: number;
  reasons: string[];
}

export type InsightDimension = 'eventKind' | 'severity' | 'service' | 'status';
export type InsightScope = 'current-view' | 'whole-file';

export interface AnalysisIntentV1 {
  version: 1;
  intentRevision: number;
  dimension: InsightDimension;
  scope: InsightScope;
  document: {
    documentId: string;
    generation: string;
    sourceEpoch?: number;
  };
  profile: {
    id: string;
    /** Existing AgentProfile.version; this is the adapter/projection revision. */
    version: string;
  };
  /** Canonical typed predicate for current-view analysis. Absent for whole-file analysis. */
  predicate?: Predicate;
}

export interface InsightProvenance {
  scope: InsightScope;
  predicateApplied: boolean;
  coverage: 'complete' | 'bounded';
}

export interface InsightCategory {
  label: string;
  count: number;
  approximate?: boolean;
}

export interface InsightTimeBucket {
  start: string;
  count: number;
}

export interface InsightSummary {
  intent: AnalysisIntentV1;
  provenance: InsightProvenance;
  categories: InsightCategory[];
  timeBuckets: InsightTimeBucket[];
  processedRecords: string;
  examinedRecords: string;
  examinedBytes: string;
  truncated: boolean;
  truncatedReason?: ScanTruncationReason;
  capacityReached: boolean;
  bucketWidthMs: number;
}

export interface ProtocolEnvelope<TType extends string, TPayload> {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: TType;
  documentId: string;
  generation: string;
  /** Optional monotonic lifecycle epoch for ordering unseen generations. */
  epoch?: number;
  requestId: string;
  payload: TPayload;
}

export type WebviewRequest =
  | ProtocolEnvelope<'READY', { restoredState?: unknown }>
  | ProtocolEnvelope<'GET_ROWS', {
    /** Exclusive physical cursor, including ordinal sorted pages. */
    anchorOrdinal?: string;
    /** Physical scan direction, independent of display order. */
    direction?: 'forward' | 'backward';
    limit: number;
    predicate?: Predicate;
    /** Bounded record fields requested for the table projection. */
    columns?: ColumnSpec[];
    sort?: RowSort;
    sortOffset?: string;
    scanBudget?: RowScanBudget;
  }>
  | ProtocolEnvelope<'GET_PROBLEMS', {
    anchorOrdinal?: string;
    direction?: 'forward' | 'backward';
    limit: number;
    scanBudget?: RowScanBudget;
  }>
  | ProtocolEnvelope<'GET_DETAIL', { ref: RecordRef; full?: boolean }>
  | ProtocolEnvelope<'GET_SCHEMA', { offset: number; limit: number }>
  | ProtocolEnvelope<'GET_INSIGHTS', { intent: AnalysisIntentV1 }>
  | ProtocolEnvelope<'SET_PROFILE', { profileId: string }>
  | ProtocolEnvelope<'SET_FOLLOW_MODE', { enabled: boolean }>
  | ProtocolEnvelope<'SET_ROW_ORDER', { direction: RowSort['direction'] }>
  | ProtocolEnvelope<'OPEN_SESSION_NAVIGATOR', Record<string, never>>
  | ProtocolEnvelope<'DIAGNOSE_ERROR', { code: string; message: string; action?: 'explain' | 'copy' }>
  | ProtocolEnvelope<'CANCEL', { targetRequestId: string }>
  | ProtocolEnvelope<'REBUILD_INDEX', Record<string, never>>;

export type ExtensionMessage =
  | ProtocolEnvelope<'OPENED', DocumentSummary>
  | ProtocolEnvelope<'ROWS', RowPage>
  | ProtocolEnvelope<'PROBLEMS', ProblemPage>
  | ProtocolEnvelope<'DETAIL', RecordDetail>
  | ProtocolEnvelope<'SCHEMA', { fields: FieldStats[]; totalFields: number; complete: boolean }>
  | ProtocolEnvelope<'INSIGHTS', InsightSummary>
  | ProtocolEnvelope<'INDEX_PROGRESS', DocumentSummary>
  | ProtocolEnvelope<'PROFILE_CHANGED', { profileId: string; profileVersion?: string; profileEpoch?: number; columns: ColumnSpec[] }>
  | ProtocolEnvelope<'ROW_ORDER_CHANGED', { direction: RowSort['direction'] }>
  | ProtocolEnvelope<'REVEAL', { sourceId: string; generation: string; nativeId: string; anchorOrdinal: string }>
  | ProtocolEnvelope<'SOURCE_INVALIDATED', { reason: 'append' | 'truncate' | 'replace' | 'delete' | 'unknown' }>
  | ProtocolEnvelope<'ERROR', { code: string; message: string; recoverable: boolean }>;

export function keyPath(...keys: string[]): FieldPath {
  return { tokens: keys.map((value) => ({ kind: 'key' as const, value })) };
}

export function displayFieldPath(path: FieldPath): string {
  if (path.tokens.length === 0) {
    return '$';
  }
  return path.tokens.reduce<string>((result, token) => {
    if (token.kind === 'index') {
      return `${result}[${String(token.value)}]`;
    }
    const key = String(token.value);
    return /^[A-Za-z_$][\w$]*$/.test(key)
      ? `${result}.${key}`
      : `${result}[${JSON.stringify(key)}]`;
  }, '$');
}
