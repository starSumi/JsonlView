import { useMemo } from 'react';
import type React from 'react';
import type { DatasetSampleSummary } from '@shared/dataset-analysis';
import type { BfclV3SampleSummary } from '@shared/bfcl-v3-insights';
import type { OpenTelemetrySampleSummary } from '@shared/otel-insights';
import type {
  ColumnSpec,
  InsightDimension,
  InsightScope,
  RecordRef,
  RowProjection,
} from '@shared/types';
import { InsightsPanel } from '@widgets/insights-panel';
import { DetailDrawer } from '@widgets/detail-drawer';
import {
  RecordQueryBanner,
  RecordTable,
} from '@features/record-query';
import type { GridFocusBridge } from '@features/record-query/RecordTable';
import type { RevealMessage } from '@features/record-query/reveal-controller';
import { WorkspacePageControls } from './WorkspacePageControls';
import type { DetailSplitterHandlers } from '@features/detail-splitter';
import type { VisibleProblem, WorkspaceState, WorkspaceTab, DetailTab } from '@webview/state';
import { ProblemsView, SchemaView, TimelineView } from '@webview/views';
import { projectRecordLineage } from '@features/record-lineage/model';
import type { LineageViewProps } from '@features/record-lineage/LineageView';

export interface WorkspaceSurfaceProps {
  lineageRows?: readonly RowProjection[] | undefined;
  lineageControls?: Omit<LineageViewProps, 'projection' | 'unavailableReason' | 'onSelectRecord'> | undefined;
  onSelectLineageRecord?: ((ref: RecordRef) => void) | undefined;
  lineageNotice?: string | undefined;
  revealTarget?: RevealMessage | undefined;
  onRevealRendered?: ((requestId: string, ordinal: string) => void) | undefined;
  state: WorkspaceState;
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  workspaceStyle: React.CSSProperties | undefined;
  getPanelProps: (id: WorkspaceTab) => React.HTMLAttributes<HTMLElement>;
  clientDocumentId: string;
  tableColumns: ColumnSpec[];
  partialBannerIdentity: string | undefined;
  timelineRows: RowProjection[];
  problemEntries: VisibleProblem[];
  gridFocusBridgeRef: React.MutableRefObject<GridFocusBridge | undefined>;
  showPrimaryInsights: boolean;
  showInsightsTransitionStatus: boolean;
  showRowsProjectionFailure: boolean;
  showBfclInsights: boolean;
  showOpenTelemetryInsights: boolean;
  snapshotReadable: boolean;
  datasetSummary: DatasetSampleSummary | undefined;
  datasetProjectionAvailable: boolean;
  bfclSummary: BfclV3SampleSummary | undefined;
  opentelemetrySummary: OpenTelemetrySampleSummary | undefined;
  insightsRequestError: string | undefined;
  showPageControls: boolean;
  canAdvancePage: boolean;
  pageInput: string;
  pageRange: string;
  drawerOpen: boolean;
  overlayDetail: boolean;
  drawerId: string;
  displayedDetailWidth: number;
  detailWidthMin: number;
  detailWidthMax: number;
  detailWidthText: string;
  detailSplitter: DetailSplitterHandlers;
  onRequestDetail: (ref: RecordRef, full?: boolean, select?: boolean) => void;
  onColumnWidthChange: (columnId: string, width: number | undefined) => void;
  onColumnOrderChange: (order: string[]) => void;
  onReadingAnchor: (ref?: RecordRef) => void;
  onViewportAnchor: (ref: RecordRef) => void;
  onTailVisible: (ref: RecordRef) => void;
  onManualTailVisible: (ref: RecordRef) => boolean;
  onReturnToLatest: () => void;
  onSelectProblem: (ordinal: string) => void;
  onContinueProblems: () => void;
  onRetryRows: () => void;
  onInsightDimensionChange: (dimension: InsightDimension) => void;
  onInsightScopeChange: (scope: InsightScope) => void;
  onInsightRefresh: () => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onJumpToPage: () => void;
  onPageInputFocus: () => void;
  onPageInputChange: (value: string) => void;
  onPageInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onPageInputBlur: () => void;
  onDetailTabChange: (tab: DetailTab) => void;
  onDetailInteraction: () => void;
  onRequestFull: () => void;
  onOpenRecordText?: () => void;
  onCloseDetail: () => void;
  onDetailDoubleClick: () => void;
}

/**
 * Presentation-only workspace body. App remains the owner of state, effects,
 * protocol clients, query controllers, hydration, and viewport transactions.
 */
export function WorkspaceSurface({
  lineageRows,
  lineageControls,
  onSelectLineageRecord,
  lineageNotice,
  revealTarget,
  onRevealRendered,
  state,
  workspaceRef,
  workspaceStyle,
  getPanelProps,
  clientDocumentId,
  tableColumns,
  partialBannerIdentity,
  timelineRows,
  problemEntries,
  gridFocusBridgeRef,
  showPrimaryInsights,
  showInsightsTransitionStatus,
  showRowsProjectionFailure,
  showBfclInsights,
  showOpenTelemetryInsights,
  snapshotReadable,
  datasetSummary,
  datasetProjectionAvailable,
  bfclSummary,
  opentelemetrySummary,
  insightsRequestError,
  showPageControls,
  canAdvancePage,
  pageInput,
  pageRange,
  drawerOpen,
  overlayDetail,
  drawerId,
  displayedDetailWidth,
  detailWidthMin,
  detailWidthMax,
  detailWidthText,
  detailSplitter,
  onRequestDetail,
  onColumnWidthChange,
  onColumnOrderChange,
  onReadingAnchor,
  onViewportAnchor,
  onTailVisible,
  onManualTailVisible,
  onReturnToLatest,
  onSelectProblem,
  onContinueProblems,
  onRetryRows,
  onInsightDimensionChange,
  onInsightScopeChange,
  onInsightRefresh,
  onPreviousPage,
  onNextPage,
  onJumpToPage,
  onPageInputFocus,
  onPageInputChange,
  onPageInputKeyDown,
  onPageInputBlur,
  onDetailTabChange,
  onDetailInteraction,
  onRequestFull,
  onOpenRecordText,
  onCloseDetail,
  onDetailDoubleClick,
}: WorkspaceSurfaceProps): React.JSX.Element {
  const lineageUnavailableReason = state.summary === undefined || state.page === undefined
    ? 'Lineage requires a current result page.'
    : !snapshotReadable
      ? 'The source changed. Rebuild the current page before viewing lineage.'
      : state.pending.rows || state.pending.profile
        ? 'Lineage is unavailable while the result page or profile is updating.'
        : showRowsProjectionFailure
          ? 'The current result page could not be projected.'
          : state.phase !== 'ready'
            ? 'Lineage is unavailable until the current result page is ready.'
            : state.rows.some((row) => row.ref.generation !== state.summary?.snapshot.generation)
              || (state.selectedRef !== undefined && state.selectedRef.generation !== state.summary.snapshot.generation)
                ? 'The page or selected record belongs to an older source snapshot.'
                : state.pageProjectionProfileId !== state.summary.profileId
                  ? 'The current result page was produced under a different profile.'
                : state.rows.some((row) => row.profile !== undefined && row.profile.profileId !== state.summary?.profileId)
                  ? 'The result page was produced under a different profile.'
                : state.selectedRef === undefined ? 'Select a record from the current result page.' : undefined;
  const lineage = useMemo(() => state.detailTab === 'lineage' && lineageUnavailableReason === undefined && state.selectedRef !== undefined
    ? projectRecordLineage(lineageRows ?? state.rows, state.selectedRef)
    : undefined, [lineageUnavailableReason, lineageRows, state.detailTab, state.rows, state.selectedRef]);
  return (
    <div
      ref={workspaceRef}
      className={`workspace${drawerOpen ? ' has-drawer' : ''}`}
      data-detail-layout={overlayDetail ? 'overlay' : 'docked'}
      style={workspaceStyle}
    >
      <section className="workspace-primary" aria-label={`${state.activeTab} view`}>
        <div {...getPanelProps('table')} className="workspace-tab-panel">
          {state.activeTab === 'table' ? <RecordQueryBanner scan={state.page?.scan} sort={state.sort} pageIdentity={partialBannerIdentity} /> : null}
          {state.activeTab === 'table' ? (
            <RecordTable
              revealTarget={revealTarget}
              onRevealRendered={onRevealRendered}
              sessionId={clientDocumentId}
              rows={state.rows}
              columns={tableColumns}
              displayMode={state.displayMode}
              selectedOrdinal={state.selectedOrdinal}
              loading={Boolean(state.pending.rows) || (state.summary === undefined && state.error === undefined)}
              emptyTitle={state.summary === undefined && state.error !== undefined ? 'Unable to open records' : undefined}
              onSelect={onRequestDetail}
              columnWidths={state.columnWidths}
              onColumnWidthChange={onColumnWidthChange}
              sort={state.sort ?? { columnId: '__ordinal', direction: 'asc' }}
              onColumnOrderChange={onColumnOrderChange}
              followMode={state.followMode}
              viewportMode={state.viewportMode}
              viewportRevision={state.viewportRevision}
              latestSeq={state.latestSeq}
              latestGeneration={state.summary?.snapshot.generation}
              gridFocusBridgeRef={gridFocusBridgeRef}
              onReadingAnchor={onReadingAnchor}
              onViewportAnchor={onViewportAnchor}
              onTailVisible={onTailVisible}
              onManualTailVisible={onManualTailVisible}
            />
          ) : null}
        </div>
        {state.followMode && (state.unseenActivity || state.viewportMode === 'reading') ? (
          <div className="new-activity" role="status">
            {state.unseenActivity ? <span>New activity</span> : null}
            <button type="button" onClick={onReturnToLatest}
              aria-label="Back to latest records"
              title="Show latest records and clear search and filters"
              disabled={Boolean(state.pending.rows) || !snapshotReadable}>
              {state.sort?.columnId === '__ordinal' && state.sort.direction === 'desc' ? '↑ Back to latest' : '↓ Back to bottom'}
            </button>
          </div>
        ) : null}
        <div {...getPanelProps('timeline')} className="workspace-tab-panel">
          {state.activeTab === 'timeline' ? (
            <TimelineView rows={timelineRows} selectedOrdinal={state.selectedOrdinal} onSelect={onRequestDetail} />
          ) : null}
        </div>
        <div {...getPanelProps('schema')} className="workspace-tab-panel">
          {state.activeTab === 'schema' ? (
            <SchemaView fields={state.schema} total={state.schemaTotal} loading={Boolean(state.pending.schema)} />
          ) : null}
        </div>
        <div {...getPanelProps('problems')} className="workspace-tab-panel">
          {state.activeTab === 'problems' ? (
            <ProblemsView
              problems={problemEntries}
              onSelectOrdinal={onSelectProblem}
              complete={state.problems?.complete ?? false}
              hasAfter={state.problems?.hasAfter ?? false}
              onContinue={onContinueProblems}
              loading={Boolean(state.pending.problems)}
            />
          ) : null}
        </div>
        <div {...getPanelProps('insights')} className="workspace-tab-panel">
          {state.activeTab === 'insights' ? (
            <InsightsPanel
              dimension={state.insightDimension}
              scope={state.insightScope}
              disabled={!snapshotReadable || Boolean(state.pending.profile)}
              pending={Boolean(state.pending.insights)}
              result={state.insights}
              aggregateError={insightsRequestError}
              showAggregates={showPrimaryInsights}
              projectionStatus={showRowsProjectionFailure ? 'failed' : showInsightsTransitionStatus ? 'pending' : undefined}
              bfclSummary={showBfclInsights ? bfclSummary : undefined}
              opentelemetrySummary={showOpenTelemetryInsights ? opentelemetrySummary : undefined}
              datasetSummary={datasetProjectionAvailable && !state.pending.rows
                && !showBfclInsights && !showOpenTelemetryInsights ? datasetSummary : undefined}
              onDimensionChange={onInsightDimensionChange}
              onScopeChange={onInsightScopeChange}
              onRefresh={onInsightRefresh}
              onRetryProjection={onRetryRows}
            />
          ) : null}
        </div>
        <WorkspacePageControls
          visible={showPageControls}
          busy={Boolean(state.pending.rows)}
          invalidated={!snapshotReadable}
          hasBefore={state.page?.hasBefore === true}
          canAdvance={canAdvancePage}
          pageInput={pageInput}
          pageRange={pageRange}
          onPrevious={onPreviousPage}
          onNext={onNextPage}
          onJump={onJumpToPage}
          onInputFocus={onPageInputFocus}
          onInputChange={onPageInputChange}
          onInputKeyDown={onPageInputKeyDown}
          onInputBlur={onPageInputBlur}
        />
      </section>
      {drawerOpen ? (
        <>
          {!overlayDetail ? (
            <>
              {/* biome-ignore lint/a11y/useSemanticElements: this separator is an interactive resize control, not a document rule */}
              <div
                className="detail-splitter"
                ref={detailSplitter.ref}
                role="separator"
                aria-label="Resize record detail"
                aria-orientation="vertical"
                aria-controls={drawerId}
                aria-valuemin={detailWidthMin}
                aria-valuemax={detailWidthMax}
                aria-valuenow={displayedDetailWidth}
                aria-valuetext={detailWidthText}
                tabIndex={0}
                title="Drag to resize detail"
                onPointerDown={detailSplitter.onPointerDown}
                onKeyDown={detailSplitter.onKeyDown}
                onDoubleClick={onDetailDoubleClick}
              />
            </>
          ) : null}
          <DetailDrawer
            id={drawerId}
            modal={overlayDetail}
            detail={state.detail}
            selectedRef={state.selectedRef}
            loading={Boolean(state.pending.detail)}
            readBlocked={state.detailStale || !snapshotReadable}
            blockedOrdinal={state.blockedDetailOrdinal}
            activeTab={state.detailTab}
            onTabChange={onDetailTabChange}
            onInteraction={onDetailInteraction}
            onRequestFull={onRequestFull}
            onOpenRecordText={onOpenRecordText}
            lineage={lineage}
            lineageUnavailableReason={lineageUnavailableReason}
            onSelectLineageRecord={onSelectLineageRecord ?? ((ref) => onRequestDetail(ref, false, true))}
            lineageControls={lineageControls}
            lineageNotice={lineageNotice}
            onClose={onCloseDetail}
          />
        </>
      ) : null}
    </div>
  );
}
