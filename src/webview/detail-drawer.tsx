import React, { useMemo } from 'react';
import { Braces, Code2, Database, GitBranch, LoaderCircle, X } from 'lucide-react';
import type { RecordDetail } from '../shared/types';
import { formatBytes } from './format';
import { CopyButton } from './copy-button';
import { RawJsonView } from './json-raw';
import { JsonCode, stringifyJsonBounded } from './json-syntax';
import { JsonTree } from './json-tree';
import { AgentEventPresentation } from './event-presentation';
import type { DetailTab } from './state';

interface DetailDrawerProps {
  detail?: RecordDetail | undefined;
  loading: boolean;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onClose: () => void;
}

const detailTabs: Array<{
  id: DetailTab;
  label: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}> = [
  { id: 'tree', label: 'Tree', icon: GitBranch },
  { id: 'raw', label: 'Raw', icon: Code2 },
  { id: 'derived', label: 'Derived', icon: Braces },
  { id: 'bytes', label: 'Bytes', icon: Database },
];

export function DetailDrawer({ detail, loading, activeTab, onTabChange, onClose }: DetailDrawerProps): React.JSX.Element {
  const derived = useMemo(
    () => detail?.profile ? stringifyJsonBounded(detail.profile) : undefined,
    [detail?.profile],
  );

  return (
    <aside className="detail-drawer" aria-label="Record detail">
      <header className="detail-header">
        <div>
          <div className="detail-title">Record {detail ? `#${detail.ref.ordinal}` : ''}</div>
          <div className="detail-subtitle">
            {detail ? `${formatBytes(detail.ref.contentByteLength)} · ${detail.ref.parseState}` : 'Loading'}
          </div>
        </div>
        <div className="detail-header-actions">
          {detail ? <CopyButton text={detail.rawPreview} label="Copy record JSON" /> : null}
          <button type="button" className="icon-button" title="Close detail" aria-label="Close detail" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      <nav className="detail-tabs" aria-label="Detail views">
        {detailTabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            className={activeTab === id ? 'is-active' : ''}
            aria-selected={activeTab === id}
            key={id}
            onClick={() => onTabChange(id)}
          >
            <Icon size={14} aria-hidden />
            {label}
          </button>
        ))}
      </nav>
      <div className="detail-content">
        {loading && !detail ? (
          <div className="detail-loading"><LoaderCircle size={18} aria-hidden /> Loading record</div>
        ) : null}
        {detail && activeTab === 'tree' ? (
          <>
            <AgentEventPresentation
              value={detail.value}
              profile={detail.profile}
            />
            <JsonTree key={`${detail.ref.generation}:${detail.ref.ordinal}`} value={detail.value} />
          </>
        ) : null}
        {detail && activeTab === 'raw' ? (
          <div className="code-pane">
            <RawJsonView
              key={`${detail.ref.generation}:${detail.ref.ordinal}`}
              source={detail.rawPreview}
              rawComplete={detail.rawComplete}
              parseState={detail.ref.parseState}
            />
          </div>
        ) : null}
        {detail && activeTab === 'derived' ? (
          detail.profile && derived
            ? <div className="code-pane">
                {derived.truncated ? <div className="bounded-notice">Derived JSON was bounded for display</div> : null}
                <JsonCode source={derived.text} ariaLabel="Derived semantic JSON syntax preview" collapsible />
              </div>
            : <div className="detail-empty">No semantic projection for this record.</div>
        ) : null}
        {detail && activeTab === 'bytes' ? (
          <dl className="byte-facts">
            <dt>Ordinal</dt><dd>{detail.ref.ordinal}</dd>
            <dt>Start</dt><dd>{detail.ref.byteStart}</dd>
            <dt>End exclusive</dt><dd>{detail.ref.byteEndExclusive}</dd>
            <dt>Content length</dt><dd>{detail.ref.contentByteLength}</dd>
            <dt>Delimiter length</dt><dd>{detail.ref.delimiterByteLength}</dd>
            <dt>Parse state</dt><dd>{detail.ref.parseState}</dd>
            <dt>Generation</dt><dd>{detail.ref.generation}</dd>
          </dl>
        ) : null}
        {detail?.problems.length ? (
          <section className="detail-problems" aria-label="Record problems">
            {detail.problems.map((problem, index) => (
              <div key={`${problem.code}:${index}`} data-severity={problem.severity}>
                <strong>{problem.code}</strong>
                <span>{problem.message}</span>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
