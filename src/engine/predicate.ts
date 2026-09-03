import type {
  FieldPath,
  JsonKind,
  JsonScalar,
  Predicate,
} from '../shared/types';

export interface PredicateContext {
  profileFields?: Readonly<Record<string, JsonScalar | undefined>>;
}

export interface ResolvedField {
  exists: boolean;
  value?: unknown;
}

export function jsonKindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';

  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    default:
      // Parsed JSON cannot contain undefined, bigint, functions, or symbols.
      return 'null';
  }
}
export function resolveFieldPath(value: unknown, path: FieldPath): ResolvedField {
  let current = value;

  for (const token of path.tokens) {
    if (token.kind === 'index') {
      if (!Array.isArray(current) || !Number.isInteger(token.value)) {
        return { exists: false };
      }
      const index = Number(token.value);
      if (index < 0 || index >= current.length) return { exists: false };
      current = current[index];
      continue;
    }

    if (
      current === null
      || typeof current !== 'object'
      || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, token.value)
    ) {
      return { exists: false };
    }
    current = (current as Record<string, unknown>)[String(token.value)];
  }

  return { exists: true, value: current };
}

function scalarEquals(left: unknown, right: JsonScalar): boolean {
  return left === right;
}

function orderedCompare(left: unknown, right: JsonScalar): number | undefined {
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return undefined;
}

function compare(left: unknown, cmp: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte', right: JsonScalar): boolean {
  if (cmp === 'eq') return scalarEquals(left, right);
  if (cmp === 'ne') return !scalarEquals(left, right);

  const ordering = orderedCompare(left, right);
  if (ordering === undefined) return false;
  switch (cmp) {
    case 'lt': return ordering < 0;
    case 'lte': return ordering <= 0;
    case 'gt': return ordering > 0;
    case 'gte': return ordering >= 0;
  }
}

function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function matchesText(haystack: string, needle: string, caseSensitive: boolean): boolean {
  return caseSensitive
    ? haystack.includes(needle)
    : haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export function evaluatePredicate(
  predicate: Predicate,
  value: unknown,
  context: PredicateContext = {},
): boolean {
  switch (predicate.op) {
    case 'and':
      return predicate.args.every((arg) => evaluatePredicate(arg, value, context));
    case 'or':
      return predicate.args.some((arg) => evaluatePredicate(arg, value, context));
    case 'not':
      return !evaluatePredicate(predicate.arg, value, context);
    case 'compare': {
      const resolved = resolveFieldPath(value, predicate.path);
      return resolved.exists && compare(resolved.value, predicate.cmp, predicate.value);
    }
    case 'contains':
    case 'starts_with':
    case 'ends_with': {
      const resolved = resolveFieldPath(value, predicate.path);
      if (!resolved.exists || typeof resolved.value !== 'string') return false;
      const actual = predicate.caseSensitive ? resolved.value : resolved.value.toLocaleLowerCase();
      const expected = predicate.caseSensitive ? predicate.value : predicate.value.toLocaleLowerCase();
      if (predicate.op === 'contains') return actual.includes(expected);
      if (predicate.op === 'starts_with') return actual.startsWith(expected);
      return actual.endsWith(expected);
    }
    case 'exists':
      return resolveFieldPath(value, predicate.path).exists;
    case 'is_null': {
      const resolved = resolveFieldPath(value, predicate.path);
      return resolved.exists && resolved.value === null;
    }
    case 'kind_is': {
      const resolved = resolveFieldPath(value, predicate.path);
      return resolved.exists && jsonKindOf(resolved.value) === predicate.kind;
    }
    case 'text_search': {
      const candidates = predicate.paths === undefined
        ? [value]
        : predicate.paths
          .map((path) => resolveFieldPath(value, path))
          .filter((resolved) => resolved.exists)
          .map((resolved) => resolved.value);
      return candidates.some((candidate) => matchesText(
        searchableText(candidate),
        predicate.value,
        predicate.caseSensitive,
      ));
    }
    case 'profile_field': {
      const fields = context.profileFields;
      if (fields === undefined || !Object.prototype.hasOwnProperty.call(fields, predicate.field)) {
        return false;
      }
      return compare(fields[predicate.field], predicate.cmp, predicate.value);
    }
  }
}
