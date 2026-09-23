import React, { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  Activity,
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FileWarning,
  FileText,
  FlaskConical,
  Flag,
  GitCommitHorizontal,
  ListTodo,
  LoaderCircle,
  MessageSquare,
  Eye,
  Play,
  Wrench,
} from 'lucide-react';
import type { ColumnSpec, FieldStats, RecordRef, RowProjection } from '../shared/types';
import { columnGridTemplate, formatCell, getColumnText, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from './format';
import type { VisibleProblem } from './state';

interface EmptyStateProps {
  icon?: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  title: string;
  detail?: string;
}

export function EmptyState({ icon: Icon = Braces, title, detail }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="empty-state" role="status">
      <Icon size={22} aria-hidden />
      <div className="empty-title">{title}</div>
      {detail ? <div className="empty-detail">{detail}</div> : null}
    </div>
  );
}

interface TimelineViewProps {
  rows: RowProjection[];
  selectedOrdinal?: string | undefined;
  onSelect: (ref: RecordRef) => void;
}

function eventIcon(kind: string): React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }> {
  if (kind === 'tool_call' || kind === 'tool_result') return Wrench;
  if (kind === 'error') return CircleAlert;
  if (kind === 'message') return MessageSquare;
  if (kind === 'log') return FileText;
  if (kind === 'span') return Activity;
  if (kind === 'task') return ListTodo;
  if (kind === 'action') return Play;
  if (kind === 'observation') return Eye;
  if (kind === 'patch') return GitCommitHorizontal;
  if (kind === 'test') return FlaskConical;
  if (kind === 'result') return Flag;
  return Bot;
}

export function TimelineView({ rows, selectedOrdinal, onSelect }: TimelineViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => rows[index]?.ref.ordinal ?? index,
  });

  if (rows.length === 0) {
    return <EmptyState icon={Bot} title="No semantic events in this page" detail="Choose a semantic profile or load another page." />;
  }

  return (
    <div className="timeline-scroll" ref={scrollRef} role="list" aria-label="Event timeline">
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row?.profile) return null;
          const Icon = eventIcon(row.profile.eventKind);
          return (
            <button
              type="button"
              className={`timeline-row${row.ref.ordinal === selectedOrdinal ? ' is-selected' : ''}`}
              role="listitem"
              key={row.ref.ordinal}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              onClick={() => onSelect(row.ref)}
            >
              <span className="timeline-icon"><Icon size={15} aria-hidden /></span>
              <span className="timeline-main">
                <span className="timeline-meta">
                  <span className="event-kind">{row.profile.eventKind.replaceAll('_', ' ')}</span>
                  <span>{row.profile.actor ?? 'unknown'}</span>
                  {row.profile.status ? <span>{row.profile.status}</span> : null}
                </span>
                <span className="timeline-summary">{row.profile.summary}</span>
              </span>
              <span className="timeline-time">{row.profile.timestamp ?? `#${row.ref.ordinal}`}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SchemaViewProps {
  fields: FieldStats[];
  total: number;
  loading: boolean;
}

interface SchemaTreeNode {
  id: string;
  label: string;
  depth: number;
  children: SchemaTreeNode[];
  field?: FieldStats | undefined;
}

interface VisibleSchemaNode extends SchemaTreeNode {
  expanded: boolean;
}

export function buildSchemaTree(fields: FieldStats[]): SchemaTreeNode {
  const root: SchemaTreeNode = { id: '$', label: '$', depth: 0, children: [] };
  const nodes = new Map<string, SchemaTreeNode>([['$', root]]);
  for (const field of fields) {
    let parent = root;
    for (const token of field.path.tokens) {
      const tokenLabel = token.kind === 'index' ? `[${String(token.value)}]` : String(token.value);
      const id = `${parent.id}/${token.kind}:${encodeURIComponent(String(token.value))}`;
      let node = nodes.get(id);
      if (!node) {
        node = { id, label: tokenLabel, depth: parent.depth + 1, children: [] };
        nodes.set(id, node);
        parent.children.push(node);
      }
      parent = node;
    }
    parent.field = field;
  }
  return root;
}

export function visibleSchemaNodes(root: SchemaTreeNode, expanded: ReadonlySet<string>): VisibleSchemaNode[] {
  const rows: VisibleSchemaNode[] = [];
  const visit = (node: SchemaTreeNode): void => {
    const isExpanded = expanded.has(node.id);
    rows.push({ ...node, expanded: isExpanded });
    if (!isExpanded) return;
    for (const child of node.children) visit(child);
  };
  visit(root);
  return rows;
}

export function SchemaView({ fields, total, loading }: SchemaViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set(['$']));
  const root = useMemo(() => buildSchemaTree(fields), [fields]);
  const rows = useMemo(() => visibleSchemaNodes(root, expanded), [expanded, root]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 34,
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  if (fields.length === 0) {
    return loading
      ? <EmptyState icon={LoaderCircle} title="Loading schema" />
      : <EmptyState title="No schema fields indexed" />;
  }

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="schema-scroll" ref={scrollRef} role="treegrid" aria-label="Observed JSON schema tree" aria-rowcount={total}>
      <div className="schema-tree-header" role="row">
        <div role="columnheader">Path</div>
        <div role="columnheader">Kinds</div>
        <div role="columnheader">Seen</div>
        <div role="columnheader">Missing / null</div>
        <div role="columnheader">Confidence</div>
      </div>
      <div className="virtual-space schema-tree-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const field = row.field;
          const kinds = field ? Object.entries(field.kinds)
            .map(([kind, count]) => `${kind} ${count}`)
            .join(', ') : row.children.length ? `object ${row.children.length} fields` : 'object';
          const confidence = field?.confidence;
          return (
            <div
              className="schema-tree-row"
              role="row"
              aria-level={row.depth + 1}
              aria-expanded={row.children.length ? row.expanded : undefined}
              key={row.id}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <div role="gridcell" className="schema-tree-path" style={{ paddingLeft: row.depth * 16 }} title={field?.displayPath ?? row.label}>
                {row.children.length ? (
                  <button
                    type="button"
                    className="schema-tree-toggle"
                    aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.label}`}
                    aria-expanded={row.expanded}
                    onClick={() => toggle(row.id)}
                  >
                    {row.expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                  </button>
                ) : <span className="schema-tree-toggle-spacer" aria-hidden />}
                <span className="schema-tree-label">{row.label}</span>
              </div>
              <div role="gridcell" className="ellipsis" title={kinds}>{kinds}</div>
              <div role="gridcell">{field?.seenRecords ?? '-'}</div>
              <div role="gridcell">{field ? `${field.missingRecords} / ${field.nullRecords}` : '-'}</div>
              <div role="gridcell">{confidence ? <span className={`confidence confidence-${confidence}`}>{confidence}</span> : <span className="schema-tree-derived">derived</span>}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ProblemsViewProps {
  problems: VisibleProblem[];
  onSelectOrdinal: (ordinal: string) => void;
  complete?: boolean;
  hasAfter?: boolean;
  onContinue?: () => void;
  loading?: boolean;
}

function ProblemIcon({ severity }: { severity: VisibleProblem['severity'] }): React.JSX.Element {
  if (severity === 'error') return <CircleAlert size={15} aria-hidden />;
  if (severity === 'warning') return <AlertTriangle size={15} aria-hidden />;
  return <CircleCheck size={15} aria-hidden />;
}

export function ProblemsView({ problems, onSelectOrdinal, complete, hasAfter, onContinue, loading }: ProblemsViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: problems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 42,
    overscan: 10,
    getItemKey: (index) => `${problems[index]?.ordinal ?? 'document'}:${problems[index]?.code ?? index}:${index}`,
  });

  if (problems.length === 0) {
    return (
      <div className="problems-view">
        {!complete && hasAfter && onContinue ? (
          <div className="workspace-banner" role="status">
            <AlertTriangle size={15} aria-hidden />
            <span>{loading ? 'Scanning the next problem window…' : 'No problems in this window; more of the file remains to scan.'}</span>
            <button type="button" onClick={onContinue} disabled={loading}>Continue scan</button>
          </div>
        ) : null}
        <EmptyState
          icon={FileWarning}
          title={loading ? 'Scanning problems…' : 'No problems found in the bounded scan'}
          detail="The status strip reports problem records observed during hydration for this generation; it is not a complete-file problem index."
        />
      </div>
    );
  }

  return (
    <div className="problems-view">
      {!complete ? (
        <div className="workspace-banner" role="status">
          <AlertTriangle size={15} aria-hidden />
          <span>Problem scan is partial; the entries below are not a complete-file result.</span>
          {hasAfter && onContinue ? <button type="button" onClick={onContinue} disabled={loading}>Continue scan</button> : null}
        </div>
      ) : null}
      <div className="problems-scroll" ref={scrollRef} role="list" aria-label="JSONL problems">
      <div className="virtual-space" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const problem = problems[item.index];
          if (!problem) return null;
          return (
            <button
              type="button"
              className={`problem-row severity-${problem.severity}`}
              role="listitem"
              key={`${problem.ordinal ?? 'document'}:${problem.code}:${item.index}`}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              disabled={!problem.ordinal}
              onClick={() => problem.ordinal && onSelectOrdinal(problem.ordinal)}
            >
              <ProblemIcon severity={problem.severity} />
              <span className="problem-code">{problem.code}</span>
              <span className="problem-message">{problem.message}</span>
              <span className="problem-ordinal">{problem.ordinal ? `#${problem.ordinal}` : 'document'}</span>
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}

export function fallbackColumns(rows: RowProjection[]): ColumnSpec[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const cell of row.cells) ids.add(cell.columnId);
  }
  return [...ids].slice(0, 8).map((id) => ({ id, label: id, source: 'record' }));
}

export function getCellPreview(row: RowProjection): string {
  return row.cells.map((cell) => formatCell(cell)).filter(Boolean).join(' ');
}
