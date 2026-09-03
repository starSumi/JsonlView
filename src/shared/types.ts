export const PROTOCOL_VERSION = 1 as const;

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

export type Predicate =
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | { op: 'compare'; path: FieldPath; cmp: CompareOperator; value: JsonScalar }
  | { op: 'contains' | 'starts_with' | 'ends_with'; path: FieldPath; value: string; caseSensitive: boolean }
  | { op: 'exists' | 'is_null'; path: FieldPath }
  | { op: 'kind_is'; path: FieldPath; kind: JsonKind }
  | { op: 'text_search'; value: string; caseSensitive: boolean; paths?: FieldPath[] }
  | { op: 'profile_field'; field: string; cmp: CompareOperator; value: JsonScalar };

export interface ColumnSpec {
  id: string;
  label: string;
  path?: FieldPath;
  source: 'record' | 'profile' | 'system';
  width?: number;
}

export interface RowPage {
  rows: RowProjection[];
  columns: ColumnSpec[];
  anchorOrdinal: string;
  hasBefore: boolean;
  hasAfter: boolean;
  indexedRecords: string;
  totalRecords?: string;
  scan?: RowScanStats;
}

export type ScanTruncationReason = 'record_limit' | 'byte_limit' | 'time_limit';

export interface RowScanStats {
  examinedRecords: string;
  examinedBytes: string;
  cursorOrdinal?: string;
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

export interface DocumentSummary {
  snapshot: SnapshotIdentity;
  profileId: string;
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
  dimension: InsightDimension;
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
  requestId: string;
  payload: TPayload;
}

export type WebviewRequest =
  | ProtocolEnvelope<'READY', { restoredState?: unknown }>
  | ProtocolEnvelope<'GET_ROWS', { anchorOrdinal?: string; direction?: 'forward' | 'backward'; limit: number; predicate?: Predicate }>
  | ProtocolEnvelope<'GET_DETAIL', { ref: RecordRef; full?: boolean }>
  | ProtocolEnvelope<'GET_SCHEMA', { offset: number; limit: number }>
  | ProtocolEnvelope<'GET_INSIGHTS', { dimension: InsightDimension; predicate?: Predicate }>
  | ProtocolEnvelope<'SET_PROFILE', { profileId: string }>
  | ProtocolEnvelope<'SET_FOLLOW_MODE', { enabled: boolean }>
  | ProtocolEnvelope<'CANCEL', { targetRequestId: string }>
  | ProtocolEnvelope<'REBUILD_INDEX', Record<string, never>>;

export type ExtensionMessage =
  | ProtocolEnvelope<'OPENED', DocumentSummary>
  | ProtocolEnvelope<'ROWS', RowPage>
  | ProtocolEnvelope<'DETAIL', RecordDetail>
  | ProtocolEnvelope<'SCHEMA', { fields: FieldStats[]; totalFields: number; complete: boolean }>
  | ProtocolEnvelope<'INSIGHTS', InsightSummary>
  | ProtocolEnvelope<'INDEX_PROGRESS', DocumentSummary>
  | ProtocolEnvelope<'PROFILE_CHANGED', { profileId: string; columns: ColumnSpec[] }>
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
