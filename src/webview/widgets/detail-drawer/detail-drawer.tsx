import type React from 'react';
import { Activity, useEffect, useMemo, useRef, useState } from 'react';
import { Braces, Code2, Database, FileText, GitBranch, LoaderCircle, X } from 'lucide-react';
import type { RecordDetail, RecordRef } from '@shared/types';
import { AUTOMATIC_FULL_RECORD_LIMIT_BYTES } from '@webview/full-record-intent';
import { formatBytes } from '@webview/format';
import { CopyButton } from './copy-button';
import { RawJsonView } from './json-raw';
import { JsonCode, stringifyJsonBounded } from './json-syntax';
import { JsonTree } from './json-tree';
import { AgentEventPresentation } from './AgentEventPresentation';
import { recordPresentationKey, recordRefKey, sameRecordRef } from '@webview/record-identity';
import type { DetailTab } from '@webview/state';
import type { RecordLineageProjection } from '@features/record-lineage/model';
import { LineageView } from '@features/record-lineage/LineageView';
import type { LineageViewProps } from '@features/record-lineage/LineageView';
import { useManualTabs } from '@webview/shared/hooks/use-manual-tabs';
import { useModalFocus } from '@webview/shared/hooks/use-modal-focus';

interface DetailDrawerProps {
  id?: string;
  modal?: boolean;
  detail?: RecordDetail | undefined;
  selectedRef?: RecordRef | undefined;
  loading: boolean;
  readBlocked?: boolean;
  blockedOrdinal?: string | undefined;
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onRequestFull: () => void;
  onOpenRecordText?: (() => void) | undefined;
  lineage?: RecordLineageProjection | undefined;
  lineageUnavailableReason?: string | undefined;
  onSelectLineageRecord?: ((ref: RecordRef) => void) | undefined;
  lineageControls?: Omit<LineageViewProps, 'projection' | 'unavailableReason' | 'onSelectRecord'> | undefined;
  lineageNotice?: string | undefined;
  onInteraction?: () => void;
  onClose: () => void;
}

export type NavigatorBridgeState = 'disabled' | 'authorization-required' | 'authorized' | 'cancelled' | 'failed';

function UnavailableRecordView({ detail, loading, readBlocked, onRequestFull }: { detail: RecordDetail; loading: boolean; readBlocked: boolean; onRequestFull: () => void }): React.JSX.Element {
  const automaticFullLimitMiB = AUTOMATIC_FULL_RECORD_LIMIT_BYTES / (1024 * 1024);
  const previewMessage = detail.rawComplete
    ? 'The record could not be parsed into a structured value.'
    : 'Only a bounded source preview is available; the structured value was not hydrated.';
  return (
    <div className="detail-unavailable" role="status">
      <strong>Structured view unavailable</strong>
      <span>{previewMessage}</span>
      <span>Parse state: {detail.ref.parseState}</span>
      {!detail.rawComplete ? (
        <>
          <span>Use Raw to inspect or copy the available source preview.</span>
          {readBlocked
            ? <span>The source changed; select Rebuild before requesting the full record.</span>
            : <button type="button" className="event-section-action" disabled={loading} onClick={onRequestFull}>
                {loading ? 'Loading full record...' : 'Show full record'}
              </button>}
          <span>
            The initial source preview uses <code>jsonlView.hydration.maxBytes</code>.
            Opening a selected truncated record automatically tries a one-record full load up to {automaticFullLimitMiB} MiB.
            The <code>jsonlView.hydration.fullMaxBytes</code> limit still applies.
          </span>
        </>
      ) : null}
    </div>
  );
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
  { id: 'lineage', label: 'Lineage', icon: GitBranch },
];

export const DETAIL_ACTIVITY_RECORD_BUDGET_BYTES = 1024 * 1024;

export function shouldPreserveDetailTabState(detail: RecordDetail | undefined): boolean {
  if (detail === undefined) return true;
  if (!/^(0|[1-9]\d*)$/.test(detail.ref.contentByteLength)) return false;
  return BigInt(detail.ref.contentByteLength) <= BigInt(DETAIL_ACTIVITY_RECORD_BUDGET_BYTES);
}

export function DetailDrawer({ id = 'record-detail', modal = false, detail, selectedRef, loading, readBlocked = false, blockedOrdinal, activeTab, onTabChange, onRequestFull, onOpenRecordText, lineage, lineageUnavailableReason, onSelectLineageRecord, lineageControls, lineageNotice, onInteraction, onClose }: DetailDrawerProps): React.JSX.Element {
  "use memo";
  const drawerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const activeRef = selectedRef ?? detail?.ref;
  const presentationKey = activeRef ? recordPresentationKey(activeRef) : 'loading';
  // Keep tab content lazy until first activation. Activity then preserves the
  // mounted tab's local state while its panel is hidden, without keeping the
  // whole drawer alive after App closes it.
  const [visitedState, setVisitedState] = useState<{ key: string; tabs: ReadonlySet<DetailTab> }>(() => ({
    key: presentationKey,
    tabs: new Set([activeTab]),
  }));
  const visitedTabs = visitedState.key === presentationKey ? visitedState.tabs : new Set<DetailTab>([activeTab]);
  useEffect(() => {
    setVisitedState((current) => {
      if (current.key !== presentationKey) return { key: presentationKey, tabs: new Set([activeTab]) };
      return current.tabs.has(activeTab) ? current : { key: presentationKey, tabs: new Set([...current.tabs, activeTab]) };
    });
  }, [activeTab, presentationKey]);
  const activateTab = (tab: DetailTab): void => {
    setVisitedState((current) => {
      const base = current.key === presentationKey ? current.tabs : new Set<DetailTab>([activeTab]);
      return base.has(tab) && current.key === presentationKey
        ? current
        : { key: presentationKey, tabs: base.has(tab) ? base : new Set([...base, tab]) };
    });
    onTabChange(tab);
  };
  const tabs = useManualTabs({ ids: detailTabs.map((tab) => tab.id), activeId: activeTab,
    onActivate: activateTab, idPrefix: `${id}-views` });
  useModalFocus({ modal, dialogRef: drawerRef, initialFocusRef: titleRef, onClose });
  // A late response can cross the host boundary after selection changes. The
  // reducer rejects it, but keep the drawer fail-closed if a caller races the
  // state update: never render one record under another record's header.
  const detailMatchesSelection = selectedRef === undefined
    || detail === undefined
    || sameRecordRef(detail.ref, selectedRef)
    || (readBlocked && sameRecordRef({ ...detail.ref, generation: selectedRef.generation }, selectedRef));
  const visibleDetail = detailMatchesSelection ? detail : undefined;
  const preserveTabState = shouldPreserveDetailTabState(visibleDetail);
  const derived = visibleDetail?.profile ? stringifyJsonBounded(visibleDetail.profile) : undefined;
  const recordKey = activeRef ? recordRefKey(activeRef) : 'loading';
  const drawerA11y = modal
    ? { role: 'dialog' as const, 'aria-modal': true as const, 'aria-labelledby': `${id}-title` }
    : { 'aria-label': 'Record detail' };
  const keyedProblems = useMemo(() => {
    const occurrences = new Map<string, number>();
    return (visibleDetail?.problems ?? []).map((problem) => {
      const baseKey = `${problem.code}:${problem.severity}:${problem.message}`;
      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);
      return { key: `${baseKey}:${occurrence}`, problem };
    });
  }, [visibleDetail?.problems]);
  const renderTabBody = (tabId: DetailTab): React.JSX.Element | null => {
    if (tabId === 'lineage') return <LineageView {...lineageControls} projection={lineage} unavailableReason={lineageUnavailableReason} onSelectRecord={onSelectLineageRecord} />;
    if (visibleDetail === undefined) return null;
    if (tabId === 'tree') {
      return (
        <>
          {visibleDetail.value !== undefined
            ? <AgentEventPresentation key={`preview:${presentationKey}`} value={visibleDetail.value} profile={visibleDetail.profile} autoExpandFirstFullSection />
            : null}
          {visibleDetail.value !== undefined
            ? <JsonTree key={`tree:${presentationKey}`} value={visibleDetail.value} />
            : <UnavailableRecordView detail={visibleDetail} loading={loading} readBlocked={readBlocked} onRequestFull={onRequestFull} />}
        </>
      );
    }
    if (tabId === 'raw') {
      return (
        <div className="code-pane">
          <RawJsonView
            key={presentationKey}
            source={visibleDetail.rawPreview}
            rawComplete={visibleDetail.rawComplete}
            parseState={visibleDetail.ref.parseState}
          />
        </div>
      );
    }
    if (tabId === 'derived') {
      return visibleDetail.profile && derived
        ? <div className="code-pane">
            {derived.truncated ? <div className="bounded-notice">Derived JSON was bounded for display</div> : null}
            <JsonCode source={derived.text} ariaLabel="Derived semantic JSON syntax preview" collapsible />
          </div>
        : <div className="detail-empty">No semantic projection for this record.</div>;
    }
    return (
      <dl className="byte-facts">
        <dt>Ordinal</dt><dd>{visibleDetail.ref.ordinal}</dd>
        <dt>Start</dt><dd>{visibleDetail.ref.byteStart}</dd>
        <dt>End exclusive</dt><dd>{visibleDetail.ref.byteEndExclusive}</dd>
        <dt>Content length</dt><dd>{visibleDetail.ref.contentByteLength}</dd>
        <dt>Delimiter length</dt><dd>{visibleDetail.ref.delimiterByteLength}</dd>
        <dt>Parse state</dt><dd>{visibleDetail.ref.parseState}</dd>
        <dt>Generation</dt><dd>{visibleDetail.ref.generation}</dd>
      </dl>
    );
  };

  return (
    <>
    {modal ? <div className="detail-backdrop" aria-hidden="true" /> : null}
    <aside ref={drawerRef} id={id} className={`detail-drawer${modal ? ' is-modal' : ''}`}
      {...drawerA11y} tabIndex={-1} onPointerDownCapture={onInteraction}
      onWheelCapture={onInteraction} onKeyDownCapture={onInteraction}>
      <header className="detail-header">
        <div>
          <div ref={titleRef} id={`${id}-title`} className="detail-title" tabIndex={-1}>Record {activeRef ? `#${activeRef.ordinal}` : blockedOrdinal ? `#${blockedOrdinal}` : ''}</div>
          <div className="detail-subtitle">
            {visibleDetail ? `${formatBytes(visibleDetail.ref.contentByteLength)} · ${visibleDetail.ref.parseState}` : blockedOrdinal ? 'Source changed' : 'Loading'}
          </div>
        </div>
        <div className="detail-header-actions">
          {visibleDetail && onOpenRecordText ? <button type="button" className="icon-button"
            title="Open record as read-only text (up to 1 MiB)" aria-label="Open record as read-only text"
            disabled={readBlocked || loading} onClick={onOpenRecordText}><FileText size={16} aria-hidden /></button> : null}
          {visibleDetail ? <CopyButton text={visibleDetail.rawPreview} label={readBlocked ? 'Copy cached snapshot preview (source changed)' : visibleDetail.rawComplete ? 'Copy record JSON' : 'Copy source preview'} /> : null}
          <button type="button" className="icon-button" title="Close detail" aria-label="Close detail" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      {lineageNotice ? <div className="lineage-drawer-notice" role="status">{lineageNotice}</div> : null}
      {activeTab !== 'lineage' && lineageControls?.returnRef !== undefined ? <button type="button" className="lineage-return" onClick={lineageControls.onBack}>
        Back to record #{lineageControls.returnRef.ordinal}</button> : null}
      {visibleDetail && readBlocked ? (
        <div className="detail-stale" role="status">
          Source changed. Showing cached detail from generation {visibleDetail.ref.generation}, not the current file. Copy uses this old snapshot; select Rebuild to refresh.
        </div>
      ) : null}
      {visibleDetail || !blockedOrdinal ? <nav {...tabs.tabListProps} className="detail-tabs" aria-label="Detail views">
        {detailTabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            className={activeTab === id ? 'is-active' : ''}
            {...tabs.getTabProps(id)}
            key={id}
          >
            <Icon size={14} aria-hidden />
            {label}
          </button>
        ))}
      </nav> : null}
      <div key={presentationKey} className="detail-content" data-record-ref={activeRef ? recordKey : undefined}>
        {blockedOrdinal && !visibleDetail ? (
          <div className="detail-unavailable" role="status">
            <strong>Record #{blockedOrdinal} unavailable</strong>
            <span>The source changed, so this record cannot be read from the previous snapshot. Select Rebuild to refresh the view.</span>
          </div>
        ) : null}
        {(!detailMatchesSelection || loading) && !visibleDetail ? (
          <div className="detail-loading"><LoaderCircle size={18} aria-hidden /> Loading record</div>
        ) : null}
        {visibleDetail || !blockedOrdinal ? detailTabs.map(({ id: tabId }) => (
          <div key={tabId} className="detail-tab-panel" {...tabs.getPanelProps(tabId)}>
            {visitedTabs.has(tabId)
              ? preserveTabState
                ? <Activity mode={activeTab === tabId ? 'visible' : 'hidden'}>{renderTabBody(tabId)}</Activity>
                : activeTab === tabId ? renderTabBody(tabId) : null
              : null}
          </div>
        )) : null}
        {keyedProblems.length ? (
          <section className="detail-problems" aria-label="Record problems">
            {keyedProblems.map(({ key, problem }) => (
              <div key={key} data-severity={problem.severity}>
                <strong>{problem.code}</strong>
                <span>{problem.message}</span>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </aside>
    </>
  );
}
