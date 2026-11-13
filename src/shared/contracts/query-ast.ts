import type { FieldPath, JsonKind, JsonScalar } from './record';
import type { Predicate } from './query';

/** Stable wire discriminator for the query expression contract. */
export const QUERY_AST_SCHEMA = 'jsonlview.query-ast.v1' as const;
export const QUERY_AST_VERSION = 1 as const;

/** Limits shared by AST producers before an expression reaches a transport boundary. */
export const QUERY_AST_LIMITS: Readonly<{
  maxDepth: number;
  maxNodes: number;
  maxArgs: number;
  maxPaths: number;
  maxPathTokens: number;
  maxStringLength: number;
  maxProfileFieldLength: number;
  maxPathKeyLength: number;
}> = Object.freeze({
  maxDepth: 16,
  maxNodes: 256,
  maxArgs: 64,
  maxPaths: 64,
  maxPathTokens: 32,
  maxStringLength: 16 * 1024,
  maxProfileFieldLength: 128,
  maxPathKeyLength: 1024,
});

/** The versioned node aliases Predicate; its evaluator remains the semantic oracle. */
export type QueryAstNodeV1 = Predicate;

/** An omitted predicate keeps the established match-all GET_ROWS behavior. */
export interface QueryAstV1 {
  readonly schema: typeof QUERY_AST_SCHEMA;
  readonly version: typeof QUERY_AST_VERSION;
  readonly predicate?: QueryAstNodeV1;
}

export type QueryAst = QueryAstV1;

export function createQueryAstV1(predicate?: Predicate): QueryAstV1 {
  return { schema: QUERY_AST_SCHEMA, version: QUERY_AST_VERSION,
    ...(predicate === undefined ? {} : { predicate }) };
}

/** Runtime guard for untrusted parser/native input and wire transport. */
export function isQueryAstV1(value: unknown): value is QueryAstV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schema', 'version', 'predicate'])
    || value.schema !== QUERY_AST_SCHEMA || value.version !== QUERY_AST_VERSION) return false;
  return value.predicate === undefined || isPredicate(value.predicate, 0, { nodes: 0 });
}

/** Lowering is intentionally identity-shaped: Predicate remains the oracle. */
export function lowerQueryAstV1(ast: QueryAstV1): Predicate | undefined {
  if (!isQueryAstV1(ast)) throw new TypeError('Invalid query AST v1.');
  return ast.predicate;
}

function isPredicate(value: unknown, depth: number, budget: { nodes: number }): value is Predicate {
  if (!isRecord(value) || depth > QUERY_AST_LIMITS.maxDepth || ++budget.nodes > QUERY_AST_LIMITS.maxNodes) return false;
  switch (value.op) {
    case 'and':
    case 'or':
      return Array.isArray(value.args) && value.args.length > 0 && value.args.length <= QUERY_AST_LIMITS.maxArgs
        && value.args.every((arg) => isPredicate(arg, depth + 1, budget));
    case 'not': return isPredicate(value.arg, depth + 1, budget);
    case 'compare': return isFieldPath(value.path) && isCompareOperator(value.cmp) && isScalar(value.value);
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      return isFieldPath(value.path) && isBoundedString(value.value, QUERY_AST_LIMITS.maxStringLength)
        && typeof value.caseSensitive === 'boolean';
    case 'exists':
    case 'is_null': return isFieldPath(value.path);
    case 'kind_is': return isFieldPath(value.path) && isJsonKind(value.kind);
    case 'text_search':
      return isBoundedString(value.value, QUERY_AST_LIMITS.maxStringLength) && typeof value.caseSensitive === 'boolean'
        && (value.paths === undefined || (Array.isArray(value.paths) && value.paths.length <= QUERY_AST_LIMITS.maxPaths
          && value.paths.every(isFieldPath)));
    case 'profile_field':
      return isBoundedString(value.field, QUERY_AST_LIMITS.maxProfileFieldLength)
        && isCompareOperator(value.cmp) && isScalar(value.value);
    case 'profile_text':
      return isBoundedString(value.field, QUERY_AST_LIMITS.maxProfileFieldLength) && isTextOperator(value.cmp)
        && isBoundedString(value.value, QUERY_AST_LIMITS.maxStringLength) && typeof value.caseSensitive === 'boolean';
    case 'profile_exists':
    case 'profile_is_null': return isBoundedString(value.field, QUERY_AST_LIMITS.maxProfileFieldLength);
    default: return false;
  }
}

function isFieldPath(value: unknown): value is FieldPath {
  return isRecord(value) && Array.isArray(value.tokens) && value.tokens.length <= QUERY_AST_LIMITS.maxPathTokens
    && value.tokens.every((token) => isRecord(token)
      && ((token.kind === 'key' && isBoundedString(token.value, QUERY_AST_LIMITS.maxPathKeyLength))
        || (token.kind === 'index' && Number.isSafeInteger(token.value) && Number(token.value) >= 0)));
}

function isCompareOperator(value: unknown): value is 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' {
  return value === 'eq' || value === 'ne' || value === 'lt' || value === 'lte' || value === 'gt' || value === 'gte';
}
function isTextOperator(value: unknown): value is 'contains' | 'starts_with' | 'ends_with' {
  return value === 'contains' || value === 'starts_with' || value === 'ends_with';
}
function isJsonKind(value: unknown): value is JsonKind {
  return value === 'object' || value === 'array' || value === 'string' || value === 'integer'
    || value === 'number' || value === 'boolean' || value === 'null';
}
function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value)) || isBoundedString(value, QUERY_AST_LIMITS.maxStringLength);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
