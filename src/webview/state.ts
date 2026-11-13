import type {
  AnalysisIntentV1,
  ColumnSpec,
  DocumentSummary,
  ExtensionMessage,
  FieldStats,
  InsightDimension,
  InsightScope,
  InsightSummary,
  ProblemRef,
  ProblemPage,
  RecordDetail,
  RecordRef,
  RowFilter,
  RowPage,
  RowProjection,
  RowSort,
  SortDirection,
} from '@shared/types';
import type { NavigatorBridgeResultV1 } from '@shared/protocol/navigator-bridge';
import type { SourceRegistrationFactsV1 } from '@shared/protocol/source-registration';
import { analysisIntentEquals } from '@shared/analysis-intent';
import { normalizeSortOffset, normalizeSortOffsetHistory, normalizeSortPage } from './paging';
import { DEFAULT_DETAIL_WIDTH } from '@features/detail-splitter';
import { snapshotIdentityChanged } from './snapshot-identity';
import type { RowTypeSelection } from '@features/record-query/query-selection';
import { columnsAfterProfileChange } from '@features/record-query/model';
import { reconcileProfileQueryState } from '@features/record-query/profile-query-state';
import type { RequestKind, RequestState } from './shared/request-state';
export type { RequestKind, RequestState } from './shared/request-state';

export type WorkspaceTab = 'table' | 'timeline' | 'schema' | 'problems' | 'insights';
export type DetailTab = 'tree' | 'raw' | 'derived' | 'bytes' | 'lineage';
export type ViewportMode = 'following' | 'reading';
export type WorkspacePhase = 'booting' | 'loading' | 'ready' | 'invalidated' | 'degraded' | 'error';
interface RebuildDetailIntent {
  documentId: string;
  generation: string;
  epoch?: number;
  ref: RecordRef;
}

export interface WorkspaceError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface WorkspaceState {
  phase: WorkspacePhase;
  summary?: DocumentSummary | undefined;
  rows: RowProjection[];
  columns: ColumnSpec[];
  page?: Pick<RowPage, 'anchorOrdinal' | 'hasBefore' | 'hasAfter' | 'sort' | 'sortOffset' | 'sortNextOffset' | 'matchedRecords' | 'scan' | 'projection'> | undefined;
  /** Profile under which the retained result page was accepted. */
  pageProjectionProfileId?: string | undefined;
  problems?: ProblemPage | undefined;
  selectedOrdinal?: string | undefined;
  /** Complete identity for the selected physical record. */
  selectedRef?: RecordRef | undefined;
  detail?: RecordDetail | undefined;
  /** Explicit user intent for the detail drawer to remain open. */
  detailOpen: boolean;
  /** Retained for compatibility; details never advance without explicit selection. */
  detailFollow: boolean;
  schema: FieldStats[];
  schemaTotal: number;
  schemaComplete: boolean;
  insights?: InsightSummary | undefined;
  insightDimension: InsightDimension;
  insightScope: InsightScope;
  analysisIntentRevision: number;
  analysisIntent?: AnalysisIntentV1 | undefined;
  /** Stops automatic retries of these conditions; explicit Refresh may retry. */
  failedAnalysisIntent?: AnalysisIntentV1 | undefined;
  activeTab: WorkspaceTab;
  displayMode: 'table' | 'conversation';
  detailTab: DetailTab;
  detailWidth: number;
  query: string;
  filter?: RowFilter | undefined;
  filters: RowFilter[];
  rowTypes?: RowTypeSelection | undefined;
  sort?: RowSort | undefined;
  sortDirection: SortDirection;
  sortOffset: string;
  sortOffsetHistory: string[];
  sortPage: string;
  followMode: boolean;
  /** Source updates and viewport following are independent user intents. */
  viewportMode: ViewportMode;
  /** Advances only when an accepted explicit navigation replaces the viewport. */
  viewportRevision: number;
  latestSeq: string;
  seenSeq: string;
  unseenActivity: boolean;
  columnVisibility: Record<string, boolean>;
  columnWidths: Record<string, number>;
  columnOrder: string[];
  pending: Partial<Record<RequestKind, RequestState>>;
  invalidationReason?: 'append' | 'truncate' | 'replace' | 'delete' | 'unknown' | undefined;
  blockedDetailOrdinal?: string | undefined;
  /** Keeps the selected row identity while a manual rebuild opens its new snapshot. */
  rebuildSelection?: RebuildDetailIntent | undefined;
  /** Keeps an open detail mounted while a manual rebuild opens its new snapshot. */
  rebuildDetail?: RebuildDetailIntent | undefined;
  detailStale?: boolean | undefined;
  error?: WorkspaceError | undefined;
  navigatorBridge?: NavigatorBridgeResultV1 | undefined;
  sourceRegistration?: SourceRegistrationFactsV1 | undefined;
}

export function canReadSnapshot(reason: WorkspaceState['invalidationReason']): boolean {
  return reason === undefined || reason === 'append';
}

export function nextInvalidationReason(
  current: WorkspaceState['invalidationReason'],
  observed: NonNullable<WorkspaceState['invalidationReason']>,
): NonNullable<WorkspaceState['invalidationReason']> {
  return observed === 'append' && (current === 'truncate' || current === 'replace' || current === 'delete')
    ? current
    : observed;
}

export function shouldCloseDetailOnEscape(
  key: string,
  state: Pick<WorkspaceState, 'detailOpen'>,
): boolean {
  return key === 'Escape' && state.detailOpen;
}

export interface PersistedWorkspaceState {
  /** UI handoff only; Host authorization remains authoritative and must be read back. */
  navigatorBridgeState?: 'disabled' | 'authorization-required' | 'authorized' | 'cancelled' | 'failed';
  /** Accept the retired workspace tab only to migrate old persisted state. */
  activeTab?: WorkspaceTab | 'graph';
  displayMode?: 'table' | 'conversation';
  detailTab?: DetailTab;
  detailWidth?: number;
  query?: string;
  filter?: RowFilter | undefined;
  filters?: RowFilter[];
  rowTypes?: RowTypeSelection | undefined;
  sort?: RowSort | undefined;
  sortDirection?: SortDirection;
  sortOffset?: string;
  sortOffsetHistory?: string[];
  sortPage?: string;
  followMode?: boolean;
  insightDimension?: InsightDimension;
  insightScope?: InsightScope;
  columnVisibility?: Record<string, boolean>;
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
}

export type WorkspaceAction =
  | { type: 'REQUEST_SENT'; request: RequestState }
  | { type: 'STARTUP_TIMEOUT' }
  | { type: 'REQUEST_FINISHED'; kind: RequestKind; requestId: string }
  | { type: 'MESSAGE_RECEIVED'; message: ExtensionMessage }
  | { type: 'SET_ACTIVE_TAB'; tab: WorkspaceTab }
  | { type: 'SET_DISPLAY_MODE'; mode: 'table' | 'conversation' }
  | { type: 'SET_INSIGHT_DIMENSION'; dimension: InsightDimension }
  | { type: 'SET_INSIGHT_SCOPE'; scope: InsightScope }
  | { type: 'SET_ANALYSIS_INTENT'; intent: AnalysisIntentV1 }
  | { type: 'SET_DETAIL_TAB'; tab: DetailTab }
  | { type: 'SET_DETAIL_WIDTH'; width: number }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SET_FILTER'; filter?: RowFilter | undefined }
  | { type: 'SET_FILTERS'; filters: RowFilter[] }
  | { type: 'SET_ROW_TYPES'; rowTypes?: RowTypeSelection | undefined }
  | { type: 'SET_SORT'; sort?: RowSort | undefined }
  | { type: 'SET_SORT_DIRECTION'; direction: SortDirection }
  | { type: 'SET_SORT_OFFSET'; offset: string; history: string[]; page: string }
  | { type: 'SET_FOLLOW_MODE'; enabled: boolean }
  | { type: 'SET_VIEWPORT_MODE'; mode: ViewportMode }
  | { type: 'RESET_VIEWPORT' }
  | { type: 'TAIL_VISIBLE'; generation: string; ordinal: string; indexedRecords: string; epoch?: number }
  | { type: 'SET_COLUMN_VISIBILITY'; columnId: string; visible: boolean }
  | { type: 'SET_COLUMN_WIDTH'; columnId: string; width?: number | undefined }
  | { type: 'SET_COLUMN_ORDER'; order: string[] }
  | { type: 'SELECT_ROW'; ref?: RecordRef; ordinal?: string }
  | { type: 'CLOSE_DETAIL' }
  | { type: 'DISMISS_ERROR' };

export function createInitialState(restored?: PersistedWorkspaceState, pageSize = 100): WorkspaceState {
  const sortDirection = restored?.sortDirection === 'asc' || restored?.sortDirection === 'desc'
    ? restored.sortDirection
    : restored?.sort?.direction === 'desc' ? 'desc' : 'asc';
  const sort = restored?.sortDirection === undefined
    ? restored?.sort
    : sortDirection === 'desc' ? { columnId: '__ordinal', direction: 'desc' as const } : undefined;
  const sortOffset = sort === undefined ? '0' : normalizeSortOffset(restored?.sortOffset);
  const filters = [...new Map((restored?.filters ?? (restored?.filter === undefined ? [] : [restored.filter]))
    .map((filter) => [JSON.stringify(filter), filter])).values()];
  return {
    phase: 'booting',
    rows: [],
    columns: [],
    schema: [],
    schemaTotal: 0,
    schemaComplete: false,
    insightDimension: restored?.insightDimension ?? 'eventKind',
    insightScope: restored?.insightScope ?? 'current-view',
    analysisIntentRevision: 0,
    activeTab: restored?.activeTab === 'graph' ? 'table' : restored?.activeTab ?? 'table',
    // Conversation projection is retained internally for compatibility, but is
    // temporarily unavailable until its profile-aware formatting is complete.
    displayMode: 'table',
    detailTab: restored?.detailTab ?? 'tree',
    detailWidth: restored?.detailWidth ?? DEFAULT_DETAIL_WIDTH,
    query: restored?.query ?? '',
    filter: filters[0],
    filters,
    rowTypes: restored?.rowTypes,
    sort,
    sortDirection,
    sortOffset,
    sortOffsetHistory: sort === undefined
      ? []
      : normalizeSortOffsetHistory(restored?.sortOffsetHistory, sortOffset),
    sortPage: sort === undefined
      ? '1'
      : normalizeSortPage(restored?.sortPage, sortOffset, pageSize),
    followMode: restored?.followMode ?? false,
    viewportMode: restored?.followMode && !restored.query?.trim() && filters.length === 0
      && !restored.rowTypes?.values.length
      && (sort === undefined || sort.columnId === '__ordinal') ? 'following' : 'reading',
    viewportRevision: 0,
    latestSeq: '0',
    seenSeq: '0',
    unseenActivity: false,
    detailOpen: false,
    detailFollow: false,
    columnVisibility: restored?.columnVisibility ?? {},
    columnWidths: restored?.columnWidths ?? {},
    columnOrder: restored?.columnOrder ?? [],
    pending: {},
  };
}

function completeRequest(
  pending: WorkspaceState['pending'],
  requestId: string,
): WorkspaceState['pending'] {
  const next = { ...pending };
  for (const kind of Object.keys(next) as RequestKind[]) {
    if (next[kind]?.id === requestId) {
      delete next[kind];
    }
  }
  return next;
}

function reconcileVisibility(
  columns: ColumnSpec[],
  current: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...current, __ordinal: true };
  for (const column of columns) {
    next[column.id] = current[column.id] ?? true;
  }
  return next;
}

function reconcileColumnOrder(columns: ColumnSpec[], current: readonly string[]): string[] {
  const available = new Set(columns.map((column) => column.id));
  const ordered: string[] = [];
  for (const id of current) {
    if (id !== '__ordinal' && available.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const column of columns) {
    if (!ordered.includes(column.id)) ordered.push(column.id);
  }
  return ordered;
}

function sameRebuildRecord(left: RecordRef, right: RecordRef): boolean {
  // Generation is deliberately ignored here: append/rebuild recovery rebases
  // the same physical record into the accepted snapshot. Every byte coordinate
  // remains part of the identity so an ordinal reuse or length change cannot
  // retain the wrong payload.
  return left.ordinal === right.ordinal
    && left.byteStart === right.byteStart
    && left.byteEndExclusive === right.byteEndExclusive
    && left.contentByteLength === right.contentByteLength
    && left.delimiterByteLength === right.delimiterByteLength;
}

function samePhysicalRecord(left: RecordRef, right: RecordRef): boolean {
  return left.generation === right.generation
    && left.ordinal === right.ordinal
    && left.byteStart === right.byteStart
    && left.byteEndExclusive === right.byteEndExclusive
    && left.contentByteLength === right.contentByteLength
    && left.delimiterByteLength === right.delimiterByteLength;
}

function receiveMessage(state: WorkspaceState, message: ExtensionMessage): WorkspaceState {
  const pending = completeRequest(state.pending, message.requestId);
  switch (message.type) {
    case 'LINEAGE_LOOKUP_RESULT': return { ...state, pending };
    case 'GRAPH':
    case 'GRAPH_REVEAL_RESULT': return { ...state, pending };
    case 'PREVIEW_STATUS':
    case 'NAVIGATOR_VISIBILITY': return state;
    case 'OPENED': {
      if (state.summary !== undefined
        && !snapshotIdentityChanged(state.summary.snapshot, message.payload.snapshot)
        && !profileEpochAccepted(state.summary.profileEpoch, message.payload.profileEpoch)) return state;
      const snapshotChanged = snapshotIdentityChanged(state.summary?.snapshot, message.payload.snapshot);
      const analysisChanged = snapshotChanged || state.summary?.snapshot.epoch !== message.payload.snapshot.epoch
        || state.summary?.profileId !== message.payload.profileId
        || state.summary?.profileVersion !== message.payload.profileVersion
        || state.summary?.profileEpoch !== message.payload.profileEpoch;
      // Only an accepted new snapshot can clear the stale-source barrier.
      // Repeated OPENED broadcasts must not hide destructive invalidation.
      if (state.invalidationReason !== undefined && !snapshotChanged) return { ...state, pending };
      const sameDocument = state.summary?.snapshot.documentId === message.payload.snapshot.documentId;
      const safeRecovery = canReadSnapshot(state.invalidationReason);
      const preserveFollowViewport = snapshotChanged && safeRecovery && state.followMode && state.rows.length > 0
        && sameDocument;
      const preserveTransientViewport = snapshotChanged && !preserveFollowViewport
        && safeRecovery
        && state.error?.code === 'SOURCE_UPDATING'
        && state.detail !== undefined
        && state.selectedOrdinal !== undefined
        && sameDocument;
      const preserveOngoingRecovery = snapshotChanged && safeRecovery && sameDocument
        && state.detailOpen && state.detailStale === true && state.detail !== undefined
        && state.rebuildDetail !== undefined;
      const preserveRecoveryViewport = preserveFollowViewport || preserveTransientViewport || preserveOngoingRecovery;
      // Follow adoption changes the generation but keeps the same physical
      // file. Seed the existing rebuild intents so the viewport and drawer
      // remain mounted while the new page is queried, then let App's existing
      // stale-detail effect hydrate the selected record against that generation.
      const recoveryRecordRef = preserveFollowViewport
        ? state.rebuildDetail?.ref ?? state.selectedRef ?? state.detail?.ref
          ?? state.rows.find((row) => row.ref.ordinal === state.selectedOrdinal)?.ref
        : preserveTransientViewport ? state.detail?.ref
        : preserveOngoingRecovery ? state.rebuildDetail?.ref
        : undefined;
      const recoverySelectionCompatible = recoveryRecordRef === undefined
        || state.rebuildSelection === undefined
        || sameRebuildRecord(state.rebuildSelection.ref, recoveryRecordRef);
      const preserveRecoveryRecord = recoveryRecordRef !== undefined
        && state.selectedOrdinal !== undefined
        && recoverySelectionCompatible
        && sameDocument;
      const recoverySelection = preserveRecoveryRecord && state.summary !== undefined
        ? {
            documentId: state.summary.snapshot.documentId,
            generation: message.payload.snapshot.generation,
            ref: { ...recoveryRecordRef, generation: message.payload.snapshot.generation },
          } satisfies RebuildDetailIntent
        : undefined;
      const recoveryDetail = preserveRecoveryRecord && state.detailOpen && state.detail !== undefined
        ? recoverySelection
        : undefined;
      const preserveRebuildDetail = snapshotChanged && !preserveRecoveryViewport
        && state.rebuildDetail !== undefined
        && state.pending.rebuild !== undefined
        && state.rebuildDetail.documentId === message.payload.snapshot.documentId;
      const reboundRebuildDetail = preserveRebuildDetail && state.rebuildDetail !== undefined
        ? {
            ...state.rebuildDetail,
            generation: message.payload.snapshot.generation,
            ref: { ...state.rebuildDetail.ref, generation: message.payload.snapshot.generation },
          } satisfies RebuildDetailIntent
        : undefined;
      const selectedRef = preserveRebuildDetail
        ? reboundRebuildDetail?.ref
        : preserveRecoveryRecord
          ? recoverySelection?.ref
          : snapshotChanged && !preserveRecoveryViewport
            ? undefined
            : state.selectedRef;
      const keepActivity = sameDocument && safeRecovery;
      const latestSeq = keepActivity && BigInt(state.latestSeq) > BigInt(message.payload.indexedRecords)
        ? state.latestSeq : message.payload.indexedRecords;
      const seenSeq = keepActivity ? state.seenSeq : latestSeq;
      return {
        ...state,
        phase: message.payload.indexingComplete ? 'ready' : 'loading',
        summary: message.payload,
        latestSeq,
        seenSeq,
        unseenActivity: BigInt(latestSeq) > BigInt(seenSeq),
        rows: snapshotChanged && !preserveRecoveryViewport ? [] : state.rows,
        columns: snapshotChanged && !preserveRecoveryViewport ? [] : state.columns,
        page: snapshotChanged && !preserveRecoveryViewport ? undefined : state.page,
        pageProjectionProfileId: snapshotChanged && !preserveRecoveryViewport
          ? undefined : state.pageProjectionProfileId,
        problems: snapshotChanged ? undefined : state.problems,
        selectedOrdinal: preserveRebuildDetail
          ? state.rebuildDetail?.ref.ordinal
          : snapshotChanged && !preserveRecoveryViewport && state.rebuildSelection !== undefined
            && state.rebuildSelection.documentId === message.payload.snapshot.documentId
            ? state.rebuildSelection.ref.ordinal
          : preserveRecoveryRecord ? state.selectedOrdinal
          : snapshotChanged && !preserveRecoveryViewport ? undefined : state.selectedOrdinal,
        selectedRef,
        detail: preserveRebuildDetail || preserveRecoveryRecord ? state.detail : snapshotChanged ? undefined : state.detail,
        detailOpen: snapshotChanged
          ? state.detailOpen && (preserveRebuildDetail || preserveRecoveryRecord)
          : state.detailOpen,
        schema: snapshotChanged ? [] : state.schema,
        schemaTotal: snapshotChanged ? 0 : state.schemaTotal,
        schemaComplete: snapshotChanged ? false : state.schemaComplete,
        insights: analysisChanged ? undefined : state.insights,
        analysisIntent: analysisChanged ? undefined : state.analysisIntent,
        analysisIntentRevision: analysisChanged ? state.analysisIntentRevision + 1 : state.analysisIntentRevision,
        pending: snapshotChanged ? {} : pending,
        invalidationReason: undefined,
        blockedDetailOrdinal: undefined,
        rebuildSelection: !snapshotChanged ? state.rebuildSelection : preserveRebuildDetail || (snapshotChanged && !preserveRecoveryViewport
          && state.rebuildSelection?.documentId === message.payload.snapshot.documentId)
          ? state.rebuildSelection : recoverySelection,
        rebuildDetail: !snapshotChanged ? state.rebuildDetail : reboundRebuildDetail ?? recoveryDetail,
        detailStale: !snapshotChanged ? state.detailStale : preserveRebuildDetail || recoveryDetail !== undefined,
        error: undefined,
      };
    }
    case 'ROWS': {
      if (!canReadSnapshot(state.invalidationReason)) return { ...state, pending };
      const retainedRebuildRow = state.rebuildSelection === undefined ? undefined : message.payload.rows.find(
        (row) => sameRebuildRecord(row.ref, state.rebuildSelection!.ref),
      );
      const preserveRebuildSelection = retainedRebuildRow !== undefined;
      const retainedRebuildDetail = state.rebuildDetail === undefined ? undefined : message.payload.rows.find(
        (row) => sameRebuildRecord(row.ref, state.rebuildDetail!.ref),
      );
      const selectedPageRow = state.rebuildSelection !== undefined ? undefined : state.selectedRef === undefined
        ? message.payload.rows.find((row) => row.ref.ordinal === state.selectedOrdinal)
        : message.payload.rows.find((row) => samePhysicalRecord(row.ref, state.selectedRef!));
      const pinnedDetailRef = state.detailOpen
        ? state.selectedRef ?? state.detail?.ref
        : undefined;
      const selectedRef = retainedRebuildRow?.ref
          ?? (message.payload.rows.length === 0 ? state.rebuildSelection?.ref : undefined)
          ?? pinnedDetailRef
          ?? selectedPageRow?.ref
          ?? message.payload.rows[0]?.ref;
      const selectedOrdinal = selectedRef?.ordinal;
      const selectedDetailMatches = selectedRef !== undefined && state.detail !== undefined
        && (samePhysicalRecord(selectedRef, state.detail.ref)
          || (state.detailStale === true && sameRebuildRecord(selectedRef, state.detail.ref)));
      const preserveRebuildDetail = state.rebuildDetail !== undefined
        && selectedRef !== undefined
        && sameRebuildRecord(selectedRef, state.rebuildDetail.ref)
        && (retainedRebuildDetail !== undefined || message.payload.rows.length === 0 || pinnedDetailRef !== undefined);
      const preserveRebuildSelectionForPinnedDetail = state.rebuildSelection !== undefined
        && selectedRef !== undefined
        && sameRebuildRecord(selectedRef, state.rebuildSelection.ref)
        && (preserveRebuildSelection || message.payload.rows.length === 0 || pinnedDetailRef !== undefined);
      const sortOffset = message.payload.sortOffset === undefined
        ? state.sortOffset
        : normalizeSortOffset(message.payload.sortOffset);
      return {
        ...state,
        phase: state.invalidationReason === 'append'
          ? 'invalidated'
          : state.summary?.indexingComplete === false ? 'loading' : 'ready',
        rows: message.payload.rows,
        columns: message.payload.columns,
        page: {
          anchorOrdinal: message.payload.anchorOrdinal,
          hasBefore: message.payload.hasBefore,
          hasAfter: message.payload.hasAfter,
          ...(message.payload.sort === undefined ? {} : { sort: message.payload.sort }),
          ...(message.payload.sortOffset === undefined ? {} : { sortOffset: message.payload.sortOffset }),
          ...(message.payload.sortNextOffset === undefined ? {} : { sortNextOffset: message.payload.sortNextOffset }),
          ...(message.payload.matchedRecords === undefined ? {} : { matchedRecords: message.payload.matchedRecords }),
          ...(message.payload.scan === undefined ? {} : { scan: message.payload.scan }),
          ...(message.payload.projection === undefined ? {} : { projection: message.payload.projection }),
        },
        pageProjectionProfileId: state.summary?.profileId,
        selectedOrdinal,
        selectedRef,
        detail: selectedDetailMatches ? state.detail : undefined,
        blockedDetailOrdinal: state.blockedDetailOrdinal === selectedOrdinal ? state.blockedDetailOrdinal : undefined,
        rebuildSelection: preserveRebuildSelectionForPinnedDetail ? state.rebuildSelection : undefined,
        rebuildDetail: preserveRebuildDetail ? state.rebuildDetail : undefined,
        detailStale: selectedDetailMatches && preserveRebuildDetail && state.detailStale === true,
        columnVisibility: reconcileVisibility(message.payload.columns, state.columnVisibility),
        columnOrder: reconcileColumnOrder(message.payload.columns, state.columnOrder),
        sortOffset,
        sortOffsetHistory: message.payload.sortOffset !== undefined && sortOffset !== state.sortOffset
          ? []
          : state.sortOffsetHistory,
        pending,
        error: undefined,
      };
    }
    case 'DETAIL': {
      if (!canReadSnapshot(state.invalidationReason)) return { ...state, pending };
      if (!state.detailOpen) return { ...state, pending };
      // A cancelled detail response can still cross the host boundary. Never
      // let that stale payload relabel a newer user selection. The request
      // client filters it in normal operation; this reducer guard is the
      // deterministic last line for append/rebuild races. Check the complete
      // physical identity when a row or recovery intent is available; ordinal
      // alone is not enough because a rewritten source can reuse it.
      const selectedRow = state.selectedOrdinal === undefined ? undefined : state.rows.find(
        (row) => row.ref.ordinal === state.selectedOrdinal,
      );
      // During recovery the visible rows intentionally remain from the old
      // generation until the replacement page arrives. Prefer the rebased
      // intent over that old page so the first current-generation DETAIL is
      // admitted instead of being mistaken for a stale response.
      const expectedRef = state.rebuildDetail?.ref
        ?? state.rebuildSelection?.ref
        ?? state.selectedRef
        ?? selectedRow?.ref;
      if (state.selectedOrdinal !== undefined && state.selectedOrdinal !== message.payload.ref.ordinal) {
        return { ...state, pending };
      }
      if (expectedRef !== undefined && !samePhysicalRecord(expectedRef, message.payload.ref)) {
        return { ...state, pending };
      }
      return {
        ...state,
        detail: message.payload,
        selectedOrdinal: message.payload.ref.ordinal,
        selectedRef: message.payload.ref,
        detailOpen: true,
        blockedDetailOrdinal: undefined,
        rebuildSelection: undefined,
        rebuildDetail: undefined,
        detailStale: false,
        pending,
        error: undefined,
      };
    }
    case 'PROBLEMS': {
      if (!canReadSnapshot(state.invalidationReason)) return { ...state, pending };
      const observedProblemRecords = message.payload.observedProblemRecords;
      const currentProblemRecords = state.summary?.problemRecords ?? '0';
      const problemRecords = BigInt(observedProblemRecords) > BigInt(currentProblemRecords)
        ? observedProblemRecords
        : currentProblemRecords;
      return {
        ...state,
        problems: message.payload,
        summary: state.summary
          ? { ...state.summary, problemRecords }
          : state.summary,
        pending,
        error: undefined,
      };
    }
    case 'SCHEMA':
      if (!canReadSnapshot(state.invalidationReason)) return { ...state, pending };
      return {
        ...state,
        schema: message.payload.fields,
        schemaTotal: message.payload.totalFields,
        schemaComplete: message.payload.complete,
        pending,
        error: undefined,
      };
    case 'INSIGHTS':
      if (!canReadSnapshot(state.invalidationReason)) return { ...state, pending };
      if (state.pending.profile !== undefined) return { ...state, pending };
      if (state.analysisIntent === undefined || !analysisIntentEquals(state.analysisIntent, message.payload.intent)) {
        return { ...state, pending };
      }
      return {
        ...state,
        insights: message.payload,
        failedAnalysisIntent: undefined,
        insightDimension: message.payload.intent.dimension,
        insightScope: message.payload.intent.scope,
        pending,
        error: undefined,
      };
    case 'INDEX_PROGRESS': {
      if (state.invalidationReason !== undefined) return { ...state, pending };
      if (state.summary !== undefined
        && !snapshotIdentityChanged(state.summary.snapshot, message.payload.snapshot)
        && !profileEpochAccepted(state.summary.profileEpoch, message.payload.profileEpoch)) return state;
      const analysisChanged = state.summary !== undefined
        && (snapshotIdentityChanged(state.summary.snapshot, message.payload.snapshot)
          || state.summary.snapshot.epoch !== message.payload.snapshot.epoch
          || state.summary.profileId !== message.payload.profileId
          || state.summary.profileVersion !== message.payload.profileVersion
          || state.summary.profileEpoch !== message.payload.profileEpoch);
      return {
        ...state,
        phase: message.payload.indexingComplete ? 'ready' : 'loading',
        summary: message.payload,
        latestSeq: BigInt(message.payload.indexedRecords) > BigInt(state.latestSeq)
          ? message.payload.indexedRecords : state.latestSeq,
        unseenActivity: BigInt(message.payload.indexedRecords) > BigInt(state.seenSeq)
          || state.unseenActivity,
        insights: analysisChanged ? undefined : state.insights,
        analysisIntent: analysisChanged ? undefined : state.analysisIntent,
        analysisIntentRevision: analysisChanged ? state.analysisIntentRevision + 1 : state.analysisIntentRevision,
        pending,
      };
    }
    case 'PROFILE_CHANGED': {
      if (state.invalidationReason !== undefined) return { ...state, pending };
      if (!profileEpochAccepted(state.summary?.profileEpoch, message.payload.profileEpoch)) return state;
      const columns = columnsAfterProfileChange(state.columns, message.payload.columns, state.columnVisibility);
      const profileQuery = reconcileProfileQueryState(
        state.sort,
        state.filter,
        state.columns,
        message.payload.columns,
      );
      const filters = state.filters.flatMap((filter) => {
        const reconciled = reconcileProfileQueryState(undefined, filter, state.columns, message.payload.columns).filter;
        return reconciled === undefined ? [] : [reconciled];
      });
      return {
        ...state,
        columns,
        columnVisibility: reconcileVisibility(columns, state.columnVisibility),
        columnOrder: reconcileColumnOrder(columns, state.columnOrder),
        summary: state.summary ? {
          ...state.summary,
          profileId: message.payload.profileId,
          profileVersion: message.payload.profileVersion,
          profileEpoch: message.payload.profileEpoch,
        } : state.summary,
        sort: profileQuery.sort,
        filter: filters[0],
        filters,
        rowTypes: state.rowTypes?.column.source === 'profile'
          && !message.payload.columns.some((column) => column.id === state.rowTypes?.column.id && column.source === 'profile')
          ? undefined : state.rowTypes,
        sortOffset: '0',
        sortOffsetHistory: [],
        sortPage: '1',
        pending,
        detail: undefined,
        insights: undefined,
        analysisIntent: undefined,
        analysisIntentRevision: state.analysisIntentRevision + 1,
      };
    }
    case 'ROW_ORDER_CHANGED':
      return { ...state, pending };
    case 'REVEAL':
      return { ...state, pending };
    case 'NAVIGATOR_STATUS':
      return { ...state, navigatorBridge: message.payload, pending };
    case 'SOURCE_REGISTRATION_RESULT':
      return { ...state, sourceRegistration: message.payload, pending };
    case 'SOURCE_INVALIDATED': {
      const reason = nextInvalidationReason(state.invalidationReason, message.payload.reason);
      return {
        ...state,
        phase: 'invalidated',
        invalidationReason: reason,
        blockedDetailOrdinal: !canReadSnapshot(reason) && state.pending.detail !== undefined
          ? state.selectedOrdinal
          : state.blockedDetailOrdinal,
        pending: reason === 'append' ? pending : {},
      };
    }
    case 'ERROR': {
      const failedAnalysisIntent = state.pending.insights?.id === message.requestId
        ? state.analysisIntent : state.failedAnalysisIntent;
      if (message.payload.code === 'SOURCE_UPDATING') {
        // A moving writer is a recoverable lifecycle hint, not a snapshot
        // barrier. Keep the old rows/detail mounted and let the host publish a
        // new generation only after bounded quiet-source validation.
        return {
          ...state,
          phase: state.detail || state.rows.length > 0 ? state.phase : 'loading',
          // Keep the lifecycle hint in state so App can schedule a bounded
          // retry for the selected detail. The banner intentionally filters
          // this product-owned code; rows and drawer remain mounted.
          error: message.payload,
          failedAnalysisIntent,
          pending,
        };
      }
      if (state.invalidationReason !== undefined) {
        return {
          ...state,
          phase: 'invalidated',
          blockedDetailOrdinal: state.pending.detail?.id === message.requestId && state.detail === undefined
            ? state.selectedOrdinal
            : state.blockedDetailOrdinal,
          rebuildDetail: state.pending.rebuild?.id === message.requestId ? undefined : state.rebuildDetail,
          rebuildSelection: state.pending.rebuild?.id === message.requestId ? undefined : state.rebuildSelection,
          detailStale: state.pending.rebuild?.id === message.requestId ? false : state.detailStale,
          error: message.payload,
          failedAnalysisIntent,
          pending,
        };
      }
      return {
        ...state,
        phase: message.payload.recoverable ? 'degraded' : 'error',
        rebuildDetail: state.pending.rebuild?.id === message.requestId ? undefined : state.rebuildDetail,
        rebuildSelection: state.pending.rebuild?.id === message.requestId ? undefined : state.rebuildSelection,
        detailStale: state.pending.rebuild?.id === message.requestId ? false : state.detailStale,
        error: message.payload,
        failedAnalysisIntent,
        pending,
      };
    }
  }
}

function profileEpochAccepted(previous: number | undefined, next: number | undefined): boolean {
  return previous === undefined || (next !== undefined && next >= previous);
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'STARTUP_TIMEOUT':
      return state.summary === undefined && state.error === undefined ? {
        ...state,
        phase: 'error',
        error: {
          code: 'STARTUP_TIMEOUT',
          message: 'The editor did not connect. Reopen this file and check the JsonlView output channel.',
          recoverable: false,
        },
      } : state;
    case 'REQUEST_SENT': {
      const selectedRow = action.request.kind === 'rebuild' && state.summary !== undefined
        && state.selectedOrdinal !== undefined
        ? state.rows.find((row) => state.selectedRef === undefined
          ? row.ref.ordinal === state.selectedOrdinal
          : samePhysicalRecord(row.ref, state.selectedRef))
        : undefined;
      const selectedRef = action.request.kind === 'rebuild'
        ? selectedRow?.ref ?? (state.detailOpen ? state.selectedRef ?? state.detail?.ref : undefined)
        : undefined;
      const rebuildSelection = selectedRef === undefined || state.summary === undefined ? undefined : {
        documentId: state.summary.snapshot.documentId,
        generation: state.summary.snapshot.generation,
        ...(state.summary.snapshot.epoch === undefined ? {} : { epoch: state.summary.snapshot.epoch }),
        ref: selectedRef,
      };
      return {
        ...state,
        phase: (action.request.kind === 'ready' && state.error !== undefined)
          ? state.phase
          : action.request.kind === 'ready' || action.request.kind === 'rebuild' ? 'loading' : state.phase,
        pending: {
          ...state.pending,
          [action.request.kind]: action.request,
        },
        ...(action.request.kind === 'rebuild' ? {
          rebuildSelection,
          rebuildDetail: rebuildSelection !== undefined && state.detail !== undefined ? rebuildSelection : undefined,
        } : {}),
        ...(action.request.kind === 'detail' ? { detailOpen: true } : {}),
        ...(action.request.kind === 'profile' ? {
          insights: undefined, analysisIntent: undefined, analysisIntentRevision: state.analysisIntentRevision + 1,
        } : {}),
      };
    }
    case 'REQUEST_FINISHED':
      return {
        ...state,
        pending: state.pending[action.kind]?.id === action.requestId
          ? { ...state.pending, [action.kind]: undefined }
          : state.pending,
        ...(action.kind === 'rebuild' && state.pending.rebuild?.id === action.requestId
          ? { rebuildDetail: undefined, detailStale: false }
          : {}),
        ...(action.kind === 'rebuild' && state.pending.rebuild?.id === action.requestId
          ? { rebuildSelection: undefined }
          : {}),
      };
    case 'MESSAGE_RECEIVED':
      return receiveMessage(state, action.message);
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab };
    case 'SET_DISPLAY_MODE':
      return { ...state, displayMode: action.mode };
    case 'SET_INSIGHT_DIMENSION':
      return { ...state, insightDimension: action.dimension, insights: undefined, analysisIntent: undefined,
        analysisIntentRevision: state.analysisIntentRevision + 1 };
    case 'SET_INSIGHT_SCOPE':
      return { ...state, insightScope: action.scope, insights: undefined, analysisIntent: undefined,
        analysisIntentRevision: state.analysisIntentRevision + 1 };
    case 'SET_ANALYSIS_INTENT':
      if (state.pending.profile !== undefined || action.intent.intentRevision <= state.analysisIntentRevision) return state;
      return { ...state, analysisIntent: action.intent, analysisIntentRevision: action.intent.intentRevision };
    case 'SET_DETAIL_TAB':
      return { ...state, detailTab: action.tab };
    case 'SET_DETAIL_WIDTH':
      return { ...state, detailWidth: action.width };
    case 'SET_QUERY':
      return { ...state, query: action.query, sortOffset: '0', sortOffsetHistory: [], sortPage: '1',
        insights: undefined, analysisIntent: undefined, analysisIntentRevision: state.analysisIntentRevision + 1 };
    case 'SET_FILTER':
      return { ...state, filter: action.filter, filters: action.filter === undefined ? [] : [action.filter],
        sortOffset: '0', sortOffsetHistory: [], sortPage: '1', insights: undefined, analysisIntent: undefined,
        analysisIntentRevision: state.analysisIntentRevision + 1 };
    case 'SET_FILTERS':
      return { ...state, filter: action.filters[0], filters: [...action.filters],
        sortOffset: '0', sortOffsetHistory: [], sortPage: '1', insights: undefined, analysisIntent: undefined,
        analysisIntentRevision: state.analysisIntentRevision + 1 };
    case 'SET_ROW_TYPES':
      return { ...state, rowTypes: action.rowTypes, sortOffset: '0', sortOffsetHistory: [], sortPage: '1',
        insights: undefined, analysisIntent: undefined, analysisIntentRevision: state.analysisIntentRevision + 1 };
    case 'SET_SORT':
      return { ...state, sort: action.sort, sortOffset: '0', sortOffsetHistory: [], sortPage: '1' };
    case 'SET_SORT_DIRECTION':
      return { ...state, sortDirection: action.direction };
    case 'SET_SORT_OFFSET': {
      const sortOffset = normalizeSortOffset(action.offset);
      return {
        ...state,
        sortOffset,
        sortOffsetHistory: normalizeSortOffsetHistory(action.history, sortOffset),
        sortPage: normalizeSortPage(action.page, undefined, 1),
      };
    }
    case 'SET_FOLLOW_MODE':
      if (!action.enabled) return { ...state, followMode: false, detailFollow: false };
      // Enabling Follow immediately returns the viewport to the accepted tail.
      // Treat the current indexed watermark as seen so the transition itself
      // cannot surface a stale activity banner before the first tail paint.
      return { ...state, followMode: true, detailFollow: false, seenSeq: state.latestSeq, unseenActivity: false };
    case 'SET_VIEWPORT_MODE':
      return { ...state, viewportMode: action.mode };
    case 'RESET_VIEWPORT':
      return { ...state, viewportRevision: state.viewportRevision + 1 };
    case 'TAIL_VISIBLE': {
      const snapshot = state.summary?.snapshot;
      if (snapshot === undefined || !canReadSnapshot(state.invalidationReason)
        || snapshot.generation !== action.generation
        || (action.epoch !== undefined && snapshot.epoch !== action.epoch)
        || action.indexedRecords !== state.latestSeq || !/^[0-9]+$/u.test(action.ordinal)
        || BigInt(action.ordinal) + 1n !== BigInt(state.latestSeq)
        || !state.rows.some((row) => row.ref.generation === action.generation && row.ref.ordinal === action.ordinal)) {
        return state;
      }
      return { ...state, seenSeq: state.latestSeq, unseenActivity: false };
    }
    case 'SET_COLUMN_VISIBILITY':
      if (action.columnId === '__ordinal') return state;
      return {
        ...state,
        columnVisibility: {
          ...state.columnVisibility,
          [action.columnId]: action.visible,
        },
      };
    case 'SET_COLUMN_WIDTH': {
      const next = { ...state.columnWidths };
      if (action.width === undefined) delete next[action.columnId];
      else if (Number.isFinite(action.width)) next[action.columnId] = Math.round(action.width);
      return { ...state, columnWidths: next };
    }
    case 'SET_COLUMN_ORDER': {
      const available = new Set(state.columns.map((column) => column.id));
      const next: string[] = [];
      for (const id of action.order) {
        if (id !== '__ordinal' && available.has(id) && !next.includes(id)) next.push(id);
      }
      for (const column of state.columns) {
        if (!next.includes(column.id)) next.push(column.id);
      }
      return { ...state, columnOrder: next };
    }
    case 'SELECT_ROW': {
      const ordinal = action.ref?.ordinal ?? action.ordinal;
      const selectedRef = action.ref
        ?? (ordinal === undefined ? undefined : state.rows.find((row) => row.ref.ordinal === ordinal)?.ref);
      // A retained page is display-only until its replacement generation arrives.
      if (selectedRef !== undefined && state.summary !== undefined
        && selectedRef.generation !== state.summary.snapshot.generation) return state;
      const sameSelection = selectedRef !== undefined && state.selectedRef !== undefined
        ? samePhysicalRecord(selectedRef, state.selectedRef)
        : ordinal === state.selectedOrdinal;
      return {
        ...state,
        selectedOrdinal: ordinal,
        selectedRef,
        detailOpen: ordinal !== undefined,
        detailFollow: false,
        detail: selectedRef !== undefined && state.detail !== undefined
          ? samePhysicalRecord(state.detail.ref, selectedRef) ? state.detail : undefined
          : state.detail?.ref.ordinal === ordinal ? state.detail : undefined,
        rebuildSelection: sameSelection ? state.rebuildSelection : undefined,
        rebuildDetail: sameSelection ? state.rebuildDetail : undefined,
        detailStale: sameSelection ? state.detailStale : false,
        blockedDetailOrdinal: !canReadSnapshot(state.invalidationReason)
          && ordinal !== undefined
          && state.detail?.ref.ordinal !== ordinal
          ? ordinal
          : undefined,
      };
    }
    case 'CLOSE_DETAIL':
      return {
        ...state,
        detail: undefined,
        detailOpen: false,
        detailFollow: false,
        blockedDetailOrdinal: undefined,
        rebuildSelection: undefined,
        rebuildDetail: undefined,
        detailStale: false,
      };
    case 'DISMISS_ERROR':
      if (state.invalidationReason !== undefined) {
        return { ...state, error: undefined, phase: 'invalidated' };
      }
      return {
        ...state,
        error: undefined,
        phase: state.summary?.indexingComplete === false ? 'loading' : 'ready',
      };
  }
}

export interface VisibleProblem extends ProblemRef {
  ordinal?: string;
}

export function selectProblems(state: WorkspaceState): VisibleProblem[] {
  return state.rows.flatMap((row) => (row.problems ?? []).map((problem) => ({
    ...problem,
    ordinal: problem.ref?.ordinal ?? row.ref.ordinal,
  })));
}

export function selectTimelineRows(state: WorkspaceState): RowProjection[] {
  return state.rows.filter((row) => row.profile !== undefined);
}

export function toPersistedState(state: WorkspaceState): PersistedWorkspaceState {
  return {
    activeTab: state.activeTab,
    displayMode: state.displayMode,
    detailTab: state.detailTab,
    detailWidth: state.detailWidth,
    query: state.query,
    ...(state.filter === undefined ? {} : { filter: state.filter }),
    filters: state.filters,
    ...(state.rowTypes === undefined ? {} : { rowTypes: state.rowTypes }),
    ...(state.sort === undefined ? {} : { sort: state.sort }),
    sortDirection: state.sortDirection,
    sortOffset: state.sortOffset,
    sortOffsetHistory: state.sortOffsetHistory,
    sortPage: state.sortPage,
    followMode: state.followMode,
    insightDimension: state.insightDimension,
    insightScope: state.insightScope,
    columnVisibility: state.columnVisibility,
    columnWidths: state.columnWidths,
    columnOrder: state.columnOrder,
  };
}
