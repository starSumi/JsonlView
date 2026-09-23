import type {
  ColumnSpec,
  FieldPath,
  JsonKind,
  JsonScalar,
  Predicate,
  RowFilter,
  RowFilterOperator,
} from '../shared/types';

/** Combine independent UI filters without changing the engine predicate AST. */
export function combinePredicates(...predicates: Array<Predicate | undefined>): Predicate | undefined {
  const present = predicates.filter((predicate): predicate is Predicate => predicate !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { op: 'and', args: present };
}

/**
 * Translate the bounded column filter model into the shared typed predicate.
 * Profile columns use the profile namespace; record columns retain their
 * source FieldPath. Unsupported combinations return undefined so callers can
 * keep the control disabled instead of silently applying a different query.
 */
export function predicateForFilter(
  filter: RowFilter | undefined,
  columns: readonly ColumnSpec[],
): Predicate | undefined {
  if (filter === undefined) return undefined;
  const column = columns.find((candidate) => candidate.id === filter.columnId);
  if (column === undefined) {
    // A restored workspace can issue its first request before fresh column
    // metadata arrives. Keep the source/path captured in the filter, and fall
    // back to the stable encoded column id used by generic record columns.
    const source = filter.source
      ?? (KNOWN_PROFILE_FIELDS.has(filter.columnId) ? 'profile' : undefined);
    if (source === 'profile') return profilePredicate(filter, filter.columnId);
    const path = validFieldPath(filter.path) ? filter.path : fieldPathFromColumnId(filter.columnId);
    return path === undefined ? undefined : recordPredicate(filter, path);
  }
  if (column.source === 'profile') {
    return profilePredicate(filter, column.id);
  }
  if (column.path === undefined) return undefined;
  return recordPredicate(filter, column.path);
}

function recordPredicate(filter: RowFilter, path: FieldPath): Predicate | undefined {
  const { operator } = filter;
  if (operator === 'exists' || operator === 'is_null') {
    return { op: operator, path };
  }
  if (operator === 'kind_is') {
    const kind = filter.kind ?? (typeof filter.value === 'string' ? filter.value as JsonKind : undefined);
    if (kind === undefined || !isJsonKind(kind)) return undefined;
    return { op: 'kind_is', path, kind };
  }
  if (operator === 'contains' || operator === 'starts_with' || operator === 'ends_with') {
    if (typeof filter.value !== 'string') return undefined;
    return {
      op: operator,
      path,
      value: filter.value,
      caseSensitive: filter.caseSensitive ?? false,
    };
  }
  if (!isCompareOperator(operator) || filter.value === undefined) return undefined;
  return { op: 'compare', path, cmp: operator, value: filter.value };
}

function profilePredicate(filter: RowFilter, field: string): Predicate | undefined {
  const { operator } = filter;
  if (isCompareOperator(operator)) {
    if (filter.value === undefined) return undefined;
    return { op: 'profile_field', field, cmp: operator, value: filter.value };
  }
  if (operator === 'contains' || operator === 'starts_with' || operator === 'ends_with') {
    if (typeof filter.value !== 'string') return undefined;
    return {
      op: 'profile_text',
      field,
      cmp: operator,
      value: filter.value,
      caseSensitive: filter.caseSensitive ?? false,
    };
  }
  if (operator === 'exists') return { op: 'profile_exists', field };
  if (operator === 'is_null') return { op: 'profile_is_null', field };
  return undefined;
}

const KNOWN_PROFILE_FIELDS = new Set([
  'profileId', 'eventKind', 'timestamp', 'actor', 'sessionId', 'turnId', 'parentId',
  'messageId', 'toolCallId', 'subagentId', 'model', 'status', 'severity', 'summary',
  'confidence', 'usageInput', 'usageOutput', 'usageCached', 'usageTotal',
]);

function fieldPathFromColumnId(id: string): FieldPath | undefined {
  if (id.length > 256) return undefined;
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length > 32) return undefined;
    const tokens = parsed.map((token): FieldPath['tokens'][number] | undefined => {
      if (token === null || typeof token !== 'object' || Array.isArray(token)) return undefined;
      const candidate = token as Record<string, unknown>;
      if (candidate.kind === 'key' && typeof candidate.value === 'string' && candidate.value.length <= 1024) {
        return { kind: 'key', value: candidate.value };
      }
      if (
        candidate.kind === 'index'
        && typeof candidate.value === 'number'
        && Number.isSafeInteger(candidate.value)
        && candidate.value >= 0
      ) {
        return { kind: 'index', value: candidate.value };
      }
      return undefined;
    });
    if (tokens.some((token) => token === undefined)) return undefined;
    return { tokens: tokens as FieldPath['tokens'] };
  } catch {
    if (/^[A-Za-z_$][\w$]{0,127}$/.test(id)) {
      return { tokens: [{ kind: 'key', value: id }] };
    }
    return undefined;
  }
}

function validFieldPath(value: unknown): value is FieldPath {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as { tokens?: unknown }).tokens)
    && (value as { tokens: unknown[] }).tokens.length <= 32
    && (value as { tokens: unknown[] }).tokens.every((token) => {
      if (token === null || typeof token !== 'object' || Array.isArray(token)) return false;
      const candidate = token as Record<string, unknown>;
      return (candidate.kind === 'key' && typeof candidate.value === 'string' && candidate.value.length <= 1024)
        || (candidate.kind === 'index' && typeof candidate.value === 'number'
          && Number.isSafeInteger(candidate.value) && candidate.value >= 0);
    });
}

export function isCompareOperator(value: RowFilterOperator): value is 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' {
  return value === 'eq'
    || value === 'ne'
    || value === 'lt'
    || value === 'lte'
    || value === 'gt'
    || value === 'gte';
}

export function isJsonKind(value: unknown): value is JsonKind {
  return value === 'object'
    || value === 'array'
    || value === 'string'
    || value === 'integer'
    || value === 'number'
    || value === 'boolean'
    || value === 'null';
}

/** Parse the deliberately small literal grammar used by the filter input. */
export function parseFilterLiteral(text: string): JsonScalar {
  const value = text.trim();
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && Number.isFinite(Number(value))) return Number(value);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isJsonScalar(parsed)) return parsed;
    } catch {
      // Keep the input as a string when it is not valid JSON string syntax.
    }
  }
  return text;
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}
