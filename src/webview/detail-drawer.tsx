import type React from 'react';
import { useMemo, useRef } from 'react';
import { Braces, Code2, Database, GitBranch, LoaderCircle, X } from 'lucide-react';
import type { RecordDetail, RecordRef } from '../shared/types';
import { AUTOMATIC_FULL_RECORD_LIMIT_BYTES } from './full-record-intent';
import { formatBytes } from './format';
import { CopyButton } from './copy-button';
import { RawJsonView } from './json-raw';
import { JsonCode, stringifyJsonBounded } from './json-syntax';
import { JsonTree } from './json-tree';
import { AgentEventPresentation } from './event-presentation';
import { recordPresentationKey, recordRefKey, sameRecordRef } from './record-identity';
import type { DetailTab } from './state';
import { useManualTabs } from './use-manual-tabs';
import { useModalFocus } from './use-modal-focus';

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
  onInteraction?: () => void;
  /** Reuses the existing top-level Open Navigator command; never opens a parallel route. */
  onOpenNavigator?: () => void;
  navigatorState?: NavigatorBridgeState;
  onClose: () => void;
}

export type NavigatorBridgeState = 'disabled' | 'authorization-required' | 'authorized' | 'cancelled' | 'failed';

function navigatorBridgeCopy(state: NavigatorBridgeState): { title: string; message: string; action: string } {
  switch (state) {
    case 'authorized':
      return { title: 'Navigator 已授权', message: '使用顶部 Open Navigator 的同一命令定位对应来源或会话；不会重复请求授权。', action: '定位左侧 Navigator' };
    case 'authorization-required':
      return { title: '需要一次授权', message: 'Navigator 已打开或正在打开。请在左侧确认只读来源范围；取消不会改变当前记录。', action: '打开 Navigator 设置' };
    case 'cancelled':
      return { title: '授权已取消', message: '当前记录和直接打开 JSONL 的主路径保持可用；没有启动扫描或修改配置。', action: '重新打开 Navigator' };
    case 'failed':
      return { title: 'Navigator 暂时不可用', message: '授权或索引失败已隔离。可重试或继续查看当前记录，不会清空其他 editor。', action: '重试 Navigator' };
    case 'disabled':
    default:
      return { title: '打开 Navigator', message: '从左侧打开 Navigator，再按需完成一次只读授权；这不会替换当前记录详情。', action: '打开 Navigator' };
  }
}

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
];

export function DetailDrawer({ id = 'record-detail', modal = false, detail, selectedRef, loading, readBlocked = false, blockedOrdinal, activeTab, onTabChange, onRequestFull, onInteraction, onOpenNavigator, navigatorState = 'disabled', onClose }: DetailDrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const tabs = useManualTabs({ ids: detailTabs.map((tab) => tab.id), activeId: activeTab,
    onActivate: onTabChange, idPrefix: `${id}-views` });
  useModalFocus({ modal, dialogRef: drawerRef, initialFocusRef: titleRef, onClose });
  // A late response can cross the host boundary after selection changes. The
  // reducer rejects it, but keep the drawer fail-closed if a caller races the
  // state update: never render one record under another record's header.
  const detailMatchesSelection = selectedRef === undefined
    || detail === undefined
    || sameRecordRef(detail.ref, selectedRef)
    || (readBlocked && sameRecordRef({ ...detail.ref, generation: selectedRef.generation }, selectedRef));
  const visibleDetail = detailMatchesSelection ? detail : undefined;
  const derived = useMemo(
    () => visibleDetail?.profile ? stringifyJsonBounded(visibleDetail.profile) : undefined,
    [visibleDetail?.profile],
  );
  const activeRef = selectedRef ?? detail?.ref;
  const recordKey = activeRef ? recordRefKey(activeRef) : 'loading';
  const presentationKey = activeRef ? recordPresentationKey(activeRef) : 'loading';
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
  const navigatorCopy = navigatorBridgeCopy(navigatorState);

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
          {visibleDetail ? <CopyButton text={visibleDetail.rawPreview} label={readBlocked ? 'Copy cached snapshot preview (source changed)' : visibleDetail.rawComplete ? 'Copy record JSON' : 'Copy source preview'} /> : null}
          <button type="button" className="icon-button" title="Close detail" aria-label="Close detail" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
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
        {visibleDetail && activeTab === tabId && tabId === 'tree' ? (
          <>
            {visibleDetail.value !== undefined
              ? <AgentEventPresentation key={`preview:${presentationKey}`} value={visibleDetail.value} profile={visibleDetail.profile} autoExpandFirstFullSection />
              : null}
            {visibleDetail.value !== undefined
              ? <JsonTree key={`tree:${presentationKey}`} value={visibleDetail.value} />
              : <UnavailableRecordView detail={visibleDetail} loading={loading} readBlocked={readBlocked} onRequestFull={onRequestFull} />}
          </>
        ) : null}
        {visibleDetail && activeTab === tabId && tabId === 'raw' ? (
          <div className="code-pane">
            <RawJsonView
              key={presentationKey}
              source={visibleDetail.rawPreview}
              rawComplete={visibleDetail.rawComplete}
              parseState={visibleDetail.ref.parseState}
            />
          </div>
        ) : null}
        {visibleDetail && activeTab === tabId && tabId === 'derived' ? (
          visibleDetail.profile && derived
            ? <div className="code-pane">
                {derived.truncated ? <div className="bounded-notice">Derived JSON was bounded for display</div> : null}
                <JsonCode source={derived.text} ariaLabel="Derived semantic JSON syntax preview" collapsible />
              </div>
            : <div className="detail-empty">No semantic projection for this record.</div>
        ) : null}
        {visibleDetail && activeTab === tabId && tabId === 'bytes' ? (
          <dl className="byte-facts">
            <dt>Ordinal</dt><dd>{visibleDetail.ref.ordinal}</dd>
            <dt>Start</dt><dd>{visibleDetail.ref.byteStart}</dd>
            <dt>End exclusive</dt><dd>{visibleDetail.ref.byteEndExclusive}</dd>
            <dt>Content length</dt><dd>{visibleDetail.ref.contentByteLength}</dd>
            <dt>Delimiter length</dt><dd>{visibleDetail.ref.delimiterByteLength}</dd>
            <dt>Parse state</dt><dd>{visibleDetail.ref.parseState}</dd>
            <dt>Generation</dt><dd>{visibleDetail.ref.generation}</dd>
          </dl>
        ) : null}
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
        {onOpenNavigator && (visibleDetail !== undefined || selectedRef !== undefined || blockedOrdinal !== undefined) ? (
          <section className={'navigator-bridge navigator-bridge-' + navigatorState} aria-label="Open Navigator bridge">
            <strong>{navigatorCopy.title}</strong>
            <span>{navigatorCopy.message}</span>
            <button type="button" className="event-section-action" onClick={onOpenNavigator}>{navigatorCopy.action}</button>
            <small>与顶部 Open Navigator 共用 Host command；授权状态由 Host 读回。</small>
          </section>
        ) : null}
      </div>
    </aside>
    </>
  );
}
