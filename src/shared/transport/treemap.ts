import {
  TREEMAP_MAX_DEPTH,
  TREEMAP_MAX_FINGERPRINT_LENGTH,
  TREEMAP_MAX_ID_LENGTH,
  TREEMAP_MAX_LABEL_LENGTH,
  TREEMAP_MAX_NODES,
  TREEMAP_MAX_VALUE_DIGITS,
  TREEMAP_VERSION,
  type TreemapIdentity,
  type TreemapMetadataV1,
  type TreemapNodeV1,
} from '../treemap';

const SCOPES = new Set(['source', 'provider', 'session', 'event-kind', 'field-group']);
const METRICS = new Set(['bytes', 'records']);

/**
 * Binds metadata to the current authorized identity supplied by its owner.
 * Rejects unknown properties; authorization itself remains with the Host.
 */
export function isTreemapMetadataV1(value: unknown, current: TreemapIdentity | undefined): value is TreemapMetadataV1 {
  if (current === undefined || !isIdentity(current) || !object(value)
    || !exact(value, ['version', 'sourceId', 'documentId', 'generation', 'fingerprint', 'metric', 'scope', 'root', 'truncated'])
    || value.version !== TREEMAP_VERSION
    || value.sourceId !== current.sourceId
    || value.documentId !== current.documentId
    || value.generation !== current.generation
    || value.fingerprint !== current.fingerprint
    || !isOpaqueIdentifier(value.sourceId)
    || !isOpaqueIdentifier(value.documentId)
    || !isOpaqueIdentifier(value.generation)
    || !isFingerprint(value.fingerprint)
    || typeof value.metric !== 'string' || !METRICS.has(value.metric)
    || typeof value.scope !== 'string' || !SCOPES.has(value.scope)
    || typeof value.truncated !== 'boolean') return false;
  return isNode(value.root, 0, { count: 0 });
}

function isNode(value: unknown, depth: number, state: { count: number }): value is TreemapNodeV1 {
  if (!object(value) || depth >= TREEMAP_MAX_DEPTH || state.count >= TREEMAP_MAX_NODES
    || !exact(value, value.children === undefined ? ['id', 'label', 'value'] : ['id', 'label', 'value', 'children'])
    || !isOpaqueIdentifier(value.id)
    || !isBoundedText(value.label, TREEMAP_MAX_LABEL_LENGTH)
    || !isDecimal(value.value)) return false;
  state.count += 1;
  if (value.children === undefined) return true;
  if (!Array.isArray(value.children) || value.children.length > TREEMAP_MAX_NODES - state.count) return false;
  for (let index = 0; index < value.children.length; index += 1) {
    if (!Object.hasOwn(value.children, index) || !isNode(value.children[index], depth + 1, state)) return false;
  }
  return true;
}

function isIdentity(value: TreemapIdentity): boolean {
  return object(value)
    && isOpaqueIdentifier(value.sourceId)
    && isOpaqueIdentifier(value.documentId)
    && isOpaqueIdentifier(value.generation)
    && isFingerprint(value.fingerprint);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TREEMAP_MAX_ID_LENGTH
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TREEMAP_MAX_FINGERPRINT_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TREEMAP_MAX_VALUE_DIGITS && /^(?:0|[1-9]\d*)$/u.test(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
