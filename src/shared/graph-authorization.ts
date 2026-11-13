import type { GraphEdgeKind, GraphEdgeProvenance, GraphFieldPathV2, GraphQualifiedReference, GraphSourceGeneration } from './contracts/graph';
import type { RecordRef } from './types';

interface GraphRelationProjection {
  readonly edgeRef: GraphQualifiedReference;
  readonly from: GraphQualifiedReference;
  readonly to: GraphQualifiedReference;
  readonly kind: GraphEdgeKind;
  readonly rawKind: string;
  readonly provenance: GraphEdgeProvenance;
}

export interface GraphEvidenceBinding extends GraphRelationProjection {
  readonly source: GraphSourceGeneration;
  readonly recordRef: RecordRef;
  readonly paths: readonly GraphFieldPathV2[];
}

export interface GraphCrossSourceEdgeRequest extends GraphRelationProjection {
  readonly sourceGenerations: readonly GraphSourceGeneration[];
  readonly evidence: GraphEvidenceBinding;
}

/**
 * Host-owned port, never parsed from graph input. Callbacks use already-verified
 * current host facts and must be bounded, synchronous and free of source reads.
 * The host must reauthorize again at publication; this is not a persistent grant.
 */
export interface GraphAuthorizationContext {
  readonly authorizedSources: readonly GraphSourceGeneration[];
  authorizeCrossSourceEdge(request: GraphCrossSourceEdgeRequest): boolean;
  verifyEvidence(binding: GraphEvidenceBinding): boolean;
}

/** Lazy normalization is charged once to the builder's deterministic work cap. */
export function createGraphAuthorizationGate(
  context: GraphAuthorizationContext | undefined,
  consumeWork: () => boolean,
  maxSources: number,
  maxSourceLength: number,
  maxGenerationLength: number,
): (request: GraphCrossSourceEdgeRequest) => boolean {
  let grants: ReadonlyMap<string, string> | false | undefined;
  const bounded = (value: unknown, max: number): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= max && !value.includes('\0') && new TextEncoder().encode(value).byteLength <= max;
  const normalize = (): ReadonlyMap<string, string> | false => {
    if (context === undefined || typeof context.authorizeCrossSourceEdge !== 'function'
      || typeof context.verifyEvidence !== 'function' || !Array.isArray(context.authorizedSources)
      || context.authorizedSources.length > maxSources) return false;
    const result = new Map<string, string>();
    for (const source of context.authorizedSources) {
      if (!consumeWork() || source === null || typeof source !== 'object'
        || !bounded(source.sourceId, maxSourceLength) || !bounded(source.generation, maxGenerationLength)
        || result.has(source.sourceId)) return false;
      result.set(source.sourceId, source.generation);
    }
    return result;
  };
  return (request) => {
    try {
      grants ??= normalize();
      if (grants === false || context === undefined || request.evidence.paths.length === 0
        || request.sourceGenerations.some((source) => grants !== false && grants?.get(source.sourceId) !== source.generation)) return false;
      if (!consumeWork() || context.authorizeCrossSourceEdge(request) !== true) return false;
      return consumeWork() && context.verifyEvidence(request.evidence) === true;
    } catch {
      // A trusted integration failure cannot convert into permission or leak its exception.
      return false;
    }
  };
}
