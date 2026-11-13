import { describe, expect, it } from 'vitest';
import { layoutDocumentGraph } from '../../src/webview/features/document-graph/layout';
import { buildBoundedGraph } from '../../src/shared/graph-model';

const ref = (id: string) => ({ sourceId: 's', nativeId: id });
function snapshot(cycle = false) {
  return buildBoundedGraph({ graphGeneration: '1', snapshotRevision: '1', profileVersion: 'v', sourceGenerations: [{ sourceId: 's', generation: 'g' }],
    nodes: ['a', 'b', 'c'].map((id) => ({ ref: ref(id), displayLabel: id, status: 'available', labelOrigin: 'provider' })),
    edges: [{ ref: ref('ab'), from: ref('a'), to: ref('b'), kind: 'parent', provenance: 'observed' },
      { ref: ref('bc'), from: ref('b'), to: ref('c'), kind: 'parent', provenance: 'observed' },
      ...(cycle ? [{ ref: ref('ca'), from: ref('c'), to: ref('a'), kind: 'parent' as const, provenance: 'observed' as const }] : [])] }).snapshot;
}
describe('bounded hierarchy A layout', () => {
  it('places children at increasing depth and collapses only descendants', () => {
    const graph = snapshot(); const full = layoutDocumentGraph(graph, new Set());
    expect(full.nodes.map((node) => node.depth)).toEqual([0, 1, 2]);
    const collapsed = layoutDocumentGraph(graph, new Set([graph.nodes[0]!.nodeId]));
    expect(collapsed.nodes).toHaveLength(1); expect(collapsed.edges).toHaveLength(0);
  });
  it('terminates cycles without fabricating a relation or dropping every node', () => {
    const graph = snapshot(true); const result = layoutDocumentGraph(graph, new Set());
    expect(result.nodes).toHaveLength(3); expect(result.edges).toHaveLength(3);
    expect(new Set(result.nodes.map((node) => node.node.nodeId)).size).toBe(3);
    expect(result.width).toBeLessThan(30_000); expect(result.height).toBeLessThan(12_000);
  });
});
