export const SESSION_REFERENCE_MIME = 'application/vnd.jsonlview.session-ref';
export const SESSION_NAVIGATOR_TREE_MIME = 'application/vnd.code.tree.jsonlview.sessionnavigator';
export const SESSION_REFERENCE_DND_LIMIT = 32;
const SESSION_REFERENCE_DND_BYTES = 64 * 1024;

export interface SessionReferenceDragItem {
  readonly providerId: string;
  readonly sourceId: string;
  readonly nativeId: string;
  readonly generation: string;
}

export interface SessionReferenceDragPayload {
  readonly version: 1;
  readonly references: readonly SessionReferenceDragItem[];
}

/** Parse the bounded, versioned transfer format. Drag data is never authorization. */
export function parseSessionReferenceDragPayload(text: string): SessionReferenceDragPayload | undefined {
  if (text.length === 0 || text.length > SESSION_REFERENCE_DND_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || !hasExactKeys(value, ['references', 'version']) || value.version !== 1
    || !Array.isArray(value.references) || value.references.length === 0 || value.references.length > SESSION_REFERENCE_DND_LIMIT) return undefined;
  const references: SessionReferenceDragItem[] = [];
  const seen = new Set<string>();
  for (const candidate of value.references) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['generation', 'nativeId', 'providerId', 'sourceId'])
      || !boundedString(candidate.providerId, 64) || !boundedString(candidate.sourceId, 512)
      || !boundedString(candidate.nativeId, 4096) || !boundedString(candidate.generation, 128)) return undefined;
    const reference = candidate as unknown as SessionReferenceDragItem;
    const key = JSON.stringify([reference.providerId, reference.sourceId, reference.nativeId, reference.generation]);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references.length === 0 ? undefined : { version: 1, references };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === expected.join(',');
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
