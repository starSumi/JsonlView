import type { AgentRowProjection, DocumentSummary, RowPage, RowProjection } from '../../src/shared/types';

export const lineageEvidence = (field: string, ...keys: string[]) => ({ field,
  path: { tokens: keys.map((value) => ({ kind: 'key' as const, value })) } });
export function lineageRow(ordinal: number, profile: Partial<AgentRowProjection> = {}): RowProjection {
  return { ref: { generation: 'g', ordinal: String(ordinal), byteStart: String(ordinal * 10), byteEndExclusive: String(ordinal * 10 + 9),
    contentByteLength: '9', delimiterByteLength: 1, parseState: 'valid' }, cells: [], genericSummary: `Record ${ordinal}`,
    profile: { profileId: 'claude-code-session', eventKind: 'message', summary: `Message ${ordinal}`, sessionId: 's',
      messageId: `m${ordinal}`, confidence: 'source', evidence: [lineageEvidence('messageId', 'uuid')], ...profile } };
}
export function lineageSummary(): DocumentSummary {
  return { snapshot: { documentId: 'doc', generation: 'g', epoch: 1, uri: 'file:///synthetic.jsonl', scheme: 'file',
    sizeBytes: '10000', mtimeMs: 0, prefixFingerprint: 'synthetic', observedAt: '2026-01-01T00:00:00Z' }, profileId: 'claude-code-session', profileVersion: '3',
    profileEpoch: 1, profileSuggestions: [], indexedBytes: '10000', indexedRecords: '1000', indexingComplete: true,
    validRecords: '1000', problemRecords: '0' };
}
export function lineagePage(rows: RowProjection[]): RowPage {
  return { rows, columns: [], anchorOrdinal: rows[0]?.ref.ordinal ?? '0', hasBefore: false, hasAfter: false,
    indexedRecords: '1000', scan: { examinedRecords: String(rows.length), examinedBytes: String(rows.length * 9) } };
}
