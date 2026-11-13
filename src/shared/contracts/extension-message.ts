import type {
  AgentEventKind,
  AgentRowProjection,
  ColumnSpec,
  ConversationProjection,
  DocumentSummary,
  FieldPath,
  FieldStats,
  ProblemPage,
  ProblemRef,
  RecordDetail,
  RecordRef,
  RowPage,
  RowProjection,
  RowScanStats,
} from './record';
import type { ExtensionMessage } from './envelope';
import type { InsightSummary } from './query';
import type { SnapshotIdentity } from './identity';
import {
  MAX_CONVERSATION_CHARACTERS,
  MAX_CONVERSATION_PARTS,
  MAX_CONVERSATION_DEPTH,
  MAX_CONVERSATION_ROLE_CHARACTERS,
  MAX_CONVERSATION_LABEL_CHARACTERS,
} from './record';
import { isMessageDirection, validateProtocolEnvelope } from './envelope';
import { isDatasetRuntimeProvenance } from './dataset-provenance';
import { isDatasetRecordSummary } from './dataset-summary';
import { isBfclV3RecordSummary } from './bfcl-v3-insights';
import { isOpenTelemetryRecordSummary } from './otel-insights';
import { isNavigatorBridgeResult } from './navigator-bridge';
import { isSourceRegistrationFacts } from './source-registration';
import { isRevealOrdinal } from './reveal';
import { isDocumentGraphReply, isGraphRevealReceipt } from './document-graph';
import { copyGraphRecordRef } from '../graph-record-ref';
import { LINEAGE_LOOKUP_MAX_BYTES, LINEAGE_LOOKUP_MAX_RECORDS, type LineageLookupReply } from './lineage';

const AGENT_EVENT_KINDS: ReadonlySet<string> = new Set([
  'session', 'turn', 'message', 'log', 'span', 'task', 'action', 'observation',
  'patch', 'test', 'result', 'reasoning', 'tool_call', 'tool_result', 'subagent', 'metric',
  'approval', 'usage', 'error', 'checkpoint', 'other',
]);
const JSON_KINDS: ReadonlySet<string> = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const PARSE_STATES: ReadonlySet<string> = new Set(['unknown', 'valid', 'invalid_json', 'blank', 'encoding_error', 'oversized']);
const SCAN_TRUNCATION_REASONS: ReadonlySet<string> = new Set([
  'record_limit', 'byte_limit', 'time_limit', 'hydration_limit', 'uninspectable_record',
]);

/** Validates the host-to-Webview direction after common envelope checks. */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  const envelope = validateProtocolEnvelope(value);
  if (!envelope.ok) return false;
  if (!isMessageDirection(envelope.envelope.type, 'host-to-webview')) return false;
  if (envelope.envelope.direction !== undefined && envelope.envelope.direction !== 'host-to-webview') return false;
  const legacyDelivery = envelope.envelope.delivery === undefined && envelope.envelope.requestId.length > 0;
  const delivery = legacyDelivery
    ? (envelope.envelope.type === 'REVEAL' ? 'request' : 'reply')
    : envelope.envelope.delivery;
  if (delivery !== 'reply' && delivery !== 'broadcast'
    && !(delivery === 'request' && envelope.envelope.type === 'REVEAL')) return false;
  if (delivery === 'broadcast'
    && (envelope.envelope.requestId !== '' || !BROADCAST_MESSAGE_TYPES.has(envelope.envelope.type))) return false;
  if (delivery === 'reply' && envelope.envelope.requestId.length === 0) return false;

  switch (envelope.envelope.type) {
    case 'LINEAGE_LOOKUP_RESULT':
      return isLineageLookupReply(envelope.envelope.payload, envelope.envelope.generation);
    case 'GRAPH':
      return isDocumentGraphReply(envelope.envelope.payload, envelope.envelope.documentId, envelope.envelope.generation);
    case 'GRAPH_REVEAL_RESULT':
      return isGraphRevealReceipt(envelope.envelope.payload, envelope.envelope.generation);
    case 'OPENED':
    case 'INDEX_PROGRESS':
      return isDocumentSummary(envelope.envelope.payload);
    case 'PREVIEW_STATUS': {
      const payload = envelope.envelope.payload;
      return isObject(payload) && Object.keys(payload).length === 4
        && (payload.status === 'temporary' || payload.status === 'saving' || payload.status === 'saved')
        && isSafeNonNegativeInteger(payload.recordCount) && payload.recordCount >= 1 && payload.recordCount <= 10_000
        && isSafeNonNegativeInteger(payload.sizeBytes) && payload.sizeBytes <= 1_048_576
        && typeof payload.savedCopy === 'boolean';
    }
    case 'ROWS':
      return isRowPage(envelope.envelope.payload);
    case 'PROBLEMS':
      return isProblemPage(envelope.envelope.payload);
    case 'DETAIL':
      return isRecordDetail(envelope.envelope.payload);
    case 'SCHEMA':
      return isSchemaPayload(envelope.envelope.payload);
    case 'INSIGHTS':
      return isInsightSummary(envelope.envelope.payload);
    case 'PROFILE_CHANGED':
      return isObject(envelope.envelope.payload)
        && isString(envelope.envelope.payload.profileId)
        && (envelope.envelope.payload.profileVersion === undefined
          || isString(envelope.envelope.payload.profileVersion))
        && (envelope.envelope.payload.profileEpoch === undefined
          || isSafeNonNegativeInteger(envelope.envelope.payload.profileEpoch))
        && isColumns(envelope.envelope.payload.columns);
    case 'ROW_ORDER_CHANGED':
      return isObject(envelope.envelope.payload)
        && isSortDirection(envelope.envelope.payload.direction);
    case 'REVEAL':
      return delivery === 'request' && envelope.envelope.requestId.length > 0 && isObject(envelope.envelope.payload)
        && Object.keys(envelope.envelope.payload).length === 4
        && isString(envelope.envelope.payload.sourceId)
        && isString(envelope.envelope.payload.generation)
        && isString(envelope.envelope.payload.nativeId)
        && isRevealOrdinal(envelope.envelope.payload.anchorOrdinal)
        && envelope.envelope.payload.sourceId.length <= 256
        && envelope.envelope.payload.nativeId.length <= 512;
    case 'SOURCE_INVALIDATED':
      return isObject(envelope.envelope.payload)
        && isSourceInvalidationReason(envelope.envelope.payload.reason);
    case 'ERROR':
      return isObject(envelope.envelope.payload)
        && isString(envelope.envelope.payload.code)
        && isString(envelope.envelope.payload.message)
        && typeof envelope.envelope.payload.recoverable === 'boolean';
    case 'NAVIGATOR_STATUS':
      return isNavigatorBridgeResult(envelope.envelope.payload);
    case 'NAVIGATOR_VISIBILITY':
      return isObject(envelope.envelope.payload)
        && Object.keys(envelope.envelope.payload).length === 1
        && typeof envelope.envelope.payload.visible === 'boolean';
    case 'SOURCE_REGISTRATION_RESULT':
      return isSourceRegistrationFacts(envelope.envelope.payload);
    default:
      return false;
  }
}

const BROADCAST_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'OPENED', 'PREVIEW_STATUS', 'INDEX_PROGRESS', 'PROFILE_CHANGED', 'SOURCE_INVALIDATED', 'ERROR', 'NAVIGATOR_VISIBILITY',
]);

export function isLineageLookupReply(value: unknown, generation: string): value is LineageLookupReply {
  if (!isObject(value) || copyGraphRecordRef(value.sourceRef, generation) === undefined
    || (value.relation !== 'parent' && value.relation !== 'tool-partner' && value.relation !== 'span-context')
    || !['found', 'not-observed', 'ambiguous', 'budget-exceeded', 'timed-out', 'stale', 'unavailable'].includes(String(value.status))
    || !isString(value.profileId) || !isString(value.profileVersion)
    || (value.profileEpoch !== undefined && !isSafeNonNegativeInteger(value.profileEpoch))
    || !isObject(value.scope) || value.scope.kind !== 'physical-window'
    || !isDecimal(value.scope.startOrdinal) || !isDecimal(value.scope.endOrdinalExclusive)
    || !isSafeNonNegativeInteger(value.scope.examinedRecords) || Number(value.scope.examinedRecords) > LINEAGE_LOOKUP_MAX_RECORDS
    || !isDecimal(value.scope.examinedBytes) || BigInt(value.scope.examinedBytes) > BigInt(LINEAGE_LOOKUP_MAX_BYTES)
    || !isSafeNonNegativeInteger(value.scope.requestedBytes) || Number(value.scope.requestedBytes) > LINEAGE_LOOKUP_MAX_BYTES
    || typeof value.scope.complete !== 'boolean') return false;
  const start = BigInt(value.scope.startOrdinal); const end = BigInt(value.scope.endOrdinalExclusive);
  if (end < start || end - start > BigInt(LINEAGE_LOOKUP_MAX_RECORDS) || BigInt(Number(value.scope.examinedRecords)) > end - start
    || value.scope.complete !== ['found', 'not-observed', 'ambiguous'].includes(String(value.status))) return false;
  return value.status === 'found'
    ? isRowProjection(value.match) && copyGraphRecordRef(value.match.ref, generation) !== undefined
      && BigInt(value.match.ref.ordinal) >= start && BigInt(value.match.ref.ordinal) < end
    : value.match === undefined;
}

function isDocumentSummary(value: unknown): value is DocumentSummary {
  if (!isObject(value)) return false;
  return isSnapshot(value.snapshot)
    && isString(value.profileId)
    && (value.profileVersion === undefined || isString(value.profileVersion))
    && (value.profileEpoch === undefined || isSafeNonNegativeInteger(value.profileEpoch))
    && (value.datasetProvenance === undefined || isDatasetRuntimeProvenance(value.datasetProvenance))
    && isArray(value.profileSuggestions, isProfileSuggestion)
    && isDecimal(value.indexedBytes)
    && isDecimal(value.indexedRecords)
    && typeof value.indexingComplete === 'boolean'
    && isDecimal(value.validRecords)
    && isDecimal(value.problemRecords);
}

function isSnapshot(value: unknown): value is SnapshotIdentity {
  if (!isObject(value)) return false;
  return isString(value.documentId)
    && isString(value.generation)
    && (value.epoch === undefined || isSafeNonNegativeInteger(value.epoch))
    && isString(value.uri)
    && isString(value.scheme)
    && isDecimal(value.sizeBytes)
    && isFiniteNumber(value.mtimeMs)
    && (value.device === undefined || isString(value.device))
    && (value.inode === undefined || isString(value.inode))
    && isString(value.prefixFingerprint)
    && isString(value.observedAt);
}

function isProfileSuggestion(value: unknown): boolean {
  return isObject(value)
    && isString(value.id)
    && isString(value.displayName)
    && isFiniteNumber(value.score)
    && isArray(value.reasons, isString);
}

function isRowPage(value: unknown): value is RowPage {
  if (!isObject(value)) return false;
  return isArray(value.rows, isRowProjection)
    && isColumns(value.columns)
    && isDecimal(value.anchorOrdinal)
    && typeof value.hasBefore === 'boolean'
    && typeof value.hasAfter === 'boolean'
    && isDecimal(value.indexedRecords)
    && (value.totalRecords === undefined || isDecimal(value.totalRecords))
    && (value.sort === undefined || isSort(value.sort))
    && (value.sortOffset === undefined || isDecimal(value.sortOffset))
    && (value.sortNextOffset === undefined || isDecimal(value.sortNextOffset))
    && (value.matchedRecords === undefined || isDecimal(value.matchedRecords))
    && (value.scan === undefined || isRowScanStats(value.scan));
}

function isRowProjection(value: unknown): value is RowProjection {
  return isObject(value)
    && isRecordRef(value.ref)
    && (value.kind === undefined || JSON_KINDS.has(String(value.kind)))
    && isArray(value.cells, isCell)
    && isString(value.genericSummary)
    && (value.conversation === undefined || isConversationProjection(value.conversation))
    && (value.dataset === undefined || isDatasetRecordSummary(value.dataset))
    && (value.datasetInsights === undefined || isDatasetInsights(value.datasetInsights))
    && (value.profile === undefined || isAgentRowProjection(value.profile))
    && (value.problems === undefined || isArray(value.problems, isProblemRef));
}

function isDatasetInsights(value: unknown): value is NonNullable<RowProjection['datasetInsights']> {
  if (!isObject(value) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, 'bfclV3')) return isBfclV3RecordSummary(value.bfclV3);
  if (Object.hasOwn(value, 'opentelemetry')) return isOpenTelemetryRecordSummary(value.opentelemetry);
  return false;
}

function isConversationProjection(value: unknown): value is ConversationProjection {
  if (!isObject(value) || Object.keys(value).length !== 2 || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.parts) || value.parts.length > MAX_CONVERSATION_PARTS) return false;
  let characters = 0;
  return value.parts.every((part) => {
    if (!isObject(part) || Object.keys(part).length !== 4
      || !isBoundedConversationString(part.role, MAX_CONVERSATION_ROLE_CHARACTERS)
      || !isBoundedConversationString(part.label, MAX_CONVERSATION_LABEL_CHARACTERS)
      || !isBoundedConversationString(part.text, MAX_CONVERSATION_CHARACTERS)
      || !isFieldPath(part.path) || Object.keys(part.path).length !== 1
      || part.path.tokens.length > MAX_CONVERSATION_DEPTH
      || !part.path.tokens.every((token) => Object.keys(token).length === 2
        && (token.kind !== 'key' || (typeof token.value === 'string' && token.value.length <= 80)))) return false;
    characters += part.text.length;
    return characters <= MAX_CONVERSATION_CHARACTERS;
  });
}

function isBoundedConversationString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

function isCell(value: unknown): boolean {
  return isObject(value)
    && isString(value.columnId)
    && (value.kind === undefined || JSON_KINDS.has(String(value.kind)))
    && (value.value === undefined || isScalar(value.value))
    && (value.preview === undefined || isString(value.preview))
    && (value.truncated === undefined || typeof value.truncated === 'boolean');
}

function isAgentRowProjection(value: unknown): value is AgentRowProjection {
  return isObject(value)
    && isString(value.profileId)
    && AGENT_EVENT_KINDS.has(String(value.eventKind))
    && (value.timestamp === undefined || isString(value.timestamp))
    && (value.actor === undefined || isString(value.actor))
    && (value.sessionId === undefined || isString(value.sessionId))
    && (value.turnId === undefined || isString(value.turnId))
    && (value.parentId === undefined || isString(value.parentId))
    && (value.messageId === undefined || isString(value.messageId))
    && (value.toolCallId === undefined || isString(value.toolCallId))
    && (value.subagentId === undefined || isString(value.subagentId))
    && (value.model === undefined || isString(value.model))
    && (value.status === undefined || isString(value.status))
    && (value.severity === undefined || isString(value.severity))
    && isString(value.summary)
    && (value.usage === undefined || isUsage(value.usage))
    && (value.derivedFields === undefined || isScalarMap(value.derivedFields))
    && isArray(value.evidence, isEvidence)
    && ['source', 'correlated', 'inferred'].includes(String(value.confidence));
}

function isUsage(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (value.input === undefined || isFiniteNumber(value.input))
    && (value.output === undefined || isFiniteNumber(value.output))
    && (value.cached === undefined || isFiniteNumber(value.cached))
    && (value.total === undefined || isFiniteNumber(value.total));
}

function isScalarMap(value: unknown): boolean {
  return isObject(value) && Object.values(value).every(isScalar);
}

function isEvidence(value: unknown): boolean {
  return isObject(value) && isString(value.field) && isFieldPath(value.path);
}

function isProblemPage(value: unknown): value is ProblemPage {
  if (!isObject(value)) return false;
  return isArray(value.items, isProblemRef)
    && isDecimal(value.anchorOrdinal)
    && typeof value.hasBefore === 'boolean'
    && typeof value.hasAfter === 'boolean'
    && isDecimal(value.indexedRecords)
    && isDecimal(value.observedProblemRecords)
    && typeof value.complete === 'boolean'
    && isRowScanStats(value.scan);
}

function isProblemRef(value: unknown): value is ProblemRef {
  return isObject(value)
    && isString(value.code)
    && isString(value.message)
    && ['info', 'warning', 'error'].includes(String(value.severity))
    && (value.ref === undefined || isRecordRef(value.ref));
}

function isRecordDetail(value: unknown): value is RecordDetail {
  return isObject(value)
    && isRecordRef(value.ref)
    && isString(value.rawPreview)
    && typeof value.rawComplete === 'boolean'
    && (value.profile === undefined || isAgentRowProjection(value.profile))
    && isArray(value.problems, isProblemRef);
}

function isSchemaPayload(value: unknown): boolean {
  return isObject(value)
    && isArray(value.fields, isFieldStats)
    && isSafeNonNegativeInteger(value.totalFields)
    && typeof value.complete === 'boolean';
}

function isFieldStats(value: unknown): value is FieldStats {
  if (!isObject(value)) return false;
  return isFieldPath(value.path)
    && isString(value.displayPath)
    && isDecimal(value.seenRecords)
    && isDecimal(value.validRecordsObserved)
    && isKinds(value.kinds)
    && isDecimal(value.missingRecords)
    && isDecimal(value.nullRecords)
    && isArray(value.examples, isString)
    && isDecimal(value.firstSeenOrdinal)
    && isDecimal(value.lastSeenOrdinal)
    && ['sampled', 'complete', 'stale'].includes(String(value.confidence));
}

function isKinds(value: unknown): boolean {
  return isObject(value) && Object.values(value).every(isDecimal);
}

function isInsightSummary(value: unknown): value is InsightSummary {
  if (!isObject(value)) return false;
  return isObject(value.intent)
    && isAnalysisIntent(value.intent)
    && isObject(value.provenance)
    && value.provenance.scope === value.intent.scope
    && value.provenance.predicateApplied === (value.intent.predicate !== undefined)
    && (value.provenance.coverage === 'complete' || value.provenance.coverage === 'bounded')
    && isArray(value.categories, isInsightCategory)
    && isArray(value.timeBuckets, isInsightTimeBucket)
    && isDecimal(value.processedRecords)
    && isDecimal(value.examinedRecords)
    && isDecimal(value.examinedBytes)
    && typeof value.truncated === 'boolean'
    && (value.provenance.coverage === 'bounded') === value.truncated
    && (value.truncatedReason === undefined || SCAN_TRUNCATION_REASONS.has(String(value.truncatedReason)))
    && typeof value.capacityReached === 'boolean'
    && isFiniteNumber(value.bucketWidthMs);
}

function isAnalysisIntent(value: unknown): boolean {
  return isObject(value)
    && value.version === 1
    && isSafeNonNegativeInteger(value.intentRevision)
    && ['eventKind', 'severity', 'service', 'status'].includes(String(value.dimension))
    && (value.scope === 'current-view' || value.scope === 'whole-file')
    && isObject(value.document)
    && isString(value.document.documentId)
    && isString(value.document.generation)
    && (value.document.sourceEpoch === undefined || isSafeNonNegativeInteger(value.document.sourceEpoch))
    && isObject(value.profile)
    && isString(value.profile.id)
    && isString(value.profile.version)
    && (value.predicate === undefined || isPredicateShape(value.predicate))
    && (value.scope === 'current-view' || value.predicate === undefined);
}

function isPredicateShape(value: unknown, depth = 0): boolean {
  if (!isObject(value) || depth > 16 || typeof value.op !== 'string') return false;
  if (value.op === 'and' || value.op === 'or') {
    return Array.isArray(value.args) && value.args.length <= 256
      && value.args.every((argument) => isPredicateShape(argument, depth + 1));
  }
  if (value.op === 'not') return isPredicateShape(value.arg, depth + 1);
  return ['compare', 'contains', 'starts_with', 'ends_with', 'exists', 'is_null', 'kind_is',
    'text_search', 'profile_field', 'profile_text', 'profile_exists', 'profile_is_null'].includes(value.op);
}

function isInsightCategory(value: unknown): boolean {
  return isObject(value)
    && isString(value.label)
    && isFiniteNumber(value.count)
    && (value.approximate === undefined || typeof value.approximate === 'boolean');
}

function isInsightTimeBucket(value: unknown): boolean {
  return isObject(value) && isString(value.start) && isFiniteNumber(value.count);
}

function isRowScanStats(value: unknown): value is RowScanStats {
  return isObject(value)
    && isDecimal(value.examinedRecords)
    && isDecimal(value.examinedBytes)
    && (value.cursorOrdinal === undefined || isDecimal(value.cursorOrdinal))
    && (value.direction === undefined || value.direction === 'forward' || value.direction === 'backward')
    && (value.truncatedReason === undefined || SCAN_TRUNCATION_REASONS.has(String(value.truncatedReason)));
}

function isColumns(value: unknown): value is ColumnSpec[] {
  return isArray(value, isColumn);
}

function isColumn(value: unknown): value is ColumnSpec {
  return isObject(value)
    && isString(value.id)
    && isString(value.label)
    && ['record', 'profile', 'system'].includes(String(value.source))
    && (value.path === undefined || isFieldPath(value.path))
    && (value.width === undefined || isFiniteNumber(value.width));
}

function isFieldPath(value: unknown): value is FieldPath {
  return isObject(value)
    && isArray(value.tokens, (token) => isObject(token)
      && (token.kind === 'key' || token.kind === 'index')
      && (token.kind === 'key' ? isString(token.value) : isSafeNonNegativeInteger(token.value)));
}

function isRecordRef(value: unknown): value is RecordRef {
  return isObject(value)
    && isString(value.generation)
    && isDecimal(value.ordinal)
    && isDecimal(value.byteStart)
    && isDecimal(value.byteEndExclusive)
    && isDecimal(value.contentByteLength)
    && (value.delimiterByteLength === 0 || value.delimiterByteLength === 1 || value.delimiterByteLength === 2)
    && PARSE_STATES.has(String(value.parseState));
}

function isSort(value: unknown): boolean {
  return isObject(value) && isString(value.columnId) && isSortDirection(value.direction);
}

function isSortDirection(value: unknown): value is 'asc' | 'desc' {
  return value === 'asc' || value === 'desc';
}

function isSourceInvalidationReason(value: unknown): boolean {
  return ['append', 'truncate', 'replace', 'delete', 'unknown'].includes(String(value));
}

function isArray<T>(value: unknown, predicate: (item: unknown) => boolean): value is T[] {
  return Array.isArray(value) && value.every(predicate);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
