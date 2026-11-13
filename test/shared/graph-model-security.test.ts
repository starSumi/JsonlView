import { describe, expect, it, vi } from 'vitest';
import { buildBoundedGraph, isGraphLayoutCurrent, type GraphAuthorizationContext, type GraphBuildInput,
  type GraphEdgeInput, type GraphLayoutIdentity } from '../../src/shared/graph-model';
import type { RecordRef } from '../../src/shared/types';

const a = { sourceId: 'a', nativeId: 'parent' };
const b = { sourceId: 'b', nativeId: 'child' };
const edgeRef = { sourceId: 'a', nativeId: 'relation' };
const generations = [{ sourceId: 'a', generation: 'ga' }, { sourceId: 'b', generation: 'gb' }];
const paths = [{ tokens: [{ kind: 'key' as const, value: 'parent_id' }], canonical: 'parent_id' }];
const recordRef: RecordRef = { generation: 'ga', ordinal: '0', byteStart: '0', byteEndExclusive: '2',
  contentByteLength: '2', delimiterByteLength: 1, parseState: 'valid' };
function graph(edge: Partial<GraphEdgeInput> = {}): GraphBuildInput {
  return { graphGeneration: '1', snapshotRevision: '2', profileVersion: 'profile-v1', sourceGenerations: generations,
    nodes: [a, b].map((ref) => ({ ref, displayLabel: ref.nativeId, kind: 'session' as const, rawKind: 'provider.session', labelOrigin: 'provider', status: 'available' })),
    edges: [{ ref: edgeRef, from: a, to: b, kind: 'parent', provenance: 'observed', sourceGeneration: 'ga', evidencePaths: paths, evidenceRef: recordRef, ...edge }] };
}
function authorization(overrides: Partial<GraphAuthorizationContext> = {}): GraphAuthorizationContext {
  return { authorizedSources: generations, authorizeCrossSourceEdge: vi.fn(() => true), verifyEvidence: vi.fn(() => true), ...overrides };
}

describe('host-owned graph cross-source authorization', () => {
  it('fails closed without a separate host context, including input-supplied permission claims', () => {
    const input = { ...graph(), authorizationContext: authorization(), authorizedSources: generations };
    const result = buildBoundedGraph(input);
    expect(result.snapshot.edges).toHaveLength(0);
    expect(result.snapshot.coverage).toBe('partial');
    expect(result.diagnostics.map((item) => item.code)).toContain('unauthorized-cross-source-edge');
  });
  it('requires explicit grant for every involved current source and the exact cross-source relation', () => {
    for (const context of [authorization({ authorizedSources: [generations[0]!] }),
      authorization({ authorizedSources: [{ sourceId: 'a', generation: 'old' }, generations[1]!] }),
      authorization({ authorizeCrossSourceEdge: () => false })]) {
      const result = buildBoundedGraph(graph(), {}, context);
      expect(result.snapshot.edges).toHaveLength(0);
      expect(result.snapshot.coverage).toBe('partial');
    }
  });
  it('gives both Host ports the exact relation kind and endpoints that will be published', () => {
    const context = authorization({ authorizeCrossSourceEdge: (request) => request.kind === 'parent',
      verifyEvidence: vi.fn((binding) => binding.kind === 'parent') });
    expect(buildBoundedGraph(graph(), {}, context).snapshot.edges).toHaveLength(1);
    expect(context.verifyEvidence).toHaveBeenCalledWith(expect.objectContaining({ from: a, to: b,
      kind: 'parent', rawKind: 'parent', provenance: 'observed' }));
    expect(buildBoundedGraph(graph({ kind: 'calls' }), {}, context).snapshot.edges).toHaveLength(0);
    const evidenceOnly = authorization({ verifyEvidence: (binding) => binding.kind === 'parent' });
    expect(buildBoundedGraph(graph({ kind: 'calls' }), {}, evidenceOnly).snapshot.edges).toHaveLength(0);
  });
  it('binds accepted evidence and its verification to the edge owner source and current generation', () => {
    const context = authorization();
    const result = buildBoundedGraph(graph(), {}, context);
    expect(result.snapshot.edges).toHaveLength(1);
    expect(context.authorizeCrossSourceEdge).toHaveBeenCalledWith(expect.objectContaining({ edgeRef, from: a, to: b }));
    expect(context.verifyEvidence).toHaveBeenCalledWith(expect.objectContaining({ edgeRef,
      source: { sourceId: 'a', generation: 'ga' }, recordRef, paths }));
    expect(result.snapshot.edges[0]).toMatchObject({ qualifiedRef: edgeRef,
      evidenceSource: { sourceId: 'a', generation: 'ga' }, evidenceRef: recordRef });
  });
  it('rejects absent, stale or unbound source generations before authorization', () => {
    for (const edge of [{ sourceGeneration: undefined }, { sourceGeneration: 'gb' }, { sourceGeneration: 'old' },
      { ref: { sourceId: 'unknown', nativeId: 'edge' }, sourceGeneration: 'g' }]) {
      const context = authorization();
      expect(buildBoundedGraph(graph(edge as Partial<GraphEdgeInput>), {}, context).snapshot.edges).toHaveLength(0);
      expect(context.authorizeCrossSourceEdge).not.toHaveBeenCalled();
    }
    const single = graph({ to: a, sourceGeneration: 'old' });
    expect(buildBoundedGraph(single).snapshot.edges).toHaveLength(0);
  });
  it('requires valid nonempty evidence for observed, inferred and user cross-source edges', () => {
    for (const provenance of ['observed', 'inferred', 'user'] as const) {
      for (const evidencePaths of [undefined, [], [{ tokens: [], canonical: 'root' }],
        [{ tokens: [{ kind: 'index' as const, value: -1 }], canonical: '[-1]' }]]) {
        const context = authorization();
        expect(buildBoundedGraph(graph({ provenance, evidencePaths } as Partial<GraphEdgeInput>), {}, context).snapshot.edges).toHaveLength(0);
        expect(context.verifyEvidence).not.toHaveBeenCalled();
      }
    }
    expect(buildBoundedGraph(graph(), {}, authorization({ verifyEvidence: () => false })).snapshot.edges).toHaveLength(0);
  });
  it('requires evidence coordinates bound to the owner and rejects malformed record references before host callbacks', () => {
    for (const evidenceRef of [undefined, { ...recordRef, generation: 'gb' }, { ...recordRef, byteStart: '00' },
      { ...recordRef, byteEndExclusive: '3' }, { ...recordRef, ordinal: '1'.repeat(65) }, { ...recordRef, delimiterByteLength: 3 }]) {
      const context = authorization();
      expect(buildBoundedGraph(graph({ evidenceRef } as Partial<GraphEdgeInput>), {}, context).snapshot.edges).toHaveLength(0);
      expect(context.authorizeCrossSourceEdge).not.toHaveBeenCalled();
    }
  });
  it('charges authorization normalization and callbacks to the same deterministic work cap', () => {
    const context = authorization();
    const result = buildBoundedGraph(graph(), { maxWorkUnits: 8 }, context);
    expect(result.workUnits).toBe(8);
    expect(result.snapshot.edges).toHaveLength(0);
    expect(result.snapshot.coverage).toBe('partial');
    expect(context.verifyEvidence).not.toHaveBeenCalled();
    expect(result.diagnostics.map((item) => item.code)).toContain('work-limit');
  });
  it('contains thrown host verifier errors and rejects malformed or ambiguous grant scopes', () => {
    const context = authorization({ verifyEvidence: () => { throw new Error('private source path'); } });
    const result = buildBoundedGraph(graph(), {}, context);
    expect(result.snapshot.edges).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('private source path');
    expect(buildBoundedGraph(graph(), {}, authorization({ authorizedSources: [...generations, generations[0]!] })).snapshot.edges).toHaveLength(0);
    expect(buildBoundedGraph({ ...graph(), sourceGenerations: [...generations, generations[0]!] }, {}, authorization()).snapshot.edges).toHaveLength(0);
  });
});

describe('graph projection kinds and snapshot identity', () => {
  it('keeps projection enums separate from bounded raw provider kinds', () => {
    const initial = graph({ kind: 'provider.custom' as never, rawKind: 'provider.custom' });
    const input = { ...initial, nodes: [{ ...initial.nodes[0]!, kind: 'provider.entity' as never, rawKind: 'provider.entity' }, initial.nodes[1]!] };
    const result = buildBoundedGraph(input, {}, authorization());
    expect(result.snapshot.nodes[0]).toMatchObject({ kind: 'unknown', rawKind: 'provider.entity' });
    expect(result.snapshot.nodes[1]).toMatchObject({ kind: 'session', rawKind: 'provider.session' });
    expect(result.snapshot.edges[0]).toMatchObject({ kind: 'unknown', rawKind: 'provider.custom' });
    expect(result.snapshot).toMatchObject({ snapshotRevision: '2', profileVersion: 'profile-v1' });
  });
  it('keeps host physical references only when structurally bound to the node current source; metadata never invents a locator', () => {
    const initial = graph();
    const input = { ...initial, nodes: [{ ...initial.nodes[0]!, recordRef }, initial.nodes[1]!] };
    expect(buildBoundedGraph(input, {}, authorization()).snapshot.nodes[0]?.recordRef).toEqual(recordRef);
    expect(buildBoundedGraph(initial, {}, authorization()).snapshot.nodes[0]).not.toHaveProperty('recordRef');
    const stale = { ...input, nodes: [{ ...input.nodes[0]!, recordRef: { ...recordRef, generation: 'old' } }, input.nodes[1]!] };
    expect(buildBoundedGraph(stale, {}, authorization()).snapshot.nodes).toHaveLength(1);
  });
  it('rejects unbounded/control raw kinds and incomplete snapshot identities', () => {
    expect(buildBoundedGraph(graph({ rawKind: 'x'.repeat(129) }), {}, authorization()).snapshot.edges).toHaveLength(0);
    expect(buildBoundedGraph(graph({ rawKind: 'kind\u0001' }), {}, authorization()).snapshot.edges).toHaveLength(0);
    expect(() => buildBoundedGraph({ ...graph(), profileVersion: '' })).toThrow();
    expect(() => buildBoundedGraph({ ...graph(), snapshotRevision: '02' })).toThrow();
  });
  it('compares the complete source-generation set, snapshot revision and profile for late layouts', () => {
    const current: GraphLayoutIdentity = { graphGeneration: '1', snapshotRevision: '2', profileVersion: 'v1',
      sourceGenerations: generations, layoutGeneration: 1, requestId: 'layout-1', viewport: { width: 600, height: 400 } };
    expect(isGraphLayoutCurrent(current, current)).toBe(true);
    expect(isGraphLayoutCurrent({ ...current, sourceGenerations: [...generations].reverse() }, current)).toBe(true);
    for (const changed of [{ snapshotRevision: '1' }, { profileVersion: 'v2' }, { sourceGenerations: [generations[0]!] },
      { sourceGenerations: [{ sourceId: 'a', generation: 'old' }, generations[1]!] },
      { sourceGenerations: [...generations, generations[0]!] }]) {
      expect(isGraphLayoutCurrent({ ...current, ...changed }, current)).toBe(false);
    }
    expect(isGraphLayoutCurrent({ ...current, sourceGenerations: undefined } as never, current)).toBe(false);
  });
});
