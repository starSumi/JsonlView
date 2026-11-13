import type { RowProjection } from '@shared/types';
import { exactLineageEvidence, lineageLookupTarget } from '@shared/lineage-evidence';
import type { LineageLookupRelation } from '@shared/contracts/lineage';
import type { RecordLineageNode, RecordLineageProjection } from './model';

export interface LineageBadge { readonly node: RecordLineageNode; readonly label: string }
export interface RailRecord { readonly kind: 'record'; readonly key: string; readonly node: RecordLineageNode; readonly badges: readonly LineageBadge[] }
export interface RailBranch { readonly kind: 'branch'; readonly key: string; readonly label: string; readonly records: readonly RailRecord[] }
export type RailEntry = RailRecord | RailBranch;
export interface LineageGap { readonly node: RecordLineageNode; readonly relation: LineageLookupRelation; readonly label: string }

export function lineageMetadataLabel(row: RowProjection): string | undefined {
  const profile = row.profile;
  if (profile?.profileId !== 'claude-code-session' || profile.eventKind === 'error') return undefined;
  const type = profile.derivedFields?.sourceType;
  if (exactLineageEvidence(profile, 'sourceType', ['type']) === undefined) return undefined;
  if (type === 'attachment') return typeof profile.derivedFields?.attachmentType === 'string'
    && exactLineageEvidence(profile, 'attachmentType', ['attachment', 'type']) !== undefined
    ? profile.derivedFields.attachmentType.replaceAll('_', ' ') : 'Attachment';
  if (type === 'system' && profile.derivedFields?.sourceSubtype === 'turn_duration'
    && exactLineageEvidence(profile, 'sourceSubtype', ['subtype']) !== undefined) {
    const duration = profile.derivedFields.durationMs;
    return typeof duration === 'number' && exactLineageEvidence(profile, 'durationMs', ['durationMs']) !== undefined
      ? `${(duration / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s` : 'Turn duration';
  }
  return undefined;
}

/** Collapse only a verified, unbranched parent chain. Ordering never creates an edge. */
export function buildLineageRail(projection: RecordLineageProjection): { entries: readonly RailEntry[]; gaps: readonly LineageGap[]; metadataCount: number } {
  const nodes = new Map(projection.nodes.map((node) => [node.ref.ordinal, node]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of projection.edges) {
    if (edge.kind !== 'parent') continue;
    incoming.set(edge.to.ordinal, [...incoming.get(edge.to.ordinal) ?? [], edge.from.ordinal]);
    outgoing.set(edge.from.ordinal, [...outgoing.get(edge.from.ordinal) ?? [], edge.to.ordinal]);
  }
  const metadata = new Map<string, string>();
  for (const node of projection.nodes) {
    const label = lineageMetadataLabel(node.row);
    if (node.direction !== 'selected' && label !== undefined && (incoming.get(node.ref.ordinal)?.length ?? 0) <= 1
      && (outgoing.get(node.ref.ordinal)?.length ?? 0) <= 1) metadata.set(node.ref.ordinal, label);
  }
  const badges = new Map<string, LineageBadge[]>();
  const hidden = new Set<string>();
  for (const [ordinal, label] of metadata) {
    let cursor = ordinal;
    const seen = new Set([ordinal]);
    let owner: string | undefined;
    // Prefer the nearest content ancestor. At the visible chain boundary use
    // the nearest content descendant, never an unrelated neighboring record.
    for (const links of [incoming, outgoing]) {
      cursor = ordinal; seen.clear(); seen.add(ordinal);
      while (links.get(cursor)?.length === 1) {
        const next = links.get(cursor)![0]!;
        if (seen.has(next)) break;
        seen.add(next);
        if (!metadata.has(next)) { owner = next; break; }
        cursor = next;
      }
      if (owner !== undefined) break;
    }
    if (owner === undefined || !nodes.has(owner)) continue;
    hidden.add(ordinal);
    badges.set(owner, [...badges.get(owner) ?? [], { node: nodes.get(ordinal)!, label }]);
  }
  for (const edge of projection.edges) {
    if (edge.kind !== 'span-context') continue;
    const log = nodes.get(edge.to.ordinal);
    if (log === undefined || log.direction === 'selected' || /^(?:error|fatal|critical)$/iu.test(log.row.profile?.severity ?? '')) continue;
    hidden.add(log.ref.ordinal);
    badges.set(edge.from.ordinal, [...badges.get(edge.from.ordinal) ?? [], { node: log, label: 'Log' }]);
  }
  const records = projection.nodes.filter((node) => !hidden.has(node.ref.ordinal))
    .map((node): RailRecord => ({ kind: 'record', key: node.ref.ordinal, node,
      badges: (badges.get(node.ref.ordinal) ?? []).sort((a, b) => compareOrdinal(a.node.ref.ordinal, b.node.ref.ordinal)) }));
  // Ancestors lead into the selection; source ordinals only break presentation ties.
  records.sort((a, b) => rank(a.node) - rank(b.node) || compareOrdinal(a.node.ref.ordinal, b.node.ref.ordinal));
  const groups = new Map<string, RailRecord[]>();
  for (const record of records) {
    if (record.node.direction === 'selected' || record.node.row.profile?.eventKind !== 'tool_call') continue;
    const parents = incoming.get(record.key) ?? [];
    if (parents.length === 1) groups.set(parents[0]!, [...groups.get(parents[0]!) ?? [], record]);
  }
  const grouped = new Set<string>();
  const entries: RailEntry[] = [];
  for (const record of records) {
    if (grouped.has(record.key)) continue;
    const siblings = groups.get(incoming.get(record.key)?.[0] ?? '');
    if (record.node.row.profile?.eventKind === 'tool_call' && siblings !== undefined && siblings.length > 1) {
      for (const item of siblings) grouped.add(item.key);
      entries.push({ kind: 'branch', key: `branch:${record.key}`, label: `${siblings.length} tool calls · shared parent`, records: siblings });
    } else entries.push(record);
  }
  const gaps: LineageGap[] = [];
  for (const node of projection.nodes) {
    const parent = lineageLookupTarget(node.row, 'parent');
    if (parent !== undefined && !projection.edges.some((edge) => edge.kind === 'parent' && edge.to.ordinal === node.ref.ordinal)) {
      gaps.push({ node, relation: 'parent', label: parent.label });
    }
    const tool = lineageLookupTarget(node.row, 'tool-partner');
    if (tool !== undefined && !projection.edges.some((edge) => edge.kind === 'responds'
      && (edge.from.ordinal === node.ref.ordinal || edge.to.ordinal === node.ref.ordinal))) gaps.push({ node, relation: 'tool-partner', label: tool.label });
    const span = lineageLookupTarget(node.row, 'span-context');
    if (span !== undefined && !projection.edges.some((edge) => edge.kind === 'span-context' && edge.to.ordinal === node.ref.ordinal)) {
      gaps.push({ node, relation: 'span-context', label: span.label });
    }
  }
  return { entries, gaps, metadataCount: hidden.size };
}
function rank(node: RecordLineageNode): number {
  return node.direction === 'ancestor' ? -node.depth : node.direction === 'selected' ? 0 : node.direction === 'descendant' ? node.depth : 10 + node.depth;
}
function compareOrdinal(left: string, right: string): number { return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0; }
