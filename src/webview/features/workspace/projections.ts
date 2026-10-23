import type { BfclV3SampleSummary } from '@shared/bfcl-v3-insights';
import { aggregateBfclV3Summaries } from '@profiles/datasets/bfcl-v3';
import type { ColumnSpec, DatasetRuntimeProvenanceV1, FieldStats, RowProjection } from '@shared/types';
import type { NavigatorBridgeResultV1 } from '@shared/protocol/navigator-bridge';
import { MAX_TABLE_COLUMNS } from '@shared/types';
import { legacyRowProjectionPlan, rowProjectionPlanCovers } from '@shared/row-projection';
import { summarizeVisibleDatasetRows } from '@webview/dataset-page-analysis';
import { visibleColumns } from '@webview/format';
import type { WorkspaceState, WorkspaceTab } from '@webview/state';
import { configuredRecordColumns, recordColumnOptions } from '../record-query/model';

export function projectionIntentKey(
  state: Pick<WorkspaceState, 'summary' | 'activeTab' | 'displayMode' | 'page' | 'query' | 'filters' | 'rowTypes' | 'sort'>,
  required: { conversation: boolean; dataset: boolean },
): string {
  const summary = state.summary;
  return [
    summary?.snapshot.generation ?? '',
    summary?.profileId ?? '',
    summary?.profileVersion ?? '',
    summary?.profileEpoch ?? '',
    state.activeTab,
    state.displayMode,
    state.page?.anchorOrdinal ?? '',
    state.page?.sortOffset ?? '',
    state.query,
    JSON.stringify(state.filters),
    JSON.stringify(state.rowTypes),
    JSON.stringify(state.sort),
    JSON.stringify(required),
  ].join('|');
}

export function navigatorUiState(result: NavigatorBridgeResultV1): 'disabled' | 'authorization-required' | 'authorized' | 'cancelled' | 'failed' {
  switch (result.status) {
    case 'opened': return 'authorized';
    case 'authorization-required':
    case 'authorization-pending': return 'authorization-required';
    case 'cancelled': return 'cancelled';
    case 'failed':
    case 'authorization-denied':
    case 'unknown': return 'failed';
    case 'disabled': return 'disabled';
  }
}

export function datasetProvenanceTooltip(provenance: DatasetRuntimeProvenanceV1): string {
  if (provenance.status === 'pending') return 'Dataset head sample pending';
  if ('terminal' in provenance) {
    const action = provenance.terminal.action === 'reload' ? 'Reload to retry.'
      : provenance.terminal.action === 'enable-auto-detection' ? 'Enable profile auto detection to sample.' : 'No action required.';
    return 'Dataset detection ' + provenance.status + ' at ' + provenance.terminal.stage + ': '
      + provenance.terminal.code + '. ' + action;
  }
  const coverage = provenance.coverage;
  return 'Dataset head sample: ' + provenance.adapterId + ' ' + provenance.adapterVersion + '; '
    + coverage.sampledRecords + ' records / ' + coverage.examinedBytes + ' bytes; confidence ' + provenance.confidence;
}

export function workspaceBaseColumns(columns: ColumnSpec[], rows: RowProjection[]): ColumnSpec[] {
  return columns.length > 0 ? columns : fallbackColumns(rows);
}

export function selectedRecordColumnIds(
  columns: readonly ColumnSpec[],
  schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>>,
): Set<string> {
  return new Set(configuredRecordColumns(columns, schema, visibility)?.map((column) => column.id) ?? []);
}

export function workspaceAvailableColumns(
  columns: readonly ColumnSpec[],
  schema: readonly FieldStats[],
  visibility: Readonly<Record<string, boolean>>,
): ColumnSpec[] {
  return recordColumnOptions(columns, schema, visibility);
}

export function workspaceRecordColumnLimit(columns: readonly ColumnSpec[]): number {
  return Math.max(0, MAX_TABLE_COLUMNS - columns.filter((column) => column.source === 'profile').length);
}

export function workspaceTableColumns(
  columns: ColumnSpec[],
  visibility: Record<string, boolean>,
  order: readonly string[],
): ColumnSpec[] {
  return visibleColumns(columns, visibility, order);
}

export function workspacePartialScan(page: WorkspaceState['page']): boolean {
  return page?.scan?.truncatedReason !== undefined;
}

export function workspaceDatasetSummary(rows: readonly RowProjection[], partial: boolean) {
  return summarizeVisibleDatasetRows(rows, partial);
}

export function workspaceBfclSummary(rows: readonly RowProjection[], partial: boolean): BfclV3SampleSummary | undefined {
  const samples = rows.slice(0, 256).flatMap((row) => row.datasetInsights?.bfclV3 === undefined ? [] : [row.datasetInsights.bfclV3]);
  if (samples.length === 0) return undefined;
  return aggregateBfclV3Summaries(samples, {
    partial: partial || samples.length !== rows.length,
    requestedRecords: rows.length,
  });
}

export function workspaceDatasetProjectionAvailable(
  page: Pick<WorkspaceState, 'page' | 'pageProjectionProfileId' | 'summary'>,
): boolean {
  return page.page !== undefined && rowProjectionPlanCovers(
    page.page.projection ?? legacyRowProjectionPlan(page.pageProjectionProfileId ?? page.summary?.profileId),
    { conversation: false, dataset: true },
  );
}

export function workspaceHasPartialContinuation(
  partialScan: boolean,
  sort: WorkspaceState['sort'],
  page: WorkspaceState['page'],
): boolean {
  return partialScan && (sort !== undefined || page?.scan?.cursorOrdinal !== undefined);
}

export function workspacePartialBannerIdentity(page: WorkspaceState['page']): string | undefined {
  if (page === undefined) return undefined;
  return [
    page.anchorOrdinal,
    page.sortOffset ?? '',
    page.sortNextOffset ?? '',
    page.scan?.cursorOrdinal ?? '',
    page.scan?.examinedRecords ?? '',
    page.scan?.truncatedReason ?? '',
  ].join('|');
}

export function workspacePageRange(rows: readonly RowProjection[]): string {
  return rows.length > 0
    ? 'Rows #' + rows[0]?.ref.ordinal + '-#' + rows.at(-1)?.ref.ordinal
    : rows.length + ' rows';
}

export function workspaceShowsPageControls(
  activeTab: WorkspaceTab,
  rows: readonly RowProjection[],
  page: WorkspaceState['page'],
  hasPartialContinuation: boolean,
): boolean {
  return (activeTab === 'table' || activeTab === 'timeline')
    && (
      rows.length > 0
      || page?.hasBefore === true
      || page?.hasAfter === true
      || hasPartialContinuation
    );
}

export function fallbackColumns(rows: readonly RowProjection[]): ColumnSpec[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const cell of row.cells) ids.add(cell.columnId);
  }
  return [...ids].slice(0, 8).map((id) => ({ id, label: id, source: 'record' }));
}
