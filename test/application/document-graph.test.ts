import { describe, expect, it } from 'vitest';
import { projectDocumentGraph } from '../../src/application/document-graph';
import type { AgentRowProjection, DocumentSummary, RowPage, RowProjection } from '../../src/shared/types';

const summary = { snapshot: { documentId: 'doc', generation: 'g', epoch: 1 }, profileId: 'claude-code-session',
  profileVersion: 'v', profileEpoch: 1, indexingComplete: true } as DocumentSummary;
function row(ordinal: number, profile?: Partial<AgentRowProjection>): RowProjection {
  return { ref: { generation: 'g', ordinal: String(ordinal), byteStart: String(ordinal * 3),
    byteEndExclusive: String(ordinal * 3 + 2), contentByteLength: '2', delimiterByteLength: 1, parseState: 'valid' },
  cells: [], genericSummary: `row ${ordinal}`, ...(profile === undefined ? {} : { profile: {
    profileId: 'claude-code-session', eventKind: 'message', summary: `message ${ordinal}`, confidence: 'source', evidence: [], ...profile,
  } }) };
}
function page(rows: RowProjection[]): RowPage {
  return { rows, columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: String(rows.length), totalRecords: String(rows.length) };
}
const evidence = (field: string, key: string) => ({ field, path: { tokens: [{ kind: 'key' as const, value: key }] } });

describe('current document graph production projection', () => {
  it('preserves exact physical refs and only links source-evidenced provider parent semantics', () => {
    const rows = [row(0, { messageId: 'a', evidence: [evidence('messageId', 'uuid')] }),
      row(1, { messageId: 'b', parentId: 'a', evidence: [evidence('messageId', 'uuid'), evidence('parentId', 'parentUuid')] })];
    const result = projectDocumentGraph(summary, page(rows), '1');
    expect(result.status).toBe('ready');
    expect(result.graph.snapshot.nodes.map((node) => node.recordRef)).toEqual(rows.map((item) => item.ref));
    expect(result.graph.snapshot.edges).toHaveLength(1);
    expect(result.graph.snapshot.edges[0]).toMatchObject({ kind: 'parent', provenance: 'observed', evidenceRef: rows[1]!.ref });
  });
  it('omits guessed, ambiguous and cross-provider relationships while retaining physical nodes', () => {
    const rows = [row(0, { messageId: 'a', evidence: [evidence('messageId', 'uuid')] }),
      row(1, { messageId: 'a', evidence: [evidence('messageId', 'uuid')] }),
      row(2, { parentId: 'a', evidence: [evidence('parentId', 'parentUuid')] }),
      row(3, { profileId: 'codex-rollout', parentId: 'a', evidence: [evidence('parentId', 'parent_id')] }),
      row(4, { parentId: 'a' })];
    const result = projectDocumentGraph(summary, page(rows), '1');
    expect(result.graph.snapshot.nodes).toHaveLength(5);
    expect(result.graph.snapshot.edges).toHaveLength(0);
    expect(result.status).toBe('partial');
    expect(result.missingRelations).toBe(3);
  });
  it('bounds input and exposes partial scope instead of implying complete-source coverage', () => {
    const result = projectDocumentGraph(summary, page(Array.from({ length: 120 }, (_, index) => row(index))), '1');
    expect(result.graph.snapshot.nodes).toHaveLength(100);
    expect(result.scope).toEqual({ kind: 'physical-prefix', limit: 100, examinedRecords: 100 });
    expect(result.status).toBe('partial');
    expect(result.graph.snapshot.coverage).toBe('partial');
  });
  it('retains a missing-ref node without making a reveal locator from ordinal', () => {
    const invalid = row(0); invalid.ref.generation = 'old';
    const result = projectDocumentGraph(summary, page([invalid]), '1');
    expect(result.missingRefs).toBe(1);
    expect(result.graph.snapshot.nodes[0]?.recordRef).toBeUndefined();
    expect(result.status).toBe('partial');
  });
});
