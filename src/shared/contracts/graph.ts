import type { RecordRef } from './record';

/** Contract version and limits for the serialized Graph v2 projection. */
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

export interface GraphBuildResultLimits {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly maxSourceGenerations?: number;
  readonly requiredSource?: GraphSourceGeneration;
}

/** Stable source-qualified identities are part of the serialized Graph v2 contract. */
export function graphNodeId(ref: GraphQualifiedReference): string {
  return qualifyReference('node', ref);
}

export function graphEdgeId(ref: GraphQualifiedReference): string {
  return qualifyReference('edge', ref);
}

/** Stateless bounded guard for Graph v2 wire results. */
export function isGraphBuildResult(value: unknown, limits: GraphBuildResultLimits = {}): value is GraphBuildResult {
  const maxNodes = boundedLimit(limits.maxNodes, GRAPH_MAX_NODES);
  const maxEdges = boundedLimit(limits.maxEdges, GRAPH_MAX_EDGES);
  const maxSources = boundedLimit(limits.maxSourceGenerations, GRAPH_MAX_SOURCE_GENERATIONS);
  if (maxNodes === undefined || maxEdges === undefined || maxSources === undefined
    || !isRecord(value) || !hasExactKeys(value, ['snapshot', 'diagnostics', 'suppressedDiagnostics', 'workUnits', 'analysisComplete'])
    || !isCount(value.suppressedDiagnostics, Number.MAX_SAFE_INTEGER)
    || !isCount(value.workUnits, GRAPH_MAX_WORK_UNITS) || typeof value.analysisComplete !== 'boolean'
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > GRAPH_MAX_DIAGNOSTICS
    || !everyDense(value.diagnostics, isGraphDiagnostic) || !isRecord(value.snapshot)) return false;

  const snapshot = value.snapshot;
  if (!hasExactKeys(snapshot, ['schema', 'version', 'graphGeneration', 'snapshotRevision', 'profileVersion',
    'sourceGenerations', 'nodes', 'edges', 'coverage'])
    || snapshot.schema !== GRAPH_V2_SCHEMA || snapshot.version !== GRAPH_V2_VERSION
    || !isRevision(snapshot.graphGeneration) || !isRevision(snapshot.snapshotRevision)
    || !isBoundedText(snapshot.profileVersion, GRAPH_MAX_REVISION_LENGTH)
    || (snapshot.coverage !== 'complete' && snapshot.coverage !== 'partial')
    || !Array.isArray(snapshot.sourceGenerations) || snapshot.sourceGenerations.length > maxSources
    || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > maxNodes
    || !Array.isArray(snapshot.edges) || snapshot.edges.length > maxEdges) return false;

  const generations = new Map<string, string>();
  for (const source of snapshot.sourceGenerations) {
    if (!isRecord(source) || !hasExactKeys(source, ['sourceId', 'generation'])
      || !isBoundedText(source.sourceId, GRAPH_MAX_SOURCE_ID_LENGTH)
      || !isBoundedText(source.generation, GRAPH_MAX_GENERATION_LENGTH)
      || generations.has(source.sourceId)) return false;
    generations.set(source.sourceId, source.generation);
  }
  const required = limits.requiredSource;
  if (required !== undefined && (generations.size !== 1 || generations.get(required.sourceId) !== required.generation)) return false;

  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (!isRecord(node) || !hasExactKeys(node,
      ['nodeId', 'qualifiedRef', 'displayLabel', 'labelOrigin', 'status', 'kind', 'rawKind'], ['recordRef'])
      || !isGraphQualifiedReference(node.qualifiedRef) || !isBoundedText(node.nodeId, GRAPH_MAX_QUALIFIED_ID_BYTES)
      || !matchesIdentity(node.nodeId, graphNodeId, node.qualifiedRef)
      || !isBoundedString(node.displayLabel, GRAPH_MAX_LABEL_LENGTH)
      || !isNodeLabelOrigin(node.labelOrigin) || !isNodeStatus(node.status) || !isNodeKind(node.kind)
      || !isSafeRawKind(node.rawKind) || nodeIds.has(node.nodeId)) return false;
    const generation = generations.get(node.qualifiedRef.sourceId);
    if (generation === undefined || (node.recordRef !== undefined && !isCurrentRecordRef(node.recordRef, generation))) return false;
    nodeIds.add(node.nodeId);
  }

  const edgeIds = new Set<string>();
  const degree = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (!isRecord(edge) || !hasExactKeys(edge,
      ['edgeId', 'qualifiedRef', 'fromNodeId', 'toNodeId', 'kind', 'rawKind', 'provenance', 'evidencePaths'],
      ['sourceGeneration', 'evidenceSource', 'evidenceRef', 'confidence'])
      || !isGraphQualifiedReference(edge.qualifiedRef) || !isBoundedText(edge.edgeId, GRAPH_MAX_QUALIFIED_ID_BYTES)
      || !matchesIdentity(edge.edgeId, graphEdgeId, edge.qualifiedRef)
      || !isBoundedText(edge.fromNodeId, GRAPH_MAX_QUALIFIED_ID_BYTES) || !nodeIds.has(edge.fromNodeId)
      || !isBoundedText(edge.toNodeId, GRAPH_MAX_QUALIFIED_ID_BYTES) || !nodeIds.has(edge.toNodeId)
      || !isEdgeKind(edge.kind) || !isSafeRawKind(edge.rawKind) || !isEdgeProvenance(edge.provenance)
      || edgeIds.has(edge.edgeId) || !Array.isArray(edge.evidencePaths)
      || edge.evidencePaths.length > GRAPH_MAX_EVIDENCE_PATHS || !everyDense(edge.evidencePaths, isGraphFieldPath)
      || (edge.confidence !== undefined && !isConfidence(edge.confidence))) return false;
    const ownerGeneration = generations.get(edge.qualifiedRef.sourceId);
    if (ownerGeneration === undefined || (edge.sourceGeneration !== undefined && edge.sourceGeneration !== ownerGeneration)) return false;
    if (edge.evidenceSource !== undefined) {
      if (!isRecord(edge.evidenceSource) || !hasExactKeys(edge.evidenceSource, ['sourceId', 'generation'])
        || edge.evidenceSource.sourceId !== edge.qualifiedRef.sourceId
        || edge.evidenceSource.generation !== edge.sourceGeneration || edge.sourceGeneration === undefined) return false;
    }
    if (edge.evidenceRef !== undefined
      && (edge.evidenceSource === undefined || typeof edge.evidenceSource.generation !== 'string'
        || !isCurrentRecordRef(edge.evidenceRef, edge.evidenceSource.generation))) return false;
    const fromDegree = (degree.get(edge.fromNodeId) ?? 0) + (edge.fromNodeId === edge.toNodeId ? 2 : 1);
    const toDegree = edge.fromNodeId === edge.toNodeId ? fromDegree : (degree.get(edge.toNodeId) ?? 0) + 1;
    if (fromDegree > GRAPH_MAX_DEGREE || toDegree > GRAPH_MAX_DEGREE) return false;
    degree.set(edge.fromNodeId, fromDegree);
    degree.set(edge.toNodeId, toDegree);
    edgeIds.add(edge.edgeId);
  }
  return true;
}

function qualifyReference(kind: 'node' | 'edge', ref: GraphQualifiedReference): string {
  if (!isGraphQualifiedReference(ref)) throw new TypeError('Graph references require bounded opaque source and native IDs.');
  const provider = ref.providerId === undefined ? '-' : `${ref.providerId.length}:${ref.providerId}`;
  const id = `${kind}:v2:${provider}|${ref.sourceId.length}:${ref.sourceId}|${ref.nativeId.length}:${ref.nativeId}`;
  if (new TextEncoder().encode(id).byteLength > GRAPH_MAX_QUALIFIED_ID_BYTES) {
    throw new TypeError('Source-qualified graph IDs must fit the renderer ID byte limit.');
  }
  return id;
}

function matchesIdentity(value: string, create: (reference: GraphQualifiedReference) => string, reference: GraphQualifiedReference): boolean {
  try { return create(reference) === value; } catch { return false; }
}

function isGraphQualifiedReference(value: unknown): value is GraphQualifiedReference {
  return isRecord(value) && hasExactKeys(value, ['sourceId', 'nativeId'], ['providerId'])
    && isBoundedText(value.sourceId, GRAPH_MAX_SOURCE_ID_LENGTH)
    && isBoundedText(value.nativeId, GRAPH_MAX_NATIVE_ID_LENGTH)
    && (value.providerId === undefined || isBoundedText(value.providerId, GRAPH_MAX_PROVIDER_ID_LENGTH));
}

function isGraphFieldPath(value: unknown): value is GraphFieldPathV2 {
  return isRecord(value) && hasExactKeys(value, ['tokens', 'canonical'])
    && isBoundedText(value.canonical, GRAPH_MAX_EVIDENCE_PATH_CANONICAL_LENGTH)
    && Array.isArray(value.tokens) && value.tokens.length > 0 && value.tokens.length <= GRAPH_MAX_EVIDENCE_PATH_TOKENS
    && everyDense(value.tokens, isGraphFieldPathToken);
}

function isGraphFieldPathToken(value: unknown): value is GraphFieldPathToken {
  return isRecord(value) && hasExactKeys(value, ['kind', 'value'])
    && (value.kind === 'key' ? isBoundedText(value.value, GRAPH_MAX_EVIDENCE_PATH_KEY_LENGTH)
      : value.kind === 'index' && isCount(value.value, Number.MAX_SAFE_INTEGER));
}

function everyDense<T>(value: unknown, predicate: (entry: unknown) => entry is T): value is T[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !predicate(value[index])) return false;
  }
  return true;
}

function isGraphDiagnostic(value: unknown): value is GraphDiagnostic {
  const codes = new Set<GraphDiagnosticCode>([
    'invalid-source-generation', 'duplicate-source-generation', 'missing-source-generation', 'stale-edge-generation',
    'unauthorized-cross-source-edge', 'missing-edge-evidence', 'source-generation-limit', 'invalid-node',
    'duplicate-node', 'label-truncated', 'node-limit', 'invalid-edge', 'duplicate-edge', 'missing-endpoint',
    'degree-limit', 'edge-limit', 'depth-limit', 'cycle', 'work-limit',
  ]);
  return isRecord(value) && hasExactKeys(value, ['code'], ['nodeId', 'edgeId', 'relatedNodeId', 'sourceId'])
    && typeof value.code === 'string' && codes.has(value.code as GraphDiagnosticCode)
    && ['nodeId', 'edgeId', 'relatedNodeId'].every((key) => value[key] === undefined || isBoundedText(value[key], GRAPH_MAX_QUALIFIED_ID_BYTES))
    && (value.sourceId === undefined || isBoundedText(value.sourceId, GRAPH_MAX_SOURCE_ID_LENGTH));
}

function isCurrentRecordRef(value: unknown, generation: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value,
    ['generation', 'ordinal', 'byteStart', 'byteEndExclusive', 'contentByteLength', 'delimiterByteLength', 'parseState'])
    || value.generation !== generation || !isDecimal(value.ordinal) || !isDecimal(value.byteStart)
    || !isDecimal(value.byteEndExclusive) || !isDecimal(value.contentByteLength)
    || (value.delimiterByteLength !== 0 && value.delimiterByteLength !== 1 && value.delimiterByteLength !== 2)
    || !['unknown', 'valid', 'invalid_json', 'blank', 'encoding_error', 'oversized'].includes(String(value.parseState))) return false;
  try { return BigInt(value.byteEndExclusive) - BigInt(value.byteStart) === BigInt(value.contentByteLength); }
  catch { return false; }
}

function isSafeRawKind(value: unknown): value is string {
  return isBoundedText(value, GRAPH_MAX_KIND_LENGTH) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !value.includes('\0') && new TextEncoder().encode(value).byteLength <= maximum;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length <= GRAPH_MAX_REVISION_LENGTH && /^(?:0|[1-9]\d*)$/u.test(value);
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)$/u.test(value);
}

function isCount(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function boundedLimit(value: number | undefined, maximum: number): number | undefined {
  return value === undefined ? maximum : Number.isSafeInteger(value) && value >= 1 ? Math.min(value, maximum) : undefined;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isNodeLabelOrigin(value: unknown): value is GraphNodeLabelOrigin {
  return value === 'provider' || value === 'alias' || value === 'inferred';
}

function isNodeStatus(value: unknown): value is GraphNodeStatus {
  return value === 'available' || value === 'pending' || value === 'redacted' || value === 'missing';
}

function isNodeKind(value: unknown): value is GraphNodeKind {
  return value === 'session' || value === 'subagent' || value === 'event' || value === 'tool' || value === 'unknown';
}

function isEdgeKind(value: unknown): value is GraphEdgeKind {
  return value === 'parent' || value === 'calls' || value === 'responds' || value === 'references' || value === 'unknown';
}

function isEdgeProvenance(value: unknown): value is GraphEdgeProvenance {
  return value === 'user' || value === 'observed' || value === 'inferred';
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
