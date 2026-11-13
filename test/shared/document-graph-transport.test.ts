import { describe, expect, it } from 'vitest';
import { projectDocumentGraph } from '../../src/application/document-graph';
import { isExtensionMessage } from '../../src/shared/transport';
import { validateWebviewRequest } from '../../src/extension/message-validation';
import { PROTOCOL_VERSION, type DocumentSummary } from '../../src/shared/types';

const summary = { snapshot: { documentId: 'doc', generation: 'g', epoch: 1 }, profileId: 'generic', profileVersion: 'v', indexingComplete: true } as DocumentSummary;
const ref = { generation: 'g', ordinal: '0', byteStart: '0', byteEndExclusive: '2', contentByteLength: '2', delimiterByteLength: 1 as const, parseState: 'valid' as const };
const envelope = (type: string, payload: unknown) => ({ protocolVersion: PROTOCOL_VERSION, type,
  delivery: type === 'GET_GRAPH' || type === 'REVEAL_GRAPH_RECORD' ? 'request' : 'reply',
  requestId: 'r', documentId: 'doc', generation: 'g', epoch: 1, payload });
const reply = () => projectDocumentGraph(summary, { rows: [{ ref, cells: [], genericSummary: 'record' }], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1', totalRecords: '1' }, '1');
describe('bounded current-document Graph transport', () => {
  it('keeps fixed Host scope and closed exact physical reveal request', () => {
    expect(validateWebviewRequest(envelope('GET_GRAPH', {})).ok).toBe(true);
    expect(validateWebviewRequest(envelope('GET_GRAPH', { path: 'arbitrary' })).ok).toBe(false);
    expect(validateWebviewRequest(envelope('REVEAL_GRAPH_RECORD', { graphRequestId: 'graph', ref })).ok).toBe(true);
    for (const payload of [{ graphRequestId: 'graph', ref: { ...ref, generation: 'old' } },
      { graphRequestId: 'graph', ref: { ...ref, path: 'arbitrary' } }, { graphRequestId: 'graph', ref, sourceId: 'other' }]) {
      expect(validateWebviewRequest(envelope('REVEAL_GRAPH_RECORD', payload)).ok).toBe(false);
    }
  });
  it('rejects cross-source, stale or over-cap nodes and data in unavailable replies', () => {
    expect(isExtensionMessage(envelope('GRAPH', reply()))).toBe(true);
    const base = reply(); const node = base.graph.snapshot.nodes[0]!;
    for (const nodes of [[{ ...node, qualifiedRef: { ...node.qualifiedRef, sourceId: 'other' } }],
      [{ ...node, recordRef: { ...ref, generation: 'old' } }], Array.from({ length: 101 }, () => node)]) {
      expect(isExtensionMessage(envelope('GRAPH', { ...base, graph: { ...base.graph, snapshot: { ...base.graph.snapshot, nodes } } }))).toBe(false);
    }
    expect(isExtensionMessage(envelope('GRAPH', { ...base, status: 'unauthorized' }))).toBe(false);
  });
  it('requires current physical ref and known outcome on reveal receipts', () => {
    expect(isExtensionMessage(envelope('GRAPH_REVEAL_RESULT', { graphRequestId: 'graph', ref, outcome: 'shown' }))).toBe(true);
    expect(isExtensionMessage(envelope('GRAPH_REVEAL_RESULT', { graphRequestId: 'graph', ref: { ...ref, generation: 'old' }, outcome: 'shown' }))).toBe(false);
    expect(isExtensionMessage(envelope('GRAPH_REVEAL_RESULT', { graphRequestId: 'graph', ref: { ...ref, future: true }, outcome: 'shown' }))).toBe(false);
  });
});
