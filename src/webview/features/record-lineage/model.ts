import type { AgentRowProjection, RecordRef, RowProjection } from '@shared/types';
import { lineageIdentityEvidence as identityEvidence, lineageParentEvidence as parentEvidence,
  lineageToolEvidence as codexToolEvidence, lineageParentKey as parentContextKey,
  lineageToolKey as codexToolKey, nonemptyLineageValue as hasValue, lineageSpanContextEvidence } from '@shared/lineage-evidence';

export type RecordLineageDirection = 'selected' | 'ancestor' | 'descendant' | 'related';
export type RecordLineageRelationKind = 'parent' | 'responds' | 'span-context';
export type RecordLineageCoverageStatus = 'current-page' | 'partial' | 'ambiguous' | 'missing';
export type RecordLineageCoverageReason =
  | 'selected-not-in-page'
  | 'ambiguous-selection'
  | 'ambiguous-record-ref'
  | 'unmatched-parent'
  | 'ambiguous-parent'
  | 'missing-parent-context'
  | 'unverified-parent-evidence'
  | 'unmatched-tool-pair'
  | 'ambiguous-tool-pair'
  | 'missing-tool-context'
  | 'unverified-tool-evidence'
  | 'depth-limit'
  | 'node-limit';

export interface RecordLineageNode {
  readonly ref: RecordRef;
  readonly row: RowProjection;
  readonly depth: number;
  readonly direction: RecordLineageDirection;
}

export interface RecordLineageEdge {
  readonly from: RecordRef;
  readonly to: RecordRef;
  readonly kind: RecordLineageRelationKind;
}

export interface RecordLineageProjection {
  readonly nodes: readonly RecordLineageNode[];
  readonly edges: readonly RecordLineageEdge[];
  readonly coverage: {
    readonly scope: 'current-page';
    readonly status: RecordLineageCoverageStatus;
    readonly reasons: readonly RecordLineageCoverageReason[];
    readonly examinedRows: number;
  };
}

interface ObservedRow {
  readonly row: RowProjection;
  readonly key: string;
}

interface InternalEdge {
  readonly fromKey: string;
  readonly toKey: string;
  readonly edge: RecordLineageEdge;
}

interface Neighbor {
  readonly key: string;
  readonly edge: InternalEdge;
  readonly direction: Exclude<RecordLineageDirection, 'selected'>;
}

const MAX_LINEAGE_DEPTH = 3;
const MAX_LINEAGE_NODES = 15;

/** Projects only source-evidenced relationships already present in the accepted current page. */
export function projectRecordLineage(rows: readonly RowProjection[], selectedRef: RecordRef): RecordLineageProjection {
  const observed: ObservedRow[] = rows.map((row) => ({ row, key: recordRefKey(row.ref) }));
  const rowsByRef = new Map<string, ObservedRow[]>();
  for (const item of observed) {
    const refs = rowsByRef.get(item.key) ?? [];
    refs.push(item);
    rowsByRef.set(item.key, refs);
  }

  const selectedKey = recordRefKey(selectedRef);
  const selectedMatches = rowsByRef.get(selectedKey) ?? [];
  if (selectedMatches.length === 0) {
    return result([], [], 'missing', ['selected-not-in-page'], rows.length);
  }
  if (selectedMatches.length > 1) {
    return result([], [], 'ambiguous', ['ambiguous-selection'], rows.length);
  }
  const uniqueObserved = observed.filter((item) => rowsByRef.get(item.key)?.length === 1);

  const parentCandidates = new Map<string, ObservedRow[]>();
  const parentCandidatesByIdentity = new Map<string, ObservedRow[]>();
  const codexCalls = new Map<string, ObservedRow[]>();
  const codexResults = new Map<string, ObservedRow[]>();
  const issues = new Map<string, Set<RecordLineageCoverageReason>>();
  for (const item of uniqueObserved) {
    const profile = item.row.profile;
    if (profile === undefined) continue;
    if (profile.messageId !== undefined && identityEvidence(profile)) {
      addCandidate(parentCandidatesByIdentity, identityKey(item.row.ref.generation, profile, profile.messageId), item);
      const key = parentContextKey(item.row.ref.generation, profile, profile.messageId);
      if (key !== undefined) addCandidate(parentCandidates, key, item);
    }
    if (profile.parentId !== undefined && parentEvidence(profile) === undefined && lineageSpanContextEvidence(profile) === undefined
      && !(profile.profileId === 'opentelemetry' && /^0*$/u.test(profile.parentId))) {
      addIssue(issues, item.key, 'unverified-parent-evidence');
    }
    if (profile.profileId === 'codex-rollout' && profile.toolCallId !== undefined) {
      const toolEvidence = codexToolEvidence(profile);
      if ((profile.eventKind === 'tool_call' || profile.eventKind === 'tool_result') && toolEvidence === undefined) {
        addIssue(issues, item.key, 'unverified-tool-evidence');
      }
      if (profile.eventKind === 'tool_call' || profile.eventKind === 'tool_result') {
        if (toolEvidence !== undefined) {
          const key = codexToolKey(item.row.ref.generation, profile, profile.toolCallId);
          if (key === undefined) addIssue(issues, item.key, 'missing-tool-context');
          else if (profile.eventKind === 'tool_call') addCandidate(codexCalls, key, item);
          else addCandidate(codexResults, key, item);
        }
      }
    }
  }

  const edges: InternalEdge[] = [];
  for (const child of uniqueObserved) {
    const profile = child.row.profile;
    if (profile === undefined || profile.parentId === undefined) continue;
    const spanContext = lineageSpanContextEvidence(profile) !== undefined;
    if (parentEvidence(profile) === undefined && !spanContext) continue;
    const key = parentContextKey(child.row.ref.generation, profile, profile.parentId);
    if (key === undefined) {
      addIssue(issues, child.key, 'missing-parent-context');
      continue;
    }
    const parents = parentCandidates.get(key) ?? [];
    if (parents.length === 1) {
      edges.push(parentEdge(parents[0]!, child, spanContext ? 'span-context' : 'parent'));
    } else {
      const possibleParents = parentCandidatesByIdentity.get(identityKey(child.row.ref.generation, profile, profile.parentId)) ?? [];
      const incompleteContext = parents.length === 0 && possibleParents.some((parent) =>
        parentContextIsIncomplete(profile, parent.row.profile));
      const reason = parents.length > 1 ? 'ambiguous-parent'
        : incompleteContext ? 'missing-parent-context' : 'unmatched-parent';
      addIssue(issues, child.key, reason);
      if (reason === 'ambiguous-parent') {
        for (const parent of parents) addIssue(issues, parent.key, reason);
      }
    }
  }

  const codexPairKeys = new Set([...codexCalls.keys(), ...codexResults.keys()]);
  for (const key of codexPairKeys) {
    const calls = codexCalls.get(key) ?? [];
    const results = codexResults.get(key) ?? [];
    if (calls.length === 1 && results.length === 1) {
      edges.push({ fromKey: calls[0]!.key, toKey: results[0]!.key,
        edge: { from: calls[0]!.row.ref, to: results[0]!.row.ref, kind: 'responds' } });
    } else {
      const reason = calls.length === 0 || results.length === 0 ? 'unmatched-tool-pair' : 'ambiguous-tool-pair';
      for (const item of calls) addIssue(issues, item.key, reason);
      for (const item of results) addIssue(issues, item.key, reason);
    }
  }

  for (const [key, matches] of rowsByRef) {
    if (matches.length > 1) addIssue(issues, key, 'ambiguous-record-ref');
  }

  const adjacency = new Map<string, Neighbor[]>();
  for (const edge of edges) {
    addNeighbor(adjacency, edge.fromKey, { key: edge.toKey, edge, direction: edge.edge.kind === 'parent' ? 'descendant' : 'related' });
    addNeighbor(adjacency, edge.toKey, { key: edge.fromKey, edge, direction: edge.edge.kind === 'parent' ? 'ancestor' : 'related' });
  }

  const depths = new Map<string, number>([[selectedKey, 0]]);
  const directions = new Map<string, RecordLineageDirection>([[selectedKey, 'selected']]);
  const queue = [selectedKey];
  const reasons = new Set<RecordLineageCoverageReason>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const key = queue[cursor]!;
    const depth = depths.get(key)!;
    for (const neighbor of adjacency.get(key) ?? []) {
      if (depths.has(neighbor.key)) continue;
      if (depth >= MAX_LINEAGE_DEPTH) {
        reasons.add('depth-limit');
        continue;
      }
      if (depths.size >= MAX_LINEAGE_NODES) {
        reasons.add('node-limit');
        continue;
      }
      depths.set(neighbor.key, depth + 1);
      const currentDirection = directions.get(key)!;
      directions.set(neighbor.key, currentDirection === 'selected' || currentDirection === neighbor.direction
        ? neighbor.direction : 'related');
      queue.push(neighbor.key);
    }
  }

  for (const [key, rowIssues] of issues) {
    for (const reason of rowIssues) {
      if (GLOBAL_COVERAGE_REASONS.has(reason) || depths.has(key)) reasons.add(reason);
    }
  }

  const includedEdges = edges.filter((edge) => depths.has(edge.fromKey) && depths.has(edge.toKey)).map((item) => item.edge);
  const includedKeys = new Set(depths.keys());
  const nodes: RecordLineageNode[] = [];
  const emitted = new Set<string>();
  for (const item of uniqueObserved) {
    if (!includedKeys.has(item.key) || emitted.has(item.key)) continue;
    emitted.add(item.key);
    nodes.push({ ref: item.row.ref, row: item.row, depth: depths.get(item.key)!, direction: directions.get(item.key)! });
  }

  const reasonList = [...reasons];
  const status: RecordLineageCoverageStatus = reasonList.some(isAmbiguityReason) ? 'ambiguous'
    : reasonList.length > 0 ? 'partial' : 'current-page';
  return result(nodes, includedEdges, status, reasonList, rows.length);
}

function result(nodes: readonly RecordLineageNode[], edges: readonly RecordLineageEdge[], status: RecordLineageCoverageStatus,
  reasons: readonly RecordLineageCoverageReason[], examinedRows: number): RecordLineageProjection {
  return { nodes, edges, coverage: { scope: 'current-page', status, reasons, examinedRows } };
}

function recordRefKey(ref: RecordRef): string {
  return JSON.stringify([ref.generation, ref.ordinal, ref.byteStart, ref.byteEndExclusive, ref.contentByteLength,
    ref.delimiterByteLength, ref.parseState]);
}

function identityKey(generation: string, profile: AgentRowProjection, identifier: string): string {
  return JSON.stringify([generation, profile.profileId, identifier]);
}

function parentContextIsIncomplete(child: AgentRowProjection, parent: AgentRowProjection | undefined): boolean {
  if (parent === undefined || !hasValue(child.sessionId) || !hasValue(parent.sessionId)) return true;
  if (child.sessionId !== parent.sessionId) return false;
  return hasValue(child.turnId) !== hasValue(parent.turnId);
}

function addCandidate(map: Map<string, ObservedRow[]>, key: string, item: ObservedRow): void {
  const rows = map.get(key) ?? [];
  rows.push(item);
  map.set(key, rows);
}

function parentEdge(parent: ObservedRow, child: ObservedRow, kind: 'parent' | 'span-context'): InternalEdge {
  return { fromKey: parent.key, toKey: child.key,
    edge: { from: parent.row.ref, to: child.row.ref, kind } };
}

function addIssue(issues: Map<string, Set<RecordLineageCoverageReason>>, key: string, reason: RecordLineageCoverageReason): void {
  const reasons = issues.get(key) ?? new Set<RecordLineageCoverageReason>();
  reasons.add(reason);
  issues.set(key, reasons);
}

function addNeighbor(adjacency: Map<string, Neighbor[]>, key: string, neighbor: Neighbor): void {
  const neighbors = adjacency.get(key) ?? [];
  neighbors.push(neighbor);
  adjacency.set(key, neighbors);
}

function isAmbiguityReason(reason: RecordLineageCoverageReason): boolean {
  return reason === 'ambiguous-selection' || reason === 'ambiguous-record-ref'
    || reason === 'ambiguous-parent' || reason === 'ambiguous-tool-pair';
}

const GLOBAL_COVERAGE_REASONS = new Set<RecordLineageCoverageReason>([
  'ambiguous-record-ref',
  'missing-parent-context', 'missing-tool-context', 'unverified-parent-evidence', 'unverified-tool-evidence',
]);
