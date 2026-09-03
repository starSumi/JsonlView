import {
  PROTOCOL_VERSION,
  type FieldPath,
  type Predicate,
  type RecordRef,
  type WebviewRequest,
} from '../shared/types';

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_QUERY_DEPTH = 16;
const MAX_QUERY_NODES = 256;
const MAX_QUERY_STRING = 16 * 1024;

export interface ValidationResult {
  ok: boolean;
  request?: WebviewRequest;
  error?: string;
}

export function validateWebviewRequest(value: unknown): ValidationResult {
  if (!isObject(value)) {
    return failure('Message must be an object.');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    return failure('Unsupported protocol version.');
  }
  if (!isBoundedString(value.type, 64)) {
    return failure('Message type is required.');
  }
  if (!isBoundedString(value.documentId, 256) || !isBoundedString(value.generation, 256)) {
    return failure('Document identity is required.');
  }
  if (!isBoundedString(value.requestId, MAX_REQUEST_ID_LENGTH)) {
    return failure('Request id is required.');
  }
  if (!isObject(value.payload)) {
    return failure('Payload must be an object.');
  }

  switch (value.type) {
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
      if (value.payload.predicate !== undefined) {
        const budget = { nodes: 0 };
        if (!isPredicate(value.payload.predicate, 0, budget)) {
          return failure('Invalid or over-budget query predicate.');
        }
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
      if (!['eventKind', 'severity', 'service', 'status'].includes(String(value.payload.dimension))) {
        return failure('Invalid insight dimension.');
      }
      if (value.payload.predicate !== undefined) {
        const budget = { nodes: 0 };
        if (!isPredicate(value.payload.predicate, 0, budget)) {
          return failure('Invalid or over-budget insight predicate.');
        }
      }
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
    case 'CANCEL':
      if (!isBoundedString(value.payload.targetRequestId, MAX_REQUEST_ID_LENGTH)) {
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
