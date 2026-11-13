import { useMemo, useRef, useState } from 'react';
import type React from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Bot, Braces, ChevronDown, ChevronRight, Clock3, GitBranch, Search, UserRound, X } from 'lucide-react';
import type { RecordRef, RowProjection } from '@shared/types';
import type { LineageLookupRelation } from '@shared/contracts/lineage';
import { sameGraphRecordRef } from '@shared/document-graph';
import type { RecordLineageCoverageReason, RecordLineageNode, RecordLineageProjection } from './model';
import { buildLineageRail, type RailRecord } from './rail-model';
import type { LineageLookupState } from './controller';
import { LineageTopology } from './LineageTopology';

const reasonText: Record<RecordLineageCoverageReason, string> = {
  'selected-not-in-page': 'The selected record is outside the accepted page and explicit lookup results.',
  'ambiguous-selection': 'The selected physical reference occurs more than once.',
  'ambiguous-record-ref': 'Duplicate physical references were excluded.',
  'unmatched-parent': 'A parent ID is present; its same-context record was not observed.',
  'ambiguous-parent': 'Multiple parents matched. No parent was chosen.',
  'missing-parent-context': 'Session or turn context is incomplete. No parent was linked.',
  'unverified-parent-evidence': 'Parent evidence is unsupported. No parent was linked.',
  'unmatched-tool-pair': 'A same-context tool call or result was not observed.',
  'ambiguous-tool-pair': 'Multiple tool partners matched. No partner was chosen.',
  'missing-tool-context': 'Tool pairing requires session and turn context.',
  'unverified-tool-evidence': 'Tool evidence is unsupported. No pair was linked.',
  'depth-limit': 'The rail stops after three hops. Open a boundary record to continue.',
  'node-limit': 'The rail stops at fifteen records. Open a boundary record to continue.',
};

export interface LineageViewProps {
  projection: RecordLineageProjection | undefined;
  unavailableReason: string | undefined;
  onSelectRecord: ((ref: RecordRef) => void) | undefined;
  onRevealRecord?: ((ref: RecordRef) => void) | undefined;
  lookup?: LineageLookupState | undefined;
  onLookup?: ((ref: RecordRef, relation: LineageLookupRelation) => void) | undefined;
  onCancelLookup?: (() => void) | undefined;
  returnRef?: RecordRef | undefined;
  onBack?: (() => void) | undefined;
  pageRows?: number | undefined;
}

export function LineageRail({ projection, unavailableReason, onSelectRecord, onRevealRecord, lookup, onLookup,
  onCancelLookup, returnRef, onBack, pageRows }: LineageViewProps): React.JSX.Element {
  const [peekRef, setPeekRef] = useState<RecordRef>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [topology, setTopology] = useState(false);
  const railRef = useRef<HTMLOListElement>(null);
  const rail = useMemo(() => projection === undefined ? undefined : buildLineageRail(projection), [projection]);
  const peek = peekRef === undefined ? undefined : projection?.nodes.find((node) => sameGraphRecordRef(node.ref, peekRef))?.row
    ?? lookup?.extraRows.find((row) => sameGraphRecordRef(row.ref, peekRef));
  const setPeek = (row: RowProjection | undefined): void => setPeekRef(row?.ref);
  const reveal = onRevealRecord ?? onSelectRecord;
  if (unavailableReason !== undefined) return <div className="detail-empty" role="status">{unavailableReason}</div>;
  if (projection === undefined || rail === undefined) return <div className="detail-empty" role="status">Lineage requires a current result page.</div>;
  const toggle = (key: string): void => setExpanded((current) => {
    const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const openPeek = (row: RowProjection): void => setPeek(peek !== undefined && sameGraphRecordRef(peek.ref, row.ref) ? undefined : row);
  const keyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (topology) return;
      if (peek !== undefined) { setPeek(undefined); event.preventDefault(); event.stopPropagation(); }
      else if (expanded.size > 0) { setExpanded(new Set()); event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const targets = [...railRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-focus]') ?? []].filter((button) => !button.disabled);
    const index = targets.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    targets[Math.max(0, Math.min(targets.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    event.preventDefault();
  };
  const record = (item: RailRecord): React.JSX.Element => {
    const node = item.node;
    const profile = node.row.profile;
    const Icon = profile?.eventKind === 'tool_call' || profile?.eventKind === 'tool_result' ? Braces
      : profile?.actor === 'user' ? UserRound : profile?.actor === 'assistant' ? Bot : Clock3;
    const selected = node.direction === 'selected';
    return <article className={`lineage-card${selected ? ' is-selected' : ''}`} data-direction={node.direction}>
      <button type="button" className="lineage-card-main" data-rail-focus aria-current={selected ? 'true' : undefined}
        aria-label={`Preview record #${node.ref.ordinal}`} aria-expanded={peek !== undefined && sameGraphRecordRef(peek.ref, node.ref)}
        onClick={() => openPeek(node.row)} onDoubleClick={() => reveal?.(node.ref)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); reveal?.(node.ref); } }}>
        <span className="lineage-card-heading"><Icon size={14} aria-hidden /><strong>{profile?.actor ?? profile?.eventKind ?? 'Record'}</strong>
          <span className="lineage-card-ordinal">#{node.ref.ordinal}</span></span>
        <span className="lineage-card-relation">{relationLabel(node)}</span>
        <span className="lineage-card-summary">{profile?.summary ?? node.row.genericSummary}</span>
      </button>
      {item.badges.length > 0 ? <fieldset className="lineage-badges" aria-label="Metadata on the observed parent chain">
        {item.badges.map((badge) => <button type="button" className="lineage-badge" key={badge.node.ref.ordinal}
          aria-label={`Preview ${badge.label}, record #${badge.node.ref.ordinal}`} title={`Record #${badge.node.ref.ordinal} · ${badge.label}`}
          onClick={() => openPeek(badge.node.row)}><Clock3 size={11} aria-hidden />{badge.label}<span>#{badge.node.ref.ordinal}</span></button>)}
      </fieldset> : null}
    </article>;
  };
  return <section className="lineage-view" aria-label="Record lineage" onKeyDown={keyDown}
    onKeyDownCapture={(event) => { if (event.key === 'Escape') keyDown(event); }}>
    <div className="lineage-toolbar"><div><span className="lineage-eyebrow">OBSERVED RELATIONSHIPS</span><h3>Causal rail</h3></div>
      <button type="button" className="lineage-secondary" onClick={() => setTopology(true)} disabled={projection.nodes.length === 0}
        aria-label="Open observed topology"><GitBranch size={13} aria-hidden /><span>Topology</span></button></div>
    {returnRef !== undefined && onBack !== undefined ? <button type="button" className="lineage-return" onClick={onBack}>
      <ArrowLeft size={13} aria-hidden />Back to record #{returnRef.ordinal}</button> : null}
    <div className="lineage-scope"><span className="lineage-scope-dot" aria-hidden />Current page · {pageRows ?? projection.coverage.examinedRows} records
      {lookup?.extraRows.length ? <span> + {lookup.extraRows.length} looked up</span> : null}
      <span className="lineage-scope-status">{projection.coverage.status === 'ambiguous' ? 'Ambiguous' : projection.coverage.status === 'current-page' ? 'Page scope' : 'Partial'}</span></div>
    <p className="lineage-hint">Click to preview · Enter or double-click to locate</p>
    <ol ref={railRef} className="lineage-rail" aria-label="Related records">
      {rail.gaps.filter((gap) => gap.relation !== 'tool-partner').map((gap) => <li className="lineage-gap" key={`${gap.relation}:${gap.node.ref.ordinal}`}>
        <span className="lineage-rail-dot is-ghost" aria-hidden /><div><strong>{gap.relation === 'span-context' ? 'Span not observed' : 'Parent not observed'}</strong><span className="lineage-gap-id" title={gap.label}>{gap.label}</span>
          <span className="lineage-muted">Source ID from #{gap.node.ref.ordinal}; its location is unknown.</span>
          <button type="button" className="lineage-search" onClick={() => onLookup?.(gap.node.ref, gap.relation)}
            disabled={onLookup === undefined || lookup?.status === 'loading'}><Search size={12} aria-hidden />Search prior records</button></div></li>)}
      {rail.entries.map((entry) => <li className={`lineage-rail-entry${entry.kind === 'record' ? ` is-${entry.node.direction}` : ' is-branch'}`} key={entry.key}>
        <span className={`lineage-rail-dot${entry.kind === 'record' && entry.node.direction === 'selected' ? ' is-selected' : ''}`} aria-hidden />
        {entry.kind === 'record' ? record(entry) : <div className="lineage-branch">
          <button type="button" className="lineage-branch-toggle" data-rail-focus aria-expanded={expanded.has(entry.key)}
            aria-controls={`lineage-${entry.key}`} onClick={() => toggle(entry.key)} onKeyDown={(event) => {
              if (event.key === 'ArrowRight' && !expanded.has(entry.key) || event.key === 'ArrowLeft' && expanded.has(entry.key)) { event.preventDefault(); toggle(entry.key); }
            }}>{expanded.has(entry.key) ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            <GitBranch size={13} aria-hidden />{entry.label}</button>
          {expanded.has(entry.key) ? <fieldset id={`lineage-${entry.key}`} className="lineage-branch-records" aria-label="Tool call branches">
            <p className="lineage-muted">Shared parent evidence; concurrency is not established.</p>{entry.records.map((item) => <div key={item.key}>{record(item)}</div>)}
          </fieldset> : null}</div>}</li>)}
      {rail.gaps.filter((gap) => gap.relation === 'tool-partner').map((gap) => <li className="lineage-gap" key={`tool:${gap.node.ref.ordinal}`}>
        <span className="lineage-rail-dot is-ghost" aria-hidden /><div><strong>Tool partner not observed</strong><span className="lineage-gap-id" title={gap.label}>{gap.label}</span>
          <button type="button" className="lineage-search" onClick={() => onLookup?.(gap.node.ref, gap.relation)}
            disabled={onLookup === undefined || lookup?.status === 'loading'}><Search size={12} aria-hidden />Search nearby records</button></div></li>)}
    </ol>
    {projection.nodes.length === 0 ? <div className="detail-empty">No observed relationships to display.</div> : null}
    {peek !== undefined ? <aside className="lineage-peek" aria-label={`Record #${peek.ref.ordinal} preview`}>
      <div className="lineage-peek-header"><strong>Record #{peek.ref.ordinal}</strong><span>Bounded projection</span>
        <button type="button" className="icon-button" aria-label="Close record preview" onClick={() => setPeek(undefined)}><X size={13} aria-hidden /></button></div>
      <p>{peek.profile?.summary ?? peek.genericSummary}</p><dl><dt>Kind</dt><dd>{peek.profile?.eventKind ?? peek.ref.parseState}</dd>
        {peek.profile?.messageId ? <><dt>ID</dt><dd>{peek.profile.messageId}</dd></> : null}
        {peek.profile?.parentId ? <><dt>Parent</dt><dd>{peek.profile.parentId}</dd></> : null}</dl>
      <div className="lineage-peek-actions"><button type="button" onClick={() => onSelectRecord?.(peek.ref)} disabled={onSelectRecord === undefined}>Open full detail</button>
        <button type="button" onClick={() => reveal?.(peek.ref)} disabled={reveal === undefined}>Locate in table</button></div></aside> : null}
    {lookup !== undefined && lookup.status !== 'idle' ? <div className="lineage-lookup-status" role="status" aria-live="polite">
      <span>{lookupText(lookup)}</span>{lookup.status === 'loading' ? <button type="button" onClick={onCancelLookup}>Cancel lookup</button> : null}
      {lookup.reply?.match !== undefined ? <button type="button" onClick={() => setPeek(lookup.reply!.match!)}>Preview found record #{lookup.reply.match.ref.ordinal}</button> : null}
      {lookup.reply ? <small>Window #{lookup.reply.scope.startOrdinal}–&lt;{lookup.reply.scope.endOrdinalExclusive} · {lookup.reply.scope.examinedRecords} examined · {lookup.reply.scope.requestedBytes.toLocaleString()} B requested</small> : null}</div> : null}
    <details className="lineage-evidence"><summary>Coverage &amp; source evidence <span>{projection.edges.length} links · {rail.metadataCount} metadata</span></summary>
      <p>Only this page and explicit lookup results are covered. The most recent 16 lookup results are retained. Other records may be filtered out or on another page. Lookup candidates are unique within their checked window.</p>
      {projection.coverage.reasons.length ? <ul>{projection.coverage.reasons.map((reason) => <li key={reason}>{reasonText[reason]}</li>)}</ul> : null}
      <ul>{projection.edges.map((edge) => <li key={`${edge.kind}:${edge.from.ordinal}:${edge.to.ordinal}`}>#{edge.from.ordinal} → #{edge.to.ordinal} · {edge.kind === 'parent' ? 'Source parent' : edge.kind === 'span-context' ? 'Span context (non-causal)' : 'Tool call/result'}</li>)}</ul></details>
    <div className="lineage-keyboard"><ArrowUp size={11} aria-hidden /><ArrowDown size={11} aria-hidden />navigate <span>↵ locate</span><span>Esc dismiss</span></div>
    {topology ? <LineageTopology projection={projection} onClose={() => setTopology(false)} onPreview={(row) => { setTopology(false); setPeek(row); }} /> : null}
  </section>;
}

function relationLabel(node: RecordLineageNode): string {
  if (node.direction === 'selected') return 'SELECTED RECORD';
  if (node.direction === 'ancestor') return `Upstream · ${node.depth} ${node.depth === 1 ? 'hop' : 'hops'}`;
  if (node.direction === 'descendant') return `Downstream · ${node.depth} ${node.depth === 1 ? 'hop' : 'hops'}`;
  return 'Related · observed link';
}
function lookupText(state: LineageLookupState): string {
  if (state.status === 'loading') return 'Looking in one physical window · 500-record / 1 MiB caps · 1.5 s deadline…';
  if (state.status === 'cancelled') return 'Lookup cancelled. Late results are ignored.';
  if (state.status === 'error') return 'Lookup unavailable. No relationship was added.';
  switch (state.reply?.status) {
    case 'found': return `Found candidate #${state.reply.match?.ref.ordinal} in the checked window.`;
    case 'not-observed': return 'Target not observed in this window. Other parts of the source were not checked.';
    case 'ambiguous': return 'Multiple candidates matched in this window. No relationship was added.';
    case 'budget-exceeded': return 'The read allowance was exhausted. This window was not fully checked.';
    case 'timed-out': return 'The lookup deadline elapsed. This window was not fully checked.';
    case 'stale': return 'The source changed. Refresh the current page before searching again.';
    default: return 'Lookup unavailable. No relationship was added.';
  }
}
