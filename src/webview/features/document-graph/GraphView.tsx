import type React from 'react';
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, LocateFixed, Play, RefreshCw, FolderOpen } from 'lucide-react';
import type { GraphNodeV2 } from '@shared/contracts/graph';
import type { DocumentGraphReply } from '@shared/contracts/document-graph';
import { layoutDocumentGraph } from './layout';

export interface GraphViewState {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'partial' | 'stale' | 'unauthorized' | 'unavailable';
  reply?: DocumentGraphReply;
  requestId?: string;
  selectedId?: string;
  revealStatus?: string;
}
export interface GraphViewProps {
  state: GraphViewState;
  onRefresh: () => void;
  onSelect: (node: GraphNodeV2) => void;
  onQuery: () => void;
  onSource: () => void;
  onReveal: (node: GraphNodeV2) => void;
}

export function GraphView({ state, onRefresh, onSelect, onQuery, onSource, onReveal }: GraphViewProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const snapshot = state.reply?.graph.snapshot;
  const layout = useMemo(() => snapshot === undefined ? undefined : layoutDocumentGraph(snapshot, collapsed), [snapshot, collapsed]);
  const selected = snapshot?.nodes.find((node) => node.nodeId === state.selectedId);
  const readable = state.status === 'ready' || state.status === 'partial';
  const toggle = (id: string): void => setCollapsed((previous) => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const positions = new Map(layout?.nodes.map((item) => [item.node.nodeId, item]));
  return <div className="document-graph" data-graph-status={state.status}>
    <nav className="graph-command-rail" aria-label="Graph actions">
      <button type="button" aria-current="page" onClick={onRefresh}><GitBranch size={16} aria-hidden />Graph</button>
      <button type="button" onClick={onQuery}><Play size={16} aria-hidden />Query</button>
      <button type="button" onClick={onSource}><FolderOpen size={16} aria-hidden />Source</button>
      <button type="button" disabled={!readable || selected?.recordRef === undefined} onClick={() => { if (selected) onReveal(selected); }}><LocateFixed size={16} aria-hidden />Reveal</button>
    </nav>
    <section className="graph-body" aria-label="Current document hierarchy">
      <div className="graph-toolbar"><strong>Hierarchy</strong><span className="graph-scope">Current document · physical records 0–99 · independent of table filters</span>
        <button type="button" onClick={onRefresh} disabled={state.status === 'loading'} aria-label="Refresh current document graph"><RefreshCw size={14} aria-hidden />Refresh</button></div>
      <p className="graph-status" role="status" aria-live="polite">{statusText(state)}</p>
      {readable && layout !== undefined ? <div className="graph-content">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The overflow viewport is focusable for native keyboard scrolling; record actions remain native buttons. */}
        <section className="graph-scroll" tabIndex={0} aria-label="Hierarchy canvas">
        <div className="graph-canvas" style={{ width: layout.width, height: layout.height }}>
          <svg className="graph-connectors" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
            <title>Observed relationships</title>
            {layout.edges.map((edge) => {
              const from = positions.get(edge.fromNodeId)!; const to = positions.get(edge.toNodeId)!;
              const x = from.x + 240; const y = from.y + 34;
              return <path key={edge.edgeId} data-kind={edge.kind} d={`M ${x} ${y} C ${x + 20} ${y}, ${to.x - 20} ${to.y + 34}, ${to.x} ${to.y + 34}`} />;
            })}
          </svg>
          <ul className="graph-node-list" aria-label="Observed physical records">{layout.nodes.map(({ node, x, y, depth, childCount }) =>
            <li key={node.nodeId} className="graph-node" data-selected={node.nodeId === state.selectedId} style={{ left: x, top: y }}>
              <div className="graph-node-heading">{childCount > 0 ? <button type="button" className="graph-collapse" aria-label={`${collapsed.has(node.nodeId) ? 'Expand' : 'Collapse'} ${node.displayLabel}`} aria-expanded={!collapsed.has(node.nodeId)} onClick={() => toggle(node.nodeId)}>{collapsed.has(node.nodeId) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : null}
                <span>{node.kind} · {node.recordRef === undefined ? 'missing reference' : `#${node.recordRef.ordinal}`} · depth {depth}</span></div>
              <button type="button" className="graph-node-open" disabled={node.recordRef === undefined} aria-pressed={node.nodeId === state.selectedId} aria-label={`Reveal physical record ${node.recordRef?.ordinal ?? 'unavailable'}: ${node.displayLabel}`} title="Reveal this physical record in Table" onFocus={() => onSelect(node)} onClick={() => { onSelect(node); onReveal(node); }}><span>{node.displayLabel}</span><LocateFixed size={14} aria-hidden /></button>
            </li>)}</ul>
        </div>
      </section><aside className="graph-inspector" aria-label="Graph record inspection">
        <strong>Record inspection</strong>{selected === undefined ? <p>Focus a node to inspect its identity. Activate it to reveal the physical record.</p> : <>
          <p>{selected.displayLabel}</p><dl><dt>Kind</dt><dd>{selected.kind} · {selected.rawKind}</dd><dt>Physical record</dt><dd>{selected.recordRef?.ordinal ?? 'Reference unavailable'}</dd><dt>Profile</dt><dd>{selected.qualifiedRef.providerId}</dd><dt>Generation</dt><dd>{selected.recordRef?.generation ?? 'Unavailable'}</dd></dl>
          <strong>Observed relationships</strong><ul>{snapshot?.edges.filter((edge) => edge.fromNodeId === selected.nodeId || edge.toNodeId === selected.nodeId).map((edge) => <li key={edge.edgeId}>{edge.kind} · {edge.evidencePaths.map((path) => path.canonical).join(', ')}</li>)}</ul>
        </>}
      </aside></div> : <div className="graph-state-panel"><GitBranch size={30} aria-hidden /><span>{state.status === 'loading' ? 'Reading a bounded background page…' : state.status === 'idle' ? 'Open the current document graph.' : statusText(state)}</span></div>}
      {state.reply !== undefined && readable ? <div className="graph-footnote">{state.reply.graph.snapshot.nodes.length} physical nodes · {state.reply.graph.snapshot.edges.length} observed relations · {state.reply.missingRelations} omitted relations · {state.reply.missingRefs} missing references. Unknown rows remain inspectable. No cross-source relationships.</div> : null}
    </section>
  </div>;
}

function statusText(state: GraphViewState): string {
  if (state.status === 'loading') return 'Loading the current authorized source…';
  if (state.status === 'empty') return 'The current document has no records in this physical prefix.';
  if (state.status === 'partial') return 'Partial graph: the physical prefix, analysis budget or available relationship evidence limits coverage.';
  if (state.status === 'stale') return 'Source or profile changed. Refresh to read current records.';
  if (state.status === 'unauthorized') return 'Current source authorization is unavailable. Open an authorized source.';
  if (state.status === 'unavailable') return 'The bounded graph read could not complete within its read/time budget or the source is unavailable. Refresh to retry.';
  return state.status === 'ready' ? 'Observed current-document relationships. Click a node to reveal its exact physical record.' : 'Current-document graph';
}
