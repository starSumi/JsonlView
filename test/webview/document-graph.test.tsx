import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GraphView } from '../../src/webview/features/document-graph/GraphView';
import { DocumentGraphUiController } from '../../src/webview/features/document-graph/controller';
import { VsCodeMessageClient } from '../../src/webview/protocol-client';
import { projectDocumentGraph } from '../../src/application/document-graph';
import { PROTOCOL_VERSION, type DocumentSummary, type WebviewRequest, type ExtensionMessage } from '../../src/shared/types';

function fixture() {
  let summary = { snapshot: { documentId: 'doc', generation: 'g', epoch: 1 }, profileId: 'generic', profileVersion: 'v', profileEpoch: 1, indexingComplete: true } as DocumentSummary;
  const sent: WebviewRequest[] = [];
  const client = new VsCodeMessageClient({ postMessage: (message) => { sent.push(message); } }, summary.snapshot);
  const controller = new DocumentGraphUiController({ client, getSummary: () => summary, canRead: () => true, onChange() {} });
  const ref = { generation: 'g', ordinal: '0', byteStart: '0', byteEndExclusive: '2', contentByteLength: '2', delimiterByteLength: 1 as const, parseState: 'valid' as const };
  const reply = projectDocumentGraph(summary, { rows: [{ ref, cells: [], genericSummary: '<script>source</script>' }], columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1', totalRecords: '1' }, '1');
  const response = (type: string, requestId: string, payload: unknown) => ({ protocolVersion: PROTOCOL_VERSION, type, requestId, documentId: 'doc', generation: 'g', epoch: 1, payload }) as ExtensionMessage;
  return { controller, sent, reply, response, changeProfile: () => { summary = { ...summary, profileEpoch: 2 }; } };
}
describe('Graph A product view and current UI correlation', () => {
  it('has discoverable left actions and escapes source labels', () => {
    const f = fixture(); const html = renderToStaticMarkup(<GraphView state={{ status: 'ready', reply: f.reply }} onRefresh={() => {}} onSelect={() => {}} onQuery={() => {}} onSource={() => {}} onReveal={() => {}} />);
    expect(html).toContain('aria-label="Graph actions"');
    for (const label of ['Graph', 'Query', 'Source', 'Reveal', 'physical records 0–99', 'independent of table filters']) expect(html).toContain(label);
    expect(html).toContain('&lt;script&gt;source&lt;/script&gt;'); expect(html).not.toContain('<script>');
  });
  it('does not render source labels in stale/unauthorized/unavailable/loading states', () => {
    const f = fixture();
    for (const status of ['stale', 'unauthorized', 'unavailable', 'loading'] as const) {
      const html = renderToStaticMarkup(<GraphView state={{ status, reply: f.reply }} onRefresh={() => {}} onSelect={() => {}} onQuery={() => {}} onSource={() => {}} onReveal={() => {}} />);
      expect(html).not.toContain('&lt;script&gt;source');
    }
  });
  it('rejects a late profile reply and clears all previous source nodes on invalidation', () => {
    const f = fixture(); f.controller.refresh(); const request = f.sent.at(-1)!;
    f.changeProfile(); f.controller.receive(f.response('GRAPH', request.requestId, f.reply));
    expect(f.controller.state.status).toBe('stale'); expect(f.controller.state.reply).toBeUndefined();
  });
  it('accepts only the current issued reference receipt, preserving failed or shown outcomes', () => {
    const f = fixture(); f.controller.refresh(); const request = f.sent.at(-1)!;
    f.controller.receive(f.response('GRAPH', request.requestId, f.reply));
    const node = f.reply.graph.snapshot.nodes[0]!; f.controller.reveal(node); const reveal = f.sent.at(-1)!;
    const payload = { graphRequestId: request.requestId, ref: node.recordRef!, outcome: 'shown' };
    f.controller.receive(f.response('GRAPH_REVEAL_RESULT', reveal.requestId, { ...payload, ref: { ...payload.ref, byteStart: '9' } }));
    expect(f.controller.state.revealStatus).toContain('Locating');
    f.controller.receive(f.response('GRAPH_REVEAL_RESULT', reveal.requestId, payload));
    expect(f.controller.state.revealStatus).toContain('shown');
    f.controller.receive(f.response('SOURCE_INVALIDATED', '', { reason: 'append' }));
    expect(f.controller.state.reply).toBeUndefined(); expect(f.controller.state.status).toBe('stale');
  });
});
