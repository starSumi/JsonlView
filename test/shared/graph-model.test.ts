import { describe, expect, it } from 'vitest';
import {
  GRAPH_MAX_NODES,
  buildBoundedGraph,
  graphEdgeId,
  graphNodeId,
  isGraphGenerationCurrent,
  isGraphLayoutCurrent,
  type GraphBuildInput,
  type GraphAuthorizationContext,
  type GraphEdgeInput,
  type GraphNodeInput,
  type GraphQualifiedReference,
} from '../../src/shared/graph-model';

function ref(sourceId: string, nativeId: string, providerId?: string): GraphQualifiedReference {
  return { ...(providerId === undefined ? {} : { providerId }), sourceId, nativeId };
}

function node(reference: GraphQualifiedReference, displayLabel = reference.nativeId): GraphNodeInput {
  return { ref: reference, displayLabel, labelOrigin: 'provider', status: 'available' };
}

function edge(edgeRef: GraphQualifiedReference, from: GraphQualifiedReference, to: GraphQualifiedReference): GraphEdgeInput {
  return { ref: edgeRef, from, to, kind: 'references', provenance: 'observed' };
}

function crossSourceEvidence(generation: string) {
  return { sourceGeneration: generation,
    evidenceRef: { generation, ordinal: '0', byteStart: '0', byteEndExclusive: '2', contentByteLength: '2', delimiterByteLength: 1 as const, parseState: 'valid' as const },
    evidencePaths: [{ tokens: [{ kind: 'key' as const, value: 'parent_id' }], canonical: 'parent_id' }] };
}

function authorization(input: GraphBuildInput): GraphAuthorizationContext {
  return { authorizedSources: input.sourceGenerations, authorizeCrossSourceEdge: () => true, verifyEvidence: () => true };
}

function graph(overrides: Partial<GraphBuildInput> = {}): GraphBuildInput {
  const a = ref('source-a', 'a');
  const b = ref('source-a', 'b');
  return {
    graphGeneration: '1',
    snapshotRevision: '1',
    profileVersion: 'generic-v1',
    sourceGenerations: [{ sourceId: 'source-a', generation: 'source-1' }],
    nodes: [node(a), node(b)],
    edges: [edge(ref('source-a', 'edge-1'), a, b)],
    ...overrides,
  };
}

describe('bounded Graph v2 application model', () => {
  it('builds stable source-qualified identities and preserves distinct parallel edges', () => {
    const a = ref('source-a', 'same-native-id', 'provider-a');
    const b = ref('source-b', 'same-native-id', 'provider-a');
    const c = ref('source-a', 'same-native-id', 'provider-b');
    const input = graph({
      sourceGenerations: [
        { sourceId: 'source-a', generation: 'source-a-1' },
        { sourceId: 'source-b', generation: 'source-b-1' },
      ],
      nodes: [node(a), node(b), node(c)],
      edges: [
        { ...edge(ref('source-a', 'edge-1'), a, b), ...crossSourceEvidence('source-a-1'), evidencePaths: [{
          tokens: [{ kind: 'key', value: 'messages' }, { kind: 'index', value: 0 }],
          canonical: 'messages[0]',
        }] },
        { ...edge(ref('source-a', 'edge-2'), a, b), ...crossSourceEvidence('source-a-1') },
      ],
    });
    const result = buildBoundedGraph(input, {}, authorization(input));

    expect(new Set(result.snapshot.nodes.map((item) => item.nodeId)).size).toBe(3);
    expect(new Set(result.snapshot.edges.map((item) => item.edgeId)).size).toBe(2);
    expect(result.snapshot.edges.map((item) => item.fromNodeId)).toEqual([graphNodeId(a), graphNodeId(a)]);
    expect(result.snapshot.edges[0]?.evidencePaths).toEqual([{
      tokens: [{ kind: 'key', value: 'messages' }, { kind: 'index', value: 0 }],
      canonical: 'messages[0]',
    }]);
    expect(graphNodeId(a)).not.toBe(graphNodeId(b));
    expect(graphNodeId(a)).not.toBe(graphNodeId(c));
    expect(result.snapshot.schema).toBe('jsonlview.graph.v2');
    expect(result.snapshot.coverage).toBe('complete');
  });

  it('uses Map-safe identities for hostile object-property names', () => {
    const refs = [
      ref('__proto__', 'constructor'),
      ref('constructor', 'toString'),
      ref('toString', '__proto__'),
    ];
    const input = graph({
      sourceGenerations: refs.map((item) => ({ sourceId: item.sourceId, generation: 'g1' })),
      nodes: refs.map((item) => node(item)),
      edges: [{ ...edge(ref('__proto__', 'hasOwnProperty'), refs[0]!, refs[1]!), ...crossSourceEvidence('g1') }],
    });
    const result = buildBoundedGraph(input, {}, authorization(input));

    expect(result.snapshot.nodes.map((item) => item.nodeId)).toEqual(refs.map(graphNodeId));
    expect(result.snapshot.edges[0]?.edgeId).toBe(graphEdgeId(ref('__proto__', 'hasOwnProperty')));
    expect(result.snapshot.edges[0]?.toNodeId).toBe(graphNodeId(refs[1]!));
    expect(result.snapshot.coverage).toBe('complete');
  });

  it('rejects graph identities that exceed the frozen ID or Revision boundaries', () => {
    expect(() => graphNodeId(ref('s'.repeat(200), 'n'.repeat(200)))).toThrow(/renderer ID byte limit/u);
    expect(() => graphNodeId(ref('source-a\0', 'node-a'))).toThrow(/bounded opaque source and native IDs/u);
    expect(() => buildBoundedGraph(graph({ graphGeneration: 'generation-1' }))).toThrow(/bounded generation/u);
  });

  it('reports duplicate nodes/edges, missing endpoints, self-loops, and cycles', () => {
    const a = ref('source-a', 'a');
    const b = ref('source-a', 'b');
    const absent = ref('source-a', 'absent');
    const result = buildBoundedGraph(graph({
      nodes: [node(a, 'first'), node(b), node(a, 'duplicate')],
      edges: [
        edge(ref('source-a', 'edge-1'), a, b),
        edge(ref('source-a', 'edge-1'), b, a),
        edge(ref('source-a', 'edge-2'), b, a),
        edge(ref('source-a', 'edge-3'), a, absent),
        edge(ref('source-a', 'edge-4'), a, a),
      ],
    }));

    expect(result.snapshot.nodes).toHaveLength(2);
    expect(result.snapshot.nodes[0]?.displayLabel).toBe('first');
    expect(result.snapshot.edges).toHaveLength(3);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'duplicate-node', 'duplicate-edge', 'missing-endpoint', 'cycle',
    ]));
    expect(result.diagnostics.filter((item) => item.code === 'cycle')).toHaveLength(2);
    expect(result.snapshot.coverage).toBe('partial');
    expect(result.analysisComplete).toBe(true);
  });

  it('caps incident degree and edge count without silently claiming complete coverage', () => {
    const a = ref('source-a', 'a');
    const b = ref('source-a', 'b');
    const c = ref('source-a', 'c');
    const edges = [edge(ref('source-a', 'e1'), a, b), edge(ref('source-a', 'e2'), a, c)];
    const degreeBounded = buildBoundedGraph(graph({ nodes: [node(a), node(b), node(c)], edges }), { maxDegree: 1 });
    expect(degreeBounded.snapshot.edges).toHaveLength(1);
    expect(degreeBounded.diagnostics.map((item) => item.code)).toContain('degree-limit');
    expect(degreeBounded.snapshot.coverage).toBe('partial');

    const edgeBounded = buildBoundedGraph(graph({ nodes: [node(a), node(b), node(c)], edges }), { maxEdges: 1 });
    expect(edgeBounded.snapshot.edges).toHaveLength(1);
    expect(edgeBounded.diagnostics.map((item) => item.code)).toContain('edge-limit');
    expect(edgeBounded.snapshot.coverage).toBe('partial');
  });

  it('bounds deep traversal iteratively and marks cycle analysis incomplete at the depth limit', () => {
    const refs = Array.from({ length: 180 }, (_, index) => ref('source-a', `node-${String(index)}`));
    const nodes = refs.map((item) => node(item));
    const edges = refs.slice(0, -1).map((item, index) => edge(ref('source-a', `edge-${String(index)}`), item, refs[index + 1]!));
    const result = buildBoundedGraph(graph({ nodes, edges }));

    expect(result.snapshot.nodes).toHaveLength(180);
    expect(result.snapshot.edges).toHaveLength(179);
    expect(result.diagnostics.map((item) => item.code)).toContain('depth-limit');
    expect(result.analysisComplete).toBe(false);
    expect(result.snapshot.coverage).toBe('complete');
  });

  it('enforces the hard node cap even when a caller asks to raise it', () => {
    const nodes = Array.from({ length: GRAPH_MAX_NODES + 1 }, (_, index) => node(ref('source-a', `node-${String(index)}`)));
    const result = buildBoundedGraph(graph({ nodes, edges: [] }), { maxNodes: GRAPH_MAX_NODES + 1 });

    expect(result.snapshot.nodes).toHaveLength(GRAPH_MAX_NODES);
    expect(result.diagnostics.map((item) => item.code)).toContain('node-limit');
    expect(result.snapshot.coverage).toBe('partial');
  });

  it('enforces deterministic work and diagnostic budgets', () => {
    const nodes = Array.from({ length: 8 }, (_, index) => node(ref('source-a', `node-${String(index)}`)));
    const limited = buildBoundedGraph(graph({ nodes, edges: [], sourceGenerations: [] }), { maxWorkUnits: 3 });
    expect(limited.workUnits).toBe(3);
    expect(limited.snapshot.nodes).toHaveLength(3);
    expect(limited.snapshot.coverage).toBe('partial');
    expect(limited.analysisComplete).toBe(false);

    const duplicate = node(ref('source-a', 'same'));
    const diagnosticsBounded = buildBoundedGraph(graph({
      sourceGenerations: [],
      nodes: [duplicate, ...Array.from({ length: 8 }, () => duplicate)],
      edges: [],
    }), { maxDiagnostics: 1 });
    expect(diagnosticsBounded.diagnostics).toHaveLength(1);
    expect(diagnosticsBounded.suppressedDiagnostics).toBeGreaterThan(0);

    const a = ref('source-a', 'a');
    const b = ref('source-a', 'b');
    const evidenceBounded = buildBoundedGraph(graph({
      sourceGenerations: [],
      nodes: [node(a), node(b)],
      edges: [{ ...edge(ref('source-a', 'edge-with-path'), a, b), evidencePaths: [{
        tokens: Array.from({ length: 32 }, (_, index) => ({ kind: 'key' as const, value: `k${String(index)}` })),
        canonical: 'bounded-path',
      }] }],
    }), { maxWorkUnits: 4 });
    expect(evidenceBounded.workUnits).toBe(4);
    expect(evidenceBounded.snapshot.edges).toHaveLength(0);
    expect(evidenceBounded.diagnostics.map((item) => item.code)).toContain('work-limit');
  });

  it('bounds labels and evidence paths while retaining diagnostics', () => {
    const a = ref('source-a', 'a');
    const b = ref('source-a', 'b');
    const longCanonical = 'e'.repeat(2_100);
    const result = buildBoundedGraph(graph({
      nodes: [node(a, 'l'.repeat(600)), node(b)],
      edges: [{ ...edge(ref('source-a', 'edge-1'), a, b), evidencePaths: [{
        tokens: [{ kind: 'key', value: 'field' }],
        canonical: longCanonical,
      }] }],
    }));

    expect(result.snapshot.nodes[0]?.displayLabel).toHaveLength(512);
    expect(result.snapshot.edges[0]?.evidencePaths).toHaveLength(0);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['label-truncated', 'invalid-edge']));
    expect(result.snapshot.coverage).toBe('partial');
  });

  it('rejects stale graph/layout results after generation, request, or viewport changes', () => {
    const request = {
      graphGeneration: '2',
      snapshotRevision: '1',
      profileVersion: 'generic-v1',
      sourceGenerations: [{ sourceId: 'source-a', generation: 'g1' }],
      layoutGeneration: 4,
      requestId: 'layout-4',
      viewport: { width: 960, height: 540 },
    } as const;
    expect(isGraphGenerationCurrent('2', '2')).toBe(true);
    expect(isGraphGenerationCurrent('1', '2')).toBe(false);
    expect(isGraphLayoutCurrent(request, request)).toBe(true);
    expect(isGraphLayoutCurrent({ ...request, graphGeneration: '1' }, request)).toBe(false);
    expect(isGraphLayoutCurrent({ ...request, layoutGeneration: 3 }, request)).toBe(false);
    expect(isGraphLayoutCurrent({ ...request, requestId: 'layout-3' }, request)).toBe(false);
    expect(isGraphLayoutCurrent({ ...request, viewport: { width: 959, height: 540 } }, request)).toBe(false);
    expect(isGraphLayoutCurrent({ ...request, viewport: { width: 960, height: 541 } }, request)).toBe(false);
    expect(isGraphLayoutCurrent({ ...request, viewport: { width: Number.POSITIVE_INFINITY, height: 540 } }, request)).toBe(false);
  });
});
