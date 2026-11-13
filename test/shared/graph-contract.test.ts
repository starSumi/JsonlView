import { describe, expect, it } from 'vitest';
import { buildBoundedGraph } from '../../src/shared/graph-model';
import { isGraphBuildResult } from '../../src/shared/contracts/graph';

const validGraph = () => buildBoundedGraph({
  graphGeneration: '1',
  snapshotRevision: '1',
  profileVersion: 'v1',
  sourceGenerations: [{ sourceId: 'source', generation: 'g1' }],
  nodes: [
    { ref: { sourceId: 'source', nativeId: 'a' }, displayLabel: 'A', labelOrigin: 'provider', status: 'available' },
    { ref: { sourceId: 'source', nativeId: 'b' }, displayLabel: 'B', labelOrigin: 'provider', status: 'available' },
  ],
  edges: [{
    ref: { sourceId: 'source', nativeId: 'edge' },
    from: { sourceId: 'source', nativeId: 'a' },
    to: { sourceId: 'source', nativeId: 'b' },
    kind: 'references',
    provenance: 'observed',
    evidencePaths: [{ tokens: [{ kind: 'key', value: 'relation' }], canonical: 'relation' }],
  }],
});

describe('Graph v2 contract guard', () => {
  it('accepts a bounded graph built by the canonical graph model', () => {
    expect(isGraphBuildResult(validGraph())).toBe(true);
  });

  it.each([
    ['diagnostics', (graph: ReturnType<typeof validGraph>) => ({ ...graph, diagnostics: new Array(1) })],
    ['evidence paths', (graph: ReturnType<typeof validGraph>) => ({
      ...graph,
      snapshot: { ...graph.snapshot, edges: [{ ...graph.snapshot.edges[0]!, evidencePaths: new Array(1) }] },
    })],
    ['evidence path tokens', (graph: ReturnType<typeof validGraph>) => ({
      ...graph,
      snapshot: { ...graph.snapshot, edges: [{
        ...graph.snapshot.edges[0]!,
        evidencePaths: [{ ...graph.snapshot.edges[0]!.evidencePaths[0]!, tokens: new Array(1) }],
      }] },
    })],
  ])('rejects a sparse %s array', (_label, sparse) => {
    expect(isGraphBuildResult(sparse(validGraph()))).toBe(false);
  });
});
