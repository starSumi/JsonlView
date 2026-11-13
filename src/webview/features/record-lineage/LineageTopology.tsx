import { useEffect, useRef } from 'react';
import type React from 'react';
import { X } from 'lucide-react';
import type { RowProjection } from '@shared/types';
import type { RecordLineageProjection } from './model';

/** A bounded overview of the same observed nodes; opening it performs no reads. */
export function LineageTopology({ projection, onClose, onPreview }: {
  projection: RecordLineageProjection; onClose(): void; onPreview(row: RowProjection): void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const nodes = projection.nodes;
  const width = 640;
  const height = Math.max(160, nodes.length * 58 + 24);
  const positions = new Map(nodes.map((node, index) => [node.ref.ordinal, {
    x: node.direction === 'selected' ? 270 : node.direction === 'ancestor' ? 90 : node.direction === 'descendant' ? 450 : 270,
    y: 32 + index * 58,
  }]));
  return <dialog ref={dialog} className="lineage-topology" aria-labelledby="lineage-topology-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDownCapture={(event) => event.stopPropagation()}>
    <header><div><h3 id="lineage-topology-title">Observed topology</h3><p>Same bounded records · arrows show source relationships</p></div>
      <button type="button" className="icon-button" aria-label="Close topology" onClick={onClose}><X size={16} aria-hidden /></button></header>
    <div className="lineage-topology-scroll"><svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="Observed parent and tool relationships">
      <defs><marker id="lineage-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="currentColor" /></marker></defs>
      {projection.edges.map((edge) => { const from = positions.get(edge.from.ordinal)!; const to = positions.get(edge.to.ordinal)!;
        return <line key={`${edge.kind}:${edge.from.ordinal}:${edge.to.ordinal}`} x1={from.x + 58} y1={from.y + 14} x2={to.x + 58} y2={to.y - 10}
          stroke="currentColor" strokeWidth="1.5" strokeDasharray={edge.kind !== 'parent' ? '4 3' : undefined} markerEnd="url(#lineage-arrow)"><title>{edge.kind}: #{edge.from.ordinal} to #{edge.to.ordinal}</title></line>; })}
      {nodes.map((node) => { const point = positions.get(node.ref.ordinal)!;
        return <g key={node.ref.ordinal} className={node.direction === 'selected' ? 'is-selected' : ''}><rect x={point.x} y={point.y - 10} width="116" height="30" rx="5" />
          <text x={point.x + 8} y={point.y + 9}>#{node.ref.ordinal} · {node.row.profile?.eventKind ?? 'record'}</text><title>{node.row.profile?.summary ?? node.row.genericSummary}</title></g>; })}
    </svg></div>
    <fieldset className="lineage-topology-records" aria-label="Topology record previews">{nodes.map((node) => <button type="button" key={node.ref.ordinal}
      onClick={() => onPreview(node.row)}>Preview #{node.ref.ordinal}</button>)}</fieldset>
  </dialog>;
}
