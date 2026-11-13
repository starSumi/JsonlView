import type { ColumnSpec, FieldPath, RecordRef } from './record';
import { isRowProjectionPlan, type Predicate, type RowScanBudget } from './query';
import type { WebviewRequest } from './envelope';
import { MAX_DIAGNOSTIC_CODE_LENGTH, MAX_DIAGNOSTIC_MESSAGE_LENGTH, isMessageDirection, validateProtocolEnvelope } from './envelope';
import { MAX_TABLE_COLUMNS } from './record';
import { MAX_PROTOCOL_REQUEST_ID_LENGTH } from './identity';
import { isRevealAckPayload } from './reveal';
import { copyGraphRecordRef } from '@shared/graph-record-ref';

const MAX_QUERY_DEPTH = 16;
const MAX_QUERY_NODES = 256;
const MAX_QUERY_STRING = 16 * 1024;
const MAX_SCAN_RECORDS = 1_000_000;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const MAX_SCAN_AHEAD_MS = 60_000;

export interface ValidationResult {
  ok: boolean;
  request?: WebviewRequest;
  error?: string;
}

export interface WebviewRequestValidationContext {
  readonly nowEpochMs?: number;
}

/** Pure request validation; callers enforce time-relative limits by supplying their observed clock. */
export function validateWebviewRequest(
  rawValue: unknown,
  context: WebviewRequestValidationContext = {},
): ValidationResult {
  const envelope = validateProtocolEnvelope(rawValue);
  if (!envelope.ok) {
    return failure(envelope.error);
  }
  const value = envelope.envelope;
  if (!isMessageDirection(value.type, 'webview-to-host')) {
    return failure('Unknown Webview request type or direction.');
  }
  if (value.direction !== undefined && value.direction !== 'webview-to-host') {
    return failure('Message direction is invalid for a Webview request.');
  }
  if (value.delivery !== undefined) {
    const expectedDelivery = value.type === 'REVEAL_ACK' ? 'reply' : 'request';
    if (value.delivery !== expectedDelivery) return failure('Message delivery is invalid for a Webview request.');
  }
  const { payload } = value;
  if (envelope.envelope.requestId.length === 0) {
    return failure('Request id is required.');
  }

  switch (value.type) {
    case 'LOOKUP_LINEAGE_RECORD':
      if (Object.keys(payload).length !== 2 || !isObject(payload.sourceRef) || Object.keys(payload.sourceRef).length !== 7
        || copyGraphRecordRef(payload.sourceRef, value.generation) === undefined
        || (payload.relation !== 'parent' && payload.relation !== 'tool-partner' && payload.relation !== 'span-context')) {
        return failure('Lineage lookup requires an exact current reference and a supported relationship; budgets are Host-owned.');
      }
      break;
    case 'GET_GRAPH':
      if (Object.keys(payload).length !== 0) return failure('Graph uses a fixed Host-owned physical prefix.');
      break;
    case 'REVEAL_GRAPH_RECORD':
      if (Object.keys(payload).length !== 2 || !isBoundedString(payload.graphRequestId, 128)
        || copyGraphRecordRef(payload.ref, value.generation) === undefined || !isObject(payload.ref)
        || Object.keys(payload.ref).length !== 7) return failure('Graph reveal requires a current issued reference.');
      break;
    case 'REVEAL_ACK':
      if (!isRevealAckPayload(payload)) return failure('Invalid reveal acknowledgement.');
      break;
    case 'READY':
      break;
    case 'GET_ROWS': {
      const limit = value.payload.limit;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500) {
        return failure('Row limit must be between 1 and 500.');
      }
      if (
        value.payload.anchorOrdinal !== undefined &&
        !isDecimalString(value.payload.anchorOrdinal)
      ) {
        return failure('Row anchor must be a decimal string.');
      }
      if (
        value.payload.direction !== undefined &&
        value.payload.direction !== 'forward' &&
        value.payload.direction !== 'backward'
      ) {
        return failure('Invalid row direction.');
      }
      if (value.payload.sort !== undefined && !isRowSort(value.payload.sort)) {
        return failure('Invalid row sort.');
      }
      if (
        value.payload.sort !== undefined
        && (value.payload.anchorOrdinal !== undefined || value.payload.direction !== undefined)
        && ((value.payload.sort.columnId !== '__ordinal' && value.payload.sort.columnId !== '$ordinal')
          || value.payload.sortOffset !== undefined)
      ) {
        return failure('Physical cursors require ordinal order and cannot include a sorted offset.');
      }
      const sortOffset = value.payload.sortOffset;
      if (sortOffset !== undefined && !isDecimalString(sortOffset)) {
        return failure('Sorted row offset must be a decimal string.');
      }
      if (sortOffset !== undefined && value.payload.sort === undefined) {
        return failure('Sorted row offset requires a sort descriptor.');
      }
      if (
        sortOffset !== undefined
        && isRowSort(value.payload.sort)
        && value.payload.sort.columnId !== '__ordinal'
        && value.payload.sort.columnId !== '$ordinal'
        && typeof sortOffset === 'string'
        && BigInt(sortOffset) + BigInt(Number(limit)) > 2_048n
      ) {
        return failure('Sorted row offset plus limit is outside the bounded result window.');
      }
      if (value.payload.scanBudget !== undefined && !isRowScanBudget(value.payload.scanBudget, context.nowEpochMs)) {
        return failure('Invalid or over-budget row scan allowance.');
      }
      if (value.payload.predicate !== undefined) {
        const budget = { nodes: 0 };
        if (!isPredicate(value.payload.predicate, 0, budget)) {
          return failure('Invalid or over-budget query predicate.');
        }
      }
      if (value.payload.columns !== undefined && !isRecordColumns(value.payload.columns)) {
        return failure('Invalid or over-budget table columns.');
      }
      if (value.payload.projection !== undefined && !isRowProjectionPlan(value.payload.projection)) {
        return failure('Invalid row projection plan.');
      }
      break;
    }
    case 'GET_PROBLEMS': {
      const limit = value.payload.limit;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) {
        return failure('Problem limit must be between 1 and 200.');
      }
      if (value.payload.anchorOrdinal !== undefined && !isDecimalString(value.payload.anchorOrdinal)) {
        return failure('Problem anchor must be a decimal string.');
      }
      if (
        value.payload.direction !== undefined
        && value.payload.direction !== 'forward'
        && value.payload.direction !== 'backward'
      ) {
        return failure('Invalid problem direction.');
      }
      if (value.payload.scanBudget !== undefined && !isRowScanBudget(value.payload.scanBudget, context.nowEpochMs)) {
        return failure('Invalid or over-budget problem scan allowance.');
      }
      break;
    }
    case 'OPEN_RECORD_TEXT': {
      const ref = value.payload.ref;
      if (Object.keys(value.payload).length !== 1 || !isRecordRef(ref)
        || Object.keys(ref).length !== 7 || ref.generation !== value.generation
        || ref.generation.length > 128 || value.requestId.length === 0
        || ![ref.ordinal, ref.byteStart, ref.byteEndExclusive, ref.contentByteLength]
          .every((coordinate) => /^(?:0|[1-9][0-9]{0,63})$/u.test(coordinate))) {
        return failure('A current, bounded record reference is required for read-only text.');
      }
      break;
    }
    case 'GET_DETAIL':
      if (!isRecordRef(value.payload.ref)) {
        return failure('A valid record reference is required.');
      }
      if (value.payload.full !== undefined && typeof value.payload.full !== 'boolean') {
        return failure('Detail full flag must be boolean.');
      }
      break;
    case 'GET_SCHEMA':
      if (
        !Number.isInteger(value.payload.offset) ||
        Number(value.payload.offset) < 0 ||
        !Number.isInteger(value.payload.limit) ||
        Number(value.payload.limit) < 1 ||
        Number(value.payload.limit) > 500
      ) {
        return failure('Invalid schema page.');
      }
      break;
    case 'GET_INSIGHTS': {
      const intent = value.payload.intent;
      if (!isAnalysisIntent(intent)) return failure('Invalid or over-budget analysis intent.');
      break;
    }
    case 'SET_PROFILE':
      if (!isBoundedString(value.payload.profileId, 128)) {
        return failure('Profile id is required.');
      }
      break;
    case 'SET_FOLLOW_MODE':
      if (typeof value.payload.enabled !== 'boolean') {
        return failure('Follow mode must be boolean.');
      }
      break;
    case 'SET_ROW_ORDER':
      if (value.payload.direction !== 'asc' && value.payload.direction !== 'desc') {
        return failure('Row order must be ascending or descending.');
      }
      break;
    case 'OPEN_SESSION_NAVIGATOR':
    case 'SAVE_PREVIEW_AS':
      if (Object.keys(value.payload).length !== 0) return failure('This action requires an empty payload.');
      break;
    case 'DIAGNOSE_ERROR':
      if (!isBoundedString(value.payload.code, MAX_DIAGNOSTIC_CODE_LENGTH)) {
        return failure('Diagnostic code is required.');
      }
      if (!isBoundedString(value.payload.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH)) {
        return failure('Diagnostic message is required.');
      }
      if (value.payload.action !== undefined && value.payload.action !== 'explain' && value.payload.action !== 'copy') {
        return failure('Diagnostic action is invalid.');
      }
      break;
    case 'CANCEL':
      if (!isBoundedString(value.payload.targetRequestId, MAX_PROTOCOL_REQUEST_ID_LENGTH)) {
        return failure('Cancellation target is required.');
      }
      break;
    case 'REBUILD_INDEX':
      break;
    default:
      return failure(`Unsupported message type: ${value.type}`);
  }

  return { ok: true, request: value as unknown as WebviewRequest };
}

function isAnalysisIntent(value: unknown): boolean {
  if (!isObject(value) || value.version !== 1 || !isNonNegativeSafeInteger(value.intentRevision)
    || !['eventKind', 'severity', 'service', 'status'].includes(String(value.dimension))
    || (value.scope !== 'current-view' && value.scope !== 'whole-file')
    || !isObject(value.document) || !isBoundedString(value.document.documentId, 512)
    || !isBoundedString(value.document.generation, 512)
    || (value.document.sourceEpoch !== undefined && !isNonNegativeSafeInteger(value.document.sourceEpoch))
    || !isObject(value.profile) || !isBoundedString(value.profile.id, 128)
    || !isBoundedString(value.profile.version, 128)) return false;
  if (value.scope === 'whole-file' && value.predicate !== undefined) return false;
  if (value.predicate === undefined) return true;
  return isPredicate(value.predicate, 0, { nodes: 0 });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRowSort(value: unknown): value is { columnId: string; direction: 'asc' | 'desc' } {
  return isObject(value)
    && isBoundedString(value.columnId, 256)
    && (value.direction === 'asc' || value.direction === 'desc');
}

function isRecordColumns(value: unknown): value is ColumnSpec[] {
  return Array.isArray(value)
    && value.length <= MAX_TABLE_COLUMNS
    && value.every((column) => (
      isObject(column)
      && isBoundedString(column.id, 256)
      && isBoundedString(column.label, 256)
      && column.source === 'record'
      && isFieldPath(column.path)
      && column.id === JSON.stringify(column.path.tokens)
      && (column.width === undefined || (
        typeof column.width === 'number'
        && Number.isFinite(column.width)
        && column.width >= 1
        && column.width <= 2_000
      ))
    ));
}

/** Shared Host validation for a captured query and its private recovery journal. */
export function isValidQueryPredicate(value: unknown): value is Predicate {
  return isPredicate(value, 0, { nodes: 0 });
}

function isPredicate(value: unknown, depth: number, budget: { nodes: number }): value is Predicate {
  if (!isObject(value) || depth > MAX_QUERY_DEPTH || ++budget.nodes > MAX_QUERY_NODES) {
    return false;
  }
  switch (value.op) {
    case 'and':
    case 'or':
      return (
        Array.isArray(value.args) &&
        value.args.length > 0 &&
        value.args.length <= 64 &&
        value.args.every((arg) => isPredicate(arg, depth + 1, budget))
      );
    case 'not':
      return isPredicate(value.arg, depth + 1, budget);
    case 'compare':
      return (
        isFieldPath(value.path) &&
        ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(String(value.cmp)) &&
        isScalar(value.value)
      );
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      return (
        isFieldPath(value.path) &&
        isBoundedString(value.value, MAX_QUERY_STRING) &&
        typeof value.caseSensitive === 'boolean'
      );
    case 'exists':
    case 'is_null':
      return isFieldPath(value.path);
    case 'kind_is':
      return (
        isFieldPath(value.path) &&
        ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(
          String(value.kind),
        )
      );
    case 'text_search':
      return (
        isBoundedString(value.value, MAX_QUERY_STRING) &&
        typeof value.caseSensitive === 'boolean' &&
        (value.paths === undefined ||
          (Array.isArray(value.paths) &&
            value.paths.length <= 64 &&
            value.paths.every(isFieldPath)))
      );
    case 'profile_field':
      return (
        isBoundedString(value.field, 128) &&
        ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(String(value.cmp)) &&
        isScalar(value.value)
      );
    case 'profile_text':
      return (
        isBoundedString(value.field, 128)
        && ['contains', 'starts_with', 'ends_with'].includes(String(value.cmp))
        && isBoundedString(value.value, MAX_QUERY_STRING)
        && typeof value.caseSensitive === 'boolean'
      );
    case 'profile_exists':
    case 'profile_is_null':
      return isBoundedString(value.field, 128);
    default:
      return false;
  }
}

function isFieldPath(value: unknown): value is FieldPath {
  return (
    isObject(value) &&
    Array.isArray(value.tokens) &&
    value.tokens.length <= 32 &&
    value.tokens.every(
      (token) =>
        isObject(token) &&
        ((token.kind === 'key' && isBoundedString(token.value, 1024)) ||
          (token.kind === 'index' && Number.isSafeInteger(token.value) && Number(token.value) >= 0)),
    )
  );
}

function isRecordRef(value: unknown): value is RecordRef {
  return (
    isObject(value) &&
    isBoundedString(value.generation, 256) &&
    isDecimalString(value.ordinal) &&
    isDecimalString(value.byteStart) &&
    isDecimalString(value.byteEndExclusive) &&
    isDecimalString(value.contentByteLength) &&
    (value.delimiterByteLength === 0 ||
      value.delimiterByteLength === 1 ||
      value.delimiterByteLength === 2) &&
    ['unknown', 'valid', 'invalid_json', 'blank', 'encoding_error', 'oversized'].includes(
      String(value.parseState),
    )
  );
}

function isRowScanBudget(value: unknown, nowEpochMs?: number): value is RowScanBudget {
  if (!isObject(value)) return false;
  const hasRecords = value.maxExaminedRecords !== undefined;
  const hasBytes = value.maxExaminedBytes !== undefined;
  const hasDeadline = value.deadlineEpochMs !== undefined;
  if (!hasRecords && !hasBytes && !hasDeadline) return false;
  if (hasRecords && (
    !Number.isSafeInteger(value.maxExaminedRecords)
    || Number(value.maxExaminedRecords) < 1
    || Number(value.maxExaminedRecords) > MAX_SCAN_RECORDS
  )) return false;
  if (hasBytes) {
    let bytes: bigint;
    try {
      if (typeof value.maxExaminedBytes === 'bigint') bytes = value.maxExaminedBytes;
      else if (isDecimalString(value.maxExaminedBytes)) bytes = BigInt(value.maxExaminedBytes);
      else return false;
    } catch {
      return false;
    }
    if (bytes < 1n || bytes > BigInt(MAX_SCAN_BYTES)) return false;
  }
  if (hasDeadline && (
    !Number.isSafeInteger(value.deadlineEpochMs)
    || Number(value.deadlineEpochMs) < 0
    || (nowEpochMs !== undefined && (
      !Number.isSafeInteger(nowEpochMs)
      || Number(value.deadlineEpochMs) > nowEpochMs + MAX_SCAN_AHEAD_MS
    ))
  )) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    isBoundedString(value, MAX_QUERY_STRING)
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function failure(error: string): ValidationResult {
  return { ok: false, error };
}
