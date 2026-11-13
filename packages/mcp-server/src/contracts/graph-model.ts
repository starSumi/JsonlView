import { createGraphAuthorizationGate, type GraphAuthorizationContext, type GraphCrossSourceEdgeRequest } from './graph-authorization.js';
import { copyGraphRecordRef } from './graph-record-ref.js';
import type { RecordRef } from './types.js';
export type { GraphAuthorizationContext, GraphCrossSourceEdgeRequest, GraphEvidenceBinding } from './graph-authorization.js';

/** Pure, bounded application model for the frozen JsonlView Graph v2 shape. */
export const GRAPH_V2_SCHEMA = 'jsonlview.graph.v2' as const;
export const GRAPH_V2_VERSION = 2 as const;

export const GRAPH_MAX_NODES = 1_000;
export const GRAPH_MAX_EDGES = 3_000;
export const GRAPH_MAX_DEGREE = 64;
export const GRAPH_MAX_DEPTH = 128;
/** Deterministic work units bound parsing, adjacency construction, and cycle analysis. */
export const GRAPH_MAX_WORK_UNITS = 10_000;
export const GRAPH_MAX_DIAGNOSTICS = 256;
export const GRAPH_MAX_SOURCE_GENERATIONS = 128;
export const GRAPH_MAX_SOURCE_ID_LENGTH = 256;
export const GRAPH_MAX_NATIVE_ID_LENGTH = 256;
export const GRAPH_MAX_PROVIDER_ID_LENGTH = 256;
export const GRAPH_MAX_GENERATION_LENGTH = 256;
export const GRAPH_MAX_REVISION_LENGTH = 256;
export const GRAPH_MAX_QUALIFIED_ID_BYTES = 256;
export const GRAPH_MAX_LABEL_LENGTH = 512;
export const GRAPH_MAX_KIND_LENGTH = 128;
export const GRAPH_MAX_EVIDENCE_PATHS = 8;
export const GRAPH_MAX_EVIDENCE_PATH_TOKENS = 32;
export const GRAPH_MAX_EVIDENCE_PATH_KEY_LENGTH = 256;
export const GRAPH_MAX_EVIDENCE_PATH_CANONICAL_LENGTH = 2_048;
export const GRAPH_MAX_REQUEST_ID_LENGTH = 128;
export const GRAPH_MAX_VIEWPORT_EXTENT = 1_000_000;

export interface GraphQualifiedReference {
  readonly providerId?: string;
  readonly sourceId: string;
  readonly nativeId: string;
}

export interface GraphSourceGeneration {
  readonly sourceId: string;
  readonly generation: string;
}

export type GraphNodeLabelOrigin = 'provider' | 'alias' | 'inferred';
export type GraphNodeStatus = 'available' | 'pending' | 'redacted' | 'missing';
export type GraphEdgeProvenance = 'user' | 'observed' | 'inferred';
export type GraphNodeKind = 'session' | 'subagent' | 'event' | 'tool' | 'unknown';
export type GraphEdgeKind = 'parent' | 'calls' | 'responds' | 'references' | 'unknown';

export interface GraphNodeInput {
  readonly ref: GraphQualifiedReference;
  readonly displayLabel: string;
  readonly labelOrigin: GraphNodeLabelOrigin;
  readonly status: GraphNodeStatus;
  readonly kind?: GraphNodeKind;
  readonly rawKind?: string;
  /** Supplied only by the current Host engine. Missing means no physical reveal locator. */
  readonly recordRef?: RecordRef;
}

export interface GraphEdgeInput {
  readonly ref: GraphQualifiedReference;
  readonly from: GraphQualifiedReference;
  readonly to: GraphQualifiedReference;
  readonly kind: GraphEdgeKind;
  readonly rawKind?: string;
  readonly provenance: GraphEdgeProvenance;
  readonly sourceGeneration?: string;
  readonly evidencePaths?: readonly GraphFieldPathV2[];
  readonly evidenceRef?: RecordRef;
  readonly confidence?: number;
}

export type GraphFieldPathToken =
  | { readonly kind: 'key'; readonly value: string }
  | { readonly kind: 'index'; readonly value: number };

export interface GraphFieldPathV2 {
  readonly tokens: readonly GraphFieldPathToken[];
  readonly canonical: string;
}

export interface GraphNodeV2 {
  readonly nodeId: string;
  readonly qualifiedRef: GraphQualifiedReference;
  readonly displayLabel: string;
  readonly labelOrigin: GraphNodeLabelOrigin;
  readonly status: GraphNodeStatus;
  readonly kind: GraphNodeKind;
  readonly rawKind: string;
  readonly recordRef?: RecordRef;
}

export interface GraphEdgeV2 {
  readonly edgeId: string;
  readonly qualifiedRef: GraphQualifiedReference;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: GraphEdgeKind;
  readonly rawKind: string;
  readonly provenance: GraphEdgeProvenance;
  readonly sourceGeneration?: string;
  readonly evidenceSource?: GraphSourceGeneration;
  readonly evidenceRef?: RecordRef;
  readonly evidencePaths: readonly GraphFieldPathV2[];
  readonly confidence?: number;
}

export interface GraphSnapshotV2 {
  readonly schema: typeof GRAPH_V2_SCHEMA;
  readonly version: typeof GRAPH_V2_VERSION;
  readonly graphGeneration: string;
  readonly snapshotRevision: string;
  readonly profileVersion: string;
  readonly sourceGenerations: readonly GraphSourceGeneration[];
  readonly nodes: readonly GraphNodeV2[];
  readonly edges: readonly GraphEdgeV2[];
  readonly coverage: 'complete' | 'partial';
}

export type GraphDiagnosticCode =
  | 'invalid-source-generation'
  | 'duplicate-source-generation'
  | 'missing-source-generation'
  | 'stale-edge-generation'
  | 'unauthorized-cross-source-edge'
  | 'missing-edge-evidence'
  | 'source-generation-limit'
  | 'invalid-node'
  | 'duplicate-node'
  | 'label-truncated'
  | 'node-limit'
  | 'invalid-edge'
  | 'duplicate-edge'
  | 'missing-endpoint'
  | 'degree-limit'
  | 'edge-limit'
  | 'depth-limit'
  | 'cycle'
  | 'work-limit';

export interface GraphDiagnostic {
  readonly code: GraphDiagnosticCode;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly relatedNodeId?: string;
  readonly sourceId?: string;
}

export interface GraphBuildResult {
  readonly snapshot: GraphSnapshotV2;
  readonly diagnostics: readonly GraphDiagnostic[];
  readonly suppressedDiagnostics: number;
  readonly workUnits: number;
  /** False means the bounded cycle pass stopped before proving acyclicity/cycles. */
  readonly analysisComplete: boolean;
}

export interface GraphModelLimits {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxDegree?: number;
  readonly maxDepth?: number;
  readonly maxWorkUnits?: number;
  readonly maxDiagnostics?: number;
}

export interface GraphBuildInput {
  readonly graphGeneration: string;
  readonly snapshotRevision: string;
  readonly profileVersion: string;
  readonly sourceGenerations: readonly GraphSourceGeneration[];
  readonly nodes: readonly GraphNodeInput[];
  readonly edges: readonly GraphEdgeInput[];
}

/**
 * Encodes tuple components with explicit lengths so separators and hostile
 * object-property names cannot collide. The result is opaque and Map-safe.
 */
export function graphNodeId(ref: GraphQualifiedReference): string {
  return qualifyReference('node', ref);
}

/** Stable source-qualified identity for a multigraph edge. */
export function graphEdgeId(ref: GraphQualifiedReference): string {
  return qualifyReference('edge', ref);
}

function qualifyReference(kind: 'node' | 'edge', ref: GraphQualifiedReference): string {
  if (!isRecord(ref) || !boundedNonEmpty(ref.sourceId, GRAPH_MAX_SOURCE_ID_LENGTH)
    || !boundedNonEmpty(ref.nativeId, GRAPH_MAX_NATIVE_ID_LENGTH)
    || (ref.providerId !== undefined && !boundedNonEmpty(ref.providerId, GRAPH_MAX_PROVIDER_ID_LENGTH))) {
    throw new TypeError('Graph references require bounded opaque source and native IDs.');
  }
  const provider = ref.providerId === undefined ? '-' : `${ref.providerId.length}:${ref.providerId}`;
  const id = `${kind}:v2:${provider}|${ref.sourceId.length}:${ref.sourceId}|${ref.nativeId.length}:${ref.nativeId}`;
  if (utf8ByteLength(id) > GRAPH_MAX_QUALIFIED_ID_BYTES) {
    throw new TypeError('Source-qualified graph IDs must fit the renderer ID byte limit.');
  }
  return id;
}

/**
 * Builds a stable, bounded snapshot. Limits supplied by callers may tighten
 * the hard caps but cannot raise them. Duplicate node/edge identities keep the
 * first row; distinct edge IDs preserve parallel relationships.
 */
export function buildBoundedGraph(input: GraphBuildInput, limits: GraphModelLimits = {}, authorization?: GraphAuthorizationContext): GraphBuildResult {
  if (!isRecord(input) || !isRevision(input.graphGeneration) || !isRevision(input.snapshotRevision)
    || !boundedNonEmpty(input.profileVersion, GRAPH_MAX_REVISION_LENGTH)
    || !Array.isArray(input.sourceGenerations) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new TypeError('Graph input must contain a bounded generation and dense graph lists.');
  }
  const budget = normalizeLimits(limits);
  let workUnits = 0;
  let workExhausted = false;
  let partial = false;
  let analysisComplete = true;
  let suppressedDiagnostics = 0;
  const diagnostics: GraphDiagnostic[] = [];
  const addDiagnostic = (diagnostic: GraphDiagnostic): void => {
    if (diagnostics.length >= budget.maxDiagnostics) {
      suppressedDiagnostics += 1;
      return;
    }
    diagnostics.push(Object.freeze(diagnostic));
  };
  const consumeWork = (): boolean => {
    if (workUnits >= budget.maxWorkUnits) {
      workExhausted = true;
      return false;
    }
    workUnits += 1;
    return true;
  };
  const authorizeCrossSource = createGraphAuthorizationGate(authorization, consumeWork,
    GRAPH_MAX_SOURCE_GENERATIONS, GRAPH_MAX_SOURCE_ID_LENGTH, GRAPH_MAX_GENERATION_LENGTH);

  const sourceGenerations: GraphSourceGeneration[] = [];
  const seenSources = new Set<string>();
  const generationBySource = new Map<string, string>();
  for (let index = 0; index < input.sourceGenerations.length; index += 1) {
    if (!consumeWork()) break;
    const source: unknown = input.sourceGenerations[index];
    if (!isRecord(source) || !boundedNonEmpty(source.sourceId, GRAPH_MAX_SOURCE_ID_LENGTH)
      || !boundedNonEmpty(source.generation, GRAPH_MAX_GENERATION_LENGTH)) {
      addDiagnostic({ code: 'invalid-source-generation' });
      partial = true;
      continue;
    }
    if (seenSources.has(source.sourceId)) {
      addDiagnostic({ code: 'duplicate-source-generation', sourceId: source.sourceId });
      // Retain the first display row, but an ambiguous source cannot bind a physical ref or edge.
      generationBySource.delete(source.sourceId);
      partial = true;
      continue;
    }
    if (sourceGenerations.length >= GRAPH_MAX_SOURCE_GENERATIONS) {
      addDiagnostic({ code: 'source-generation-limit' });
      partial = true;
      break;
    }
    seenSources.add(source.sourceId);
    generationBySource.set(source.sourceId, source.generation);
    sourceGenerations.push(Object.freeze({ sourceId: source.sourceId, generation: source.generation }));
  }
  if (input.sourceGenerations.length > sourceGenerations.length && workExhausted) {
    addDiagnostic({ code: 'work-limit' });
    partial = true;
  } else if (input.sourceGenerations.length > GRAPH_MAX_SOURCE_GENERATIONS) {
    partial = true;
  }

  const nodes: GraphNodeV2[] = [];
  const nodesById = new Map<string, GraphNodeV2>();
  let nodeRowsProcessed = 0;
  for (let index = 0; index < input.nodes.length; index += 1) {
    if (nodeRowsProcessed >= budget.maxNodes) {
      addDiagnostic({ code: 'node-limit' });
      partial = true;
      break;
    }
    if (!consumeWork()) break;
    nodeRowsProcessed += 1;
    const candidate: unknown = input.nodes[index];
    if (!isRecord(candidate) || !isGraphNodeLabelOrigin(candidate.labelOrigin)
      || !isGraphNodeStatus(candidate.status) || typeof candidate.displayLabel !== 'string'
      || (candidate.kind !== undefined && !isSafeRawKind(candidate.kind))
      || (candidate.rawKind !== undefined && !isSafeRawKind(candidate.rawKind))) {
      addDiagnostic({ code: 'invalid-node' });
      partial = true;
      continue;
    }
    let nodeId: string;
    try {
      nodeId = graphNodeId(candidate.ref as GraphQualifiedReference);
    } catch {
      addDiagnostic({ code: 'invalid-node' });
      partial = true;
      continue;
    }
    if (nodesById.has(nodeId)) {
      addDiagnostic({ code: 'duplicate-node', nodeId });
      partial = true;
      continue;
    }
    const nodeRef = candidate.ref as GraphQualifiedReference;
    const recordRef = copyGraphRecordRef(candidate.recordRef, generationBySource.get(nodeRef.sourceId));
    if (candidate.recordRef !== undefined && recordRef === undefined) {
      addDiagnostic({ code: 'invalid-node', nodeId });
      partial = true;
      continue;
    }
    if (!seenSources.has(nodeRef.sourceId)) {
      addDiagnostic({ code: 'missing-source-generation', nodeId, sourceId: nodeRef.sourceId });
      partial = true;
    }
    if (candidate.displayLabel.length > GRAPH_MAX_LABEL_LENGTH) {
      addDiagnostic({ code: 'label-truncated', nodeId });
      partial = true;
    }
    const displayLabel = candidate.displayLabel.slice(0, GRAPH_MAX_LABEL_LENGTH);
    const node = Object.freeze({
      nodeId,
      qualifiedRef: Object.freeze(copyReference(nodeRef)),
      displayLabel,
      labelOrigin: candidate.labelOrigin,
      status: candidate.status,
      kind: projectNodeKind(candidate.kind),
      rawKind: (candidate.rawKind ?? candidate.kind ?? 'unknown') as string,
      ...(recordRef === undefined ? {} : { recordRef }),
    });
    nodes.push(node);
    nodesById.set(nodeId, node);
  }
  if (nodeRowsProcessed < input.nodes.length && !workExhausted && nodes.length < budget.maxNodes) {
    partial = true;
  }
  if (workExhausted && nodeRowsProcessed < input.nodes.length) {
    addDiagnostic({ code: 'work-limit' });
    partial = true;
  }

  const edges: GraphEdgeV2[] = [];
  const edgesById = new Map<string, GraphEdgeV2>();
  const incidentDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node.nodeId, []);
  let edgeRowsProcessed = 0;
  for (let index = 0; index < input.edges.length; index += 1) {
    if (edgeRowsProcessed >= budget.maxEdges) {
      addDiagnostic({ code: 'edge-limit' });
      partial = true;
      break;
    }
    if (!consumeWork()) break;
    edgeRowsProcessed += 1;
    const candidate: unknown = input.edges[index];
    if (!isRecord(candidate) || !isSafeRawKind(candidate.kind)
      || (candidate.rawKind !== undefined && !isSafeRawKind(candidate.rawKind))
      || !isGraphEdgeProvenance(candidate.provenance)
      || (candidate.sourceGeneration !== undefined && !boundedNonEmpty(candidate.sourceGeneration, GRAPH_MAX_GENERATION_LENGTH))
      || (candidate.confidence !== undefined && !isGraphConfidence(candidate.confidence))) {
      addDiagnostic({ code: 'invalid-edge' });
      partial = true;
      continue;
    }
    let edgeId: string;
    let fromNodeId: string;
    let toNodeId: string;
    try {
      edgeId = graphEdgeId(candidate.ref as GraphQualifiedReference);
      fromNodeId = graphNodeId(candidate.from as GraphQualifiedReference);
      toNodeId = graphNodeId(candidate.to as GraphQualifiedReference);
    } catch {
      addDiagnostic({ code: 'invalid-edge' });
      partial = true;
      continue;
    }
    if (edgesById.has(edgeId)) {
      addDiagnostic({ code: 'duplicate-edge', edgeId });
      partial = true;
      continue;
    }
    if (!nodesById.has(fromNodeId) || !nodesById.has(toNodeId)) {
      addDiagnostic({ code: 'missing-endpoint', edgeId, ...(!nodesById.has(fromNodeId) ? { relatedNodeId: fromNodeId } : { relatedNodeId: toNodeId }) });
      partial = true;
      continue;
    }
    const edgeRef = candidate.ref as GraphQualifiedReference;
    const fromRef = candidate.from as GraphQualifiedReference;
    const toRef = candidate.to as GraphQualifiedReference;
    const ownerGeneration = generationBySource.get(edgeRef.sourceId);
    const crossSource = fromRef.sourceId !== toRef.sourceId || edgeRef.sourceId !== fromRef.sourceId;
    if (candidate.sourceGeneration !== undefined && (ownerGeneration === undefined || candidate.sourceGeneration !== ownerGeneration)) {
      addDiagnostic({ code: 'stale-edge-generation', edgeId });
      partial = true;
      continue;
    }
    if (crossSource && (candidate.sourceGeneration === undefined || ownerGeneration === undefined
      || !generationBySource.has(fromRef.sourceId) || !generationBySource.has(toRef.sourceId))) {
      addDiagnostic({ code: 'missing-source-generation', edgeId });
      partial = true;
      continue;
    }
    const fromDegree = incidentDegree.get(fromNodeId) ?? 0;
    const toDegree = incidentDegree.get(toNodeId) ?? 0;
    // Degree is total undirected incidence for conservative rendering; a
    // self-loop therefore consumes two slots.
    const fromIncrement = fromNodeId === toNodeId ? 2 : 1;
    if (fromDegree + fromIncrement > budget.maxDegree
      || (fromNodeId !== toNodeId && toDegree + 1 > budget.maxDegree)) {
      addDiagnostic({ code: 'degree-limit', edgeId });
      partial = true;
      continue;
    }
    const copiedEvidence = copyEvidencePaths(candidate.evidencePaths, addDiagnostic, edgeId, consumeWork);
    if (copiedEvidence.workExhausted) {
      addDiagnostic({ code: 'work-limit' });
      partial = true;
      break;
    }
    if (copiedEvidence.invalid) partial = true;
    const evidenceSource = candidate.sourceGeneration === undefined ? undefined
      : Object.freeze({ sourceId: edgeRef.sourceId, generation: candidate.sourceGeneration });
    const evidenceRef = copyGraphRecordRef(candidate.evidenceRef, evidenceSource?.generation);
    if (candidate.evidenceRef !== undefined && evidenceRef === undefined) {
      addDiagnostic({ code: 'missing-edge-evidence', edgeId });
      partial = true;
      continue;
    }
    if (crossSource) {
      if (copiedEvidence.invalid || copiedEvidence.paths.length === 0 || evidenceSource === undefined || evidenceRef === undefined) {
        addDiagnostic({ code: 'missing-edge-evidence', edgeId });
        partial = true;
        continue;
      }
      const relation = Object.freeze({ edgeRef: copyReference(edgeRef), from: copyReference(fromRef), to: copyReference(toRef),
        kind: projectEdgeKind(candidate.kind), rawKind: (candidate.rawKind ?? candidate.kind) as string, provenance: candidate.provenance });
      const binding: GraphCrossSourceEdgeRequest = Object.freeze({ ...relation,
        sourceGenerations: Object.freeze([...new Set([edgeRef.sourceId, fromRef.sourceId, toRef.sourceId])]
          .map((sourceId) => Object.freeze({ sourceId, generation: generationBySource.get(sourceId)! }))),
        evidence: Object.freeze({ ...relation, source: evidenceSource, recordRef: evidenceRef, paths: copiedEvidence.paths }) });
      if (!authorizeCrossSource(binding)) {
        addDiagnostic({ code: workExhausted ? 'work-limit' : 'unauthorized-cross-source-edge', edgeId });
        partial = true;
        if (workExhausted) break;
        continue;
      }
    }
    const edge: GraphEdgeV2 = Object.freeze({
      edgeId,
      qualifiedRef: copyReference(edgeRef),
      fromNodeId,
      toNodeId,
      kind: projectEdgeKind(candidate.kind),
      rawKind: (candidate.rawKind ?? candidate.kind) as string,
      provenance: candidate.provenance,
      ...(candidate.sourceGeneration === undefined ? {} : { sourceGeneration: candidate.sourceGeneration }),
      ...(evidenceSource === undefined ? {} : { evidenceSource }),
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
      evidencePaths: copiedEvidence.paths,
      ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
    });
    edges.push(edge);
    edgesById.set(edgeId, edge);
    incidentDegree.set(fromNodeId, fromDegree + fromIncrement);
    if (fromNodeId !== toNodeId) incidentDegree.set(toNodeId, toDegree + 1);
    adjacency.get(fromNodeId)?.push(toNodeId);
  }
  if (workExhausted && edgeRowsProcessed < input.edges.length) {
    addDiagnostic({ code: 'work-limit' });
    partial = true;
  }

  if (!workExhausted) {
    const cyclePass = detectCycles(nodes, adjacency, budget, consumeWork, addDiagnostic);
    analysisComplete = cyclePass.complete;
    if (!cyclePass.complete && cyclePass.workExhausted) {
      addDiagnostic({ code: 'work-limit' });
    }
  } else {
    analysisComplete = false;
  }
  const snapshot: GraphSnapshotV2 = Object.freeze({
    schema: GRAPH_V2_SCHEMA,
    version: GRAPH_V2_VERSION,
    graphGeneration: input.graphGeneration,
    snapshotRevision: input.snapshotRevision,
    profileVersion: input.profileVersion,
    sourceGenerations: Object.freeze(sourceGenerations),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    coverage: partial ? 'partial' : 'complete',
  });
  return Object.freeze({
    snapshot,
    diagnostics: Object.freeze(diagnostics),
    suppressedDiagnostics,
    workUnits,
    analysisComplete,
  });
}

interface NormalizedLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxDegree: number;
  readonly maxDepth: number;
  readonly maxWorkUnits: number;
  readonly maxDiagnostics: number;
}

function normalizeLimits(limits: GraphModelLimits): NormalizedLimits {
  return {
    maxNodes: clampLimit(limits.maxNodes, GRAPH_MAX_NODES),
    maxEdges: clampLimit(limits.maxEdges, GRAPH_MAX_EDGES),
    maxDegree: clampLimit(limits.maxDegree, GRAPH_MAX_DEGREE),
    maxDepth: clampLimit(limits.maxDepth, GRAPH_MAX_DEPTH),
    maxWorkUnits: clampLimit(limits.maxWorkUnits, GRAPH_MAX_WORK_UNITS),
    maxDiagnostics: clampLimit(limits.maxDiagnostics, GRAPH_MAX_DIAGNOSTICS),
  };
}

function clampLimit(value: number | undefined, hardLimit: number): number {
  if (value === undefined) return hardLimit;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Graph limits must be positive safe integers.');
  return Math.min(value, hardLimit);
}

function copyReference(ref: GraphQualifiedReference): GraphQualifiedReference {
  return Object.freeze({
    ...(ref.providerId === undefined ? {} : { providerId: ref.providerId }),
    sourceId: ref.sourceId,
    nativeId: ref.nativeId,
  });
}

function copyEvidencePaths(
  value: unknown,
  addDiagnostic: (diagnostic: GraphDiagnostic) => void,
  edgeId: string,
  consumeWork: () => boolean,
): { readonly paths: readonly GraphFieldPathV2[]; readonly workExhausted: boolean; readonly invalid: boolean } {
  if (value === undefined) return { paths: Object.freeze([]), workExhausted: false, invalid: false };
  if (!Array.isArray(value)) {
    addDiagnostic({ code: 'invalid-edge', edgeId });
    return { paths: Object.freeze([]), workExhausted: false, invalid: true };
  }
  const result: GraphFieldPathV2[] = [];
  const count = Math.min(value.length, GRAPH_MAX_EVIDENCE_PATHS);
  let invalid = value.length > GRAPH_MAX_EVIDENCE_PATHS;
  for (let index = 0; index < count; index += 1) {
    if (!consumeWork()) return { paths: Object.freeze(result), workExhausted: true, invalid: true };
    const path: unknown = value[index];
    if (!Object.hasOwn(value, index) || !isRecord(path) || !Array.isArray(path.tokens)
      || !boundedNonEmpty(path.canonical, GRAPH_MAX_EVIDENCE_PATH_CANONICAL_LENGTH)
      || path.tokens.length === 0 || path.tokens.length > GRAPH_MAX_EVIDENCE_PATH_TOKENS) {
      addDiagnostic({ code: 'invalid-edge', edgeId });
      invalid = true;
      continue;
    }
    const tokens: GraphFieldPathToken[] = [];
    let valid = true;
    for (let tokenIndex = 0; tokenIndex < path.tokens.length; tokenIndex += 1) {
      if (!consumeWork()) return { paths: Object.freeze(result), workExhausted: true, invalid: true };
      const token: unknown = path.tokens[tokenIndex];
      if (!Object.hasOwn(path.tokens, tokenIndex) || !isRecord(token)) {
        valid = false;
        break;
      }
      if (token.kind === 'key' && typeof token.value === 'string' && token.value.length <= GRAPH_MAX_EVIDENCE_PATH_KEY_LENGTH) {
        tokens.push(Object.freeze({ kind: 'key', value: token.value }));
      } else if (token.kind === 'index' && Number.isSafeInteger(token.value) && (token.value as number) >= 0) {
        tokens.push(Object.freeze({ kind: 'index', value: token.value as number }));
      } else {
        valid = false;
        break;
      }
    }
    if (!valid) {
      addDiagnostic({ code: 'invalid-edge', edgeId });
      invalid = true;
      continue;
    }
    result.push(Object.freeze({ tokens: Object.freeze(tokens), canonical: path.canonical }));
  }
  if (value.length > GRAPH_MAX_EVIDENCE_PATHS) addDiagnostic({ code: 'invalid-edge', edgeId });
  return { paths: Object.freeze(result), workExhausted: false, invalid };
}

interface CyclePassResult {
  readonly complete: boolean;
  readonly workExhausted: boolean;
}

interface DfsFrame {
  readonly nodeId: string;
  readonly neighbors: readonly string[];
  readonly depth: number;
  next: number;
}

function detectCycles(
  nodes: readonly GraphNodeV2[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  limits: NormalizedLimits,
  consumeWork: () => boolean,
  addDiagnostic: (diagnostic: GraphDiagnostic) => void,
): CyclePassResult {
  const color = new Map<string, 1 | 2>();
  let depthLimited = false;
  for (const root of nodes) {
    if (color.has(root.nodeId)) continue;
    if (!consumeWork()) return { complete: false, workExhausted: true };
    color.set(root.nodeId, 1);
    const stack: DfsFrame[] = [{ nodeId: root.nodeId, neighbors: adjacency.get(root.nodeId) ?? [], depth: 1, next: 0 }];
    while (stack.length > 0) {
      if (!consumeWork()) return { complete: false, workExhausted: true };
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      if (frame.next >= frame.neighbors.length) {
        color.set(frame.nodeId, 2);
        stack.pop();
        continue;
      }
      const neighbor = frame.neighbors[frame.next];
      frame.next += 1;
      if (neighbor === undefined) continue;
      const neighborColor = color.get(neighbor);
      if (neighborColor === 1) {
        addDiagnostic({ code: 'cycle', nodeId: frame.nodeId, relatedNodeId: neighbor });
        continue;
      }
      if (neighborColor === 2) continue;
      if (frame.depth >= limits.maxDepth) {
        depthLimited = true;
        addDiagnostic({ code: 'depth-limit', nodeId: frame.nodeId, relatedNodeId: neighbor });
        continue;
      }
      color.set(neighbor, 1);
      stack.push({ nodeId: neighbor, neighbors: adjacency.get(neighbor) ?? [], depth: frame.depth + 1, next: 0 });
    }
  }
  return { complete: !depthLimited, workExhausted: false };
}

export interface GraphViewportSize {
  readonly width: number;
  readonly height: number;
}

/** Identity captured when an asynchronous layout request starts. */
export interface GraphLayoutIdentity {
  readonly graphGeneration: string;
  readonly snapshotRevision: string;
  readonly profileVersion: string;
  readonly sourceGenerations: readonly GraphSourceGeneration[];
  readonly layoutGeneration: number;
  readonly requestId: string;
  readonly viewport: GraphViewportSize;
}

/** Rejects graph results from a replaced source snapshot. */
export function isGraphGenerationCurrent(resultGeneration: unknown, currentGeneration: unknown): boolean {
  return isRevision(resultGeneration)
    && isRevision(currentGeneration)
    && resultGeneration === currentGeneration;
}

/**
 * Rejects late layout results after graph replacement, a newer layout request,
 * request cancellation/replacement, or any viewport resize.
 */
export function isGraphLayoutCurrent(result: GraphLayoutIdentity, current: GraphLayoutIdentity): boolean {
  return validLayoutIdentity(result) && validLayoutIdentity(current)
    && result.graphGeneration === current.graphGeneration
    && result.snapshotRevision === current.snapshotRevision
    && result.profileVersion === current.profileVersion
    && sameSourceGenerations(result.sourceGenerations, current.sourceGenerations)
    && result.layoutGeneration === current.layoutGeneration
    && result.requestId === current.requestId
    && result.viewport.width === current.viewport.width
    && result.viewport.height === current.viewport.height;
}

function validLayoutIdentity(value: GraphLayoutIdentity): boolean {
  return isRecord(value)
    && isRevision(value.graphGeneration)
    && isRevision(value.snapshotRevision)
    && boundedNonEmpty(value.profileVersion, GRAPH_MAX_REVISION_LENGTH)
    && validSourceGenerations(value.sourceGenerations)
    && Number.isSafeInteger(value.layoutGeneration) && value.layoutGeneration >= 0
    && boundedNonEmpty(value.requestId, GRAPH_MAX_REQUEST_ID_LENGTH)
    && isRecord(value.viewport)
    && validViewportExtent(value.viewport.width) && validViewportExtent(value.viewport.height);
}

function validSourceGenerations(value: unknown): value is readonly GraphSourceGeneration[] {
  if (!Array.isArray(value) || value.length > GRAPH_MAX_SOURCE_GENERATIONS) return false;
  const seen = new Set<string>();
  for (const source of value) {
    if (!isRecord(source) || !boundedNonEmpty(source.sourceId, GRAPH_MAX_SOURCE_ID_LENGTH)
      || !boundedNonEmpty(source.generation, GRAPH_MAX_GENERATION_LENGTH) || seen.has(source.sourceId)) return false;
    seen.add(source.sourceId);
  }
  return true;
}

function sameSourceGenerations(left: readonly GraphSourceGeneration[], right: readonly GraphSourceGeneration[]): boolean {
  if (left.length !== right.length) return false;
  const sources = new Map(left.map((source) => [source.sourceId, source.generation]));
  return right.every((source) => sources.get(source.sourceId) === source.generation);
}

function isSafeRawKind(value: unknown): value is string {
  return boundedNonEmpty(value, GRAPH_MAX_KIND_LENGTH) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function projectNodeKind(value: unknown): GraphNodeKind {
  return value === 'session' || value === 'subagent' || value === 'event' || value === 'tool' ? value : 'unknown';
}

function projectEdgeKind(value: unknown): GraphEdgeKind {
  return value === 'parent' || value === 'calls' || value === 'responds' || value === 'references' ? value : 'unknown';
}

function validViewportExtent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= GRAPH_MAX_VIEWPORT_EXTENT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedNonEmpty(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && utf8ByteLength(value) <= maxLength && !value.includes('\0');
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= GRAPH_MAX_REVISION_LENGTH && /^(?:0|[1-9]\d*)$/u.test(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isGraphNodeLabelOrigin(value: unknown): value is GraphNodeLabelOrigin {
  return value === 'provider' || value === 'alias' || value === 'inferred';
}

function isGraphNodeStatus(value: unknown): value is GraphNodeStatus {
  return value === 'available' || value === 'pending' || value === 'redacted' || value === 'missing';
}

function isGraphEdgeProvenance(value: unknown): value is GraphEdgeProvenance {
  return value === 'user' || value === 'observed' || value === 'inferred';
}

function isGraphConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
