import { buildBoundedGraph, type GraphEdgeInput, type GraphNodeInput, type GraphNodeKind, type GraphQualifiedReference } from '@shared/graph-model';
import { copyGraphRecordRef } from '@shared/graph-record-ref';
import { DOCUMENT_GRAPH_LIMIT } from '@shared/document-graph';
import type { DocumentGraphReply } from '@shared/contracts/document-graph';
import { displayFieldPath, type AgentRowProjection, type DocumentSummary, type FieldPath, type RowPage, type RowProjection } from '@shared/types';

interface ObservedNode { row: RowProjection; ref: GraphQualifiedReference; physical: boolean }

/** A bounded prefix of engine rows, never a provider database or a guessed ID locator. */
export function projectDocumentGraph(summary: DocumentSummary, page: RowPage, graphRevision: string): DocumentGraphReply {
  const generation = summary.snapshot.generation;
  const sourceId = summary.snapshot.documentId;
  const rows = page.rows.slice(0, DOCUMENT_GRAPH_LIMIT);
  const observed: ObservedNode[] = rows.map((row, index) => ({ row,
    ref: { sourceId, nativeId: `physical:${index}:${row.ref.ordinal}`, providerId: row.profile?.profileId ?? summary.profileId },
    physical: copyGraphRecordRef(row.ref, generation) !== undefined,
  }));
  const nodes: GraphNodeInput[] = observed.map(({ row, ref, physical }) => ({ ref,
    displayLabel: (row.profile?.summary ?? row.genericSummary).slice(0, 512) || `Record ${row.ref.ordinal}`,
    labelOrigin: 'provider', status: physical ? 'available' : 'missing', kind: nodeKind(row.profile),
    rawKind: row.profile?.eventKind ?? row.ref.parseState,
    ...(physical ? { recordRef: row.ref } : {}),
  }));
  const edges: GraphEdgeInput[] = [];
  let missingRelations = 0;
  for (const child of observed) {
    const profile = child.row.profile;
    if (profile === undefined || profile.parentId === undefined) continue;
    const parentPath = parentEvidence(profile);
    const parents = observed.filter((candidate) => candidate.row.profile !== undefined && candidate.row.profile.messageId === profile.parentId
      && candidate.row.profile.profileId === profile.profileId && identityEvidence(candidate.row.profile)
      && compatibleContext(candidate.row.profile, profile));
    if (!child.physical || parentPath === undefined || parents.length !== 1 || !parents[0]!.physical) {
      missingRelations += 1; continue;
    }
    edges.push(observedEdge(child, parents[0]!, 'parent', parentPath, generation, edges.length));
  }
  // Pairing is deliberately restricted to Codex call_id projections. Generic
  // aliases and first-tool-only Claude/Pi projections cannot prove uniqueness.
  for (const result of observed) {
    const profile = result.row.profile;
    if (profile?.eventKind !== 'tool_result' || profile.toolCallId === undefined) continue;
    const path = codexToolEvidence(profile);
    const candidates = observed.filter((candidate) => candidate.row.profile?.eventKind === 'tool_call'
      && candidate.row.profile.toolCallId === profile.toolCallId && codexToolEvidence(candidate.row.profile) !== undefined
      && compatibleContext(candidate.row.profile, profile));
    const results = observed.filter((candidate) => candidate.row.profile?.eventKind === 'tool_result'
      && candidate.row.profile.toolCallId === profile.toolCallId && compatibleContext(candidate.row.profile, profile));
    if (path === undefined || candidates.length !== 1 || results.length !== 1 || !result.physical || !candidates[0]!.physical) {
      missingRelations += 1; continue;
    }
    edges.push(observedEdge(result, candidates[0]!, 'responds', path, generation, edges.length));
  }
  const missingRefs = observed.filter((node) => !node.physical).length;
  const graph = buildBoundedGraph({ graphGeneration: graphRevision,
    snapshotRevision: String(summary.snapshot.epoch ?? 0),
    profileVersion: `${summary.profileVersion ?? 'unavailable'}:${summary.profileEpoch ?? 0}`,
    sourceGenerations: [{ sourceId, generation }], nodes, edges }, { maxNodes: 100, maxEdges: 200 }, {
    authorizedSources: [{ sourceId, generation }], authorizeCrossSourceEdge: () => false, verifyEvidence: () => false,
  });
  const partial = page.rows.length > DOCUMENT_GRAPH_LIMIT || page.hasAfter || page.scan?.truncatedReason !== undefined
    || page.totalRecords === undefined || BigInt(page.totalRecords) > BigInt(rows.length)
    || !summary.indexingComplete || missingRelations > 0 || missingRefs > 0 || graph.snapshot.coverage === 'partial';
  return { version: 1, status: partial ? 'partial' : nodes.length === 0 ? 'empty' : 'ready',
    profileId: summary.profileId, profileVersion: summary.profileVersion ?? 'unavailable',
    ...(summary.profileEpoch === undefined ? {} : { profileEpoch: summary.profileEpoch }),
    scope: { kind: 'physical-prefix', limit: DOCUMENT_GRAPH_LIMIT, examinedRecords: rows.length },
    missingRelations, missingRefs,
    graph: { ...graph, snapshot: { ...graph.snapshot, coverage: partial ? 'partial' : graph.snapshot.coverage } },
  };
}

function nodeKind(profile: AgentRowProjection | undefined): GraphNodeKind {
  return profile?.eventKind === 'session' ? 'session' : profile?.eventKind === 'subagent' ? 'subagent'
    : profile?.eventKind === 'tool_call' || profile?.eventKind === 'tool_result' ? 'tool' : profile === undefined ? 'unknown' : 'event';
}
function exactEvidence(profile: AgentRowProjection, field: string, keys: readonly string[]): FieldPath | undefined {
  if (profile.confidence !== 'source') return undefined;
  return profile.evidence.find((item) => item.field === field && item.path.tokens.length === keys.length
    && item.path.tokens.every((token, index) => token.kind === 'key' && token.value === keys[index]))?.path;
}
function parentEvidence(profile: AgentRowProjection): FieldPath | undefined {
  if (profile.profileId === 'claude-code-session') return exactEvidence(profile, 'parentId', ['parentUuid']);
  if (profile.profileId === 'pi-coding-agent') return exactEvidence(profile, 'parentId', ['parentId']);
  return undefined;
}
function identityEvidence(profile: AgentRowProjection): boolean {
  return profile.profileId === 'claude-code-session' ? exactEvidence(profile, 'messageId', ['uuid']) !== undefined
    : profile.profileId === 'pi-coding-agent' && exactEvidence(profile, 'messageId', ['id']) !== undefined;
}
function codexToolEvidence(profile: AgentRowProjection): FieldPath | undefined {
  return profile.profileId === 'codex-rollout' ? exactEvidence(profile, 'toolCallId', ['payload', 'call_id']) : undefined;
}
function compatibleContext(left: AgentRowProjection, right: AgentRowProjection): boolean {
  return left.profileId === right.profileId && left.sessionId === right.sessionId && left.turnId === right.turnId;
}
function observedEdge(child: ObservedNode, parent: ObservedNode, kind: 'parent' | 'responds', path: FieldPath, generation: string, index: number): GraphEdgeInput {
  return { ref: { ...child.ref, nativeId: `relation:${index}` },
    from: kind === 'parent' ? parent.ref : child.ref, to: kind === 'parent' ? child.ref : parent.ref,
    kind, provenance: 'observed', sourceGeneration: generation, evidenceRef: child.row.ref,
    evidencePaths: [{ tokens: path.tokens.map((token) => token.kind === 'key'
      ? { kind: 'key', value: String(token.value) } : { kind: 'index', value: Number(token.value) }), canonical: displayFieldPath(path) }] };
}
