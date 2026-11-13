import React, { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef, type CSSProperties } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Braces,
  CircleAlert,
  Copy,
  Table2,
  X,
} from 'lucide-react';
import type {
  InsightDimension,
  InsightScope,
  RecordRef,
  RowFilterOperator,
  SortDirection,
  TemporaryPreviewStatus,
} from '@shared/types';
import { MAX_DIAGNOSTIC_CODE_LENGTH, MAX_DIAGNOSTIC_MESSAGE_LENGTH } from '@shared/types';
import { createProtocolEnvelope } from '@shared/transport';
import { copyText, type NavigatorBridgeState } from '@widgets/detail-drawer';
import { recordRefKey, sameRecordRef } from './record-identity';
import {
  shouldAutomaticallyHydrateSelectedRecord,
} from './full-record-intent';
import { deferIdle } from './shared/utils/idle';
import { shouldIssueInsightRequest } from './insight-request';
import {
  datasetProvenanceTooltip,
  navigatorUiState,
  projectionIntentKey,
  selectedRecordColumnIds,
  workspaceAvailableColumns,
  workspaceBaseColumns,
  workspaceDatasetProjectionAvailable,
  workspaceDatasetSummary,
  workspaceBfclSummary,
  workspaceOpenTelemetrySummary,
  workspaceHasPartialContinuation,
  workspacePageRange,
  workspacePartialBannerIdentity,
  workspacePartialScan,
  workspaceRecordColumnLimit,
  workspaceShowsPageControls,
  workspaceTableColumns,
} from '@features/workspace/projections';
import {
  buildStructuredFilter,
  canRequestSortedPage,
  rowTypeSources,
  compileQueryCondition,
  SCHEMA_PAGE_SIZE,
  selectedRecordColumns,
  addQueryHistory,
  TopQueryStudio,
  TableQueryToolbar,
} from '@features/record-query';
import type { QueryHistoryEntry, RecordQueryControlsProps } from '@features/record-query';
import { clampQueryStudioSize, QUERY_STUDIO_DEFAULT_SIZE } from '@features/record-query/TopQueryStudio';
import type { QueryStudioSize } from '@features/record-query/TopQueryStudio';
import type { GridFocusBridge } from '@features/record-query/RecordTable';
import { WebviewRevealController, type RevealMessage } from '@features/record-query/reveal-controller';
import type { GridCell } from './use-grid-focus';
import { legacyRowProjectionPlan, rowProjectionPlanCovers } from '@shared/row-projection';
import { rowProjectionPlanForView } from '@features/record-query/row-projection-policy';
import type { ViewportIdentity } from './paging';
import { VsCodeMessageClient } from './protocol-client';
import { RowQueryController, type RowsRequestMetadata, type RowsRequestOptions } from './row-query-controller';
import { snapshotIdentityChanged } from './snapshot-identity';
import { createStartupStageReceipt, startStartupHandshake, type StartupStage } from './startup-handshake';
import { formatStartupDiagnosticContext, formatStartupDiagnosticPrompt } from './startup-diagnostic';
import { profileOptionList } from './profile-options';
import { JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION } from '@shared/contracts/errors';
import { TemporaryPreviewActions, WorkspaceHeader } from '@widgets/workspace-header';
import { useManualTabs } from './shared/hooks/use-manual-tabs';
import {
  canReadSnapshot,
  createInitialState,
  nextInvalidationReason,
  selectProblems,
  selectTimelineRows,
  shouldCloseDetailOnEscape,
  toPersistedState,
  workspaceReducer,
  type PersistedWorkspaceState,
  type RequestKind,
  type WorkspaceTab,
  type WorkspaceState,
} from './state';

import {
  fallbackColumns,
} from './views';
import {
  clampDetailWidth,
  DEFAULT_DETAIL_WIDTH,
  detailWidthValueText,
  isOverlayDetailWorkspace,
  maxDetailWidth,
  MIN_DETAIL_WIDTH,
} from '@features/detail-splitter';
import { useDetailSplitter } from '@features/detail-splitter';
import { WorkspaceSurface } from '@features/workspace/WorkspaceSurface';
import { RecordLineageUiController, type LineageLookupState } from '@features/record-lineage/controller';
import { useLineageNavigation, type LineageNavigation } from '@features/record-lineage/use-lineage-navigation';

const configuredPageSize = Number(document.body.dataset.pageSize ?? '100');
const PAGE_SIZE = Number.isSafeInteger(configuredPageSize)
  ? Math.min(500, Math.max(20, configuredPageSize))
  : 100;
const vscode = (window as Window & { __jsonlViewVscodeApi?: ReturnType<typeof acquireVsCodeApi<PersistedWorkspaceState>> })
  .__jsonlViewVscodeApi ?? acquireVsCodeApi<PersistedWorkspaceState>();

function bodySession(): { documentId: string; generation: string; epoch?: number } {
  const rawEpoch = document.body.dataset.epoch;
  const parsedEpoch = rawEpoch === undefined ? undefined : Number(rawEpoch);
  return {
    documentId: document.body.dataset.documentId ?? document.body.dataset.uri ?? 'jsonl-view-bootstrap',
    generation: document.body.dataset.generation ?? 'bootstrap',
    ...(parsedEpoch !== undefined && Number.isSafeInteger(parsedEpoch) && parsedEpoch >= 0
      ? { epoch: parsedEpoch }
      : {}),
  };
}

function reportStartupStage(
  stage: StartupStage,
  session: { documentId: string; generation: string; epoch?: number },
  rows?: number,
): void {
  const receipt = createStartupStageReceipt(stage, {
    ...session,
    startupId: document.body.dataset.startupId ?? '',
  }, rows);
  if (receipt !== undefined) vscode.postMessage(receipt);
}

const tabs: Array<{
  id: WorkspaceTab;
  label: string;
  icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}> = [
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'timeline', label: 'Timeline', icon: Activity },
  { id: 'schema', label: 'Schema', icon: Braces },
  { id: 'problems', label: 'Problems', icon: CircleAlert },
  { id: 'insights', label: 'Insights', icon: BarChart3 },
];

const filterOperators: Array<{ value: RowFilterOperator; label: string; needsValue: boolean }> = [
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'ends_with', label: 'ends with', needsValue: true },
  { value: 'eq', label: 'equals', needsValue: true },
  { value: 'ne', label: 'not equal', needsValue: true },
  { value: 'lt', label: 'less than', needsValue: true },
  { value: 'lte', label: 'at most', needsValue: true },
  { value: 'gt', label: 'greater than', needsValue: true },
  { value: 'gte', label: 'at least', needsValue: true },
  { value: 'exists', label: 'exists', needsValue: false },
  { value: 'is_null', label: 'is null', needsValue: false },
  { value: 'kind_is', label: 'kind is', needsValue: true },
];

export function App(): React.JSX.Element {
  const restored = useMemo(() => {
    const saved = vscode.getState();
    const direction = document.body.dataset.rowOrder === 'desc' ? 'desc' : 'asc';
    return { ...saved, sortDirection: direction } satisfies PersistedWorkspaceState;
  }, []);
  const [state, dispatch] = useReducer(
    workspaceReducer,
    restored,
    (persisted) => createInitialState(persisted, PAGE_SIZE),
  );
  const [pageInput, setPageInputState] = React.useState('1');
  const [previewStatus, setPreviewStatus] = React.useState<TemporaryPreviewStatus>();
  const [revealTarget, setRevealTarget] = React.useState<RevealMessage>();
  const [queuedReveal, setQueuedReveal] = React.useState<RevealMessage>();
  const [queryStudioOpen, setQueryStudioOpen] = React.useState(false);
  const [queryStudioPinned, setQueryStudioPinned] = React.useState(false);
  const [queryStudioSize, setQueryStudioSize] = React.useState<QueryStudioSize>(QUERY_STUDIO_DEFAULT_SIZE);
  const [queryStudioMaximized, setQueryStudioMaximized] = React.useState(false);
  const [queryHistory, setQueryHistory] = React.useState<readonly QueryHistoryEntry[]>([]);
  // A Webview restore is only UI state. Host authorization must be read back
  // for this document lifecycle before the detail can show an authorized
  // Navigator handoff again.
  const [navigatorBridgeState, setNavigatorBridgeState] = React.useState<NavigatorBridgeState>('disabled');
  const [navigatorVisible, setNavigatorVisible] = React.useState(false);
  const [rowsProjectionFailed, setRowsProjectionFailed] = React.useState(false);
  const [diagnosticActionStatus, setDiagnosticActionStatus] = React.useState<string>();
  const stateRef = useRef(state);
  const gridFocusBridgeRef = useRef<GridFocusBridge | undefined>(undefined);
  const studioFocusRef = useRef<GridCell | undefined>(undefined);
  const studioTriggerRef = useRef<HTMLElement | null>(null);
  const studioFocusGenerationRef = useRef<string | undefined>(undefined);
  const studioRestoreFocusRef = useRef(true);
  const priorStudioOpenRef = useRef(false);
  const analysisIntentRevisionRef = useRef(state.analysisIntentRevision);
  const persistedStateRef = useRef<PersistedWorkspaceState>(toPersistedState(state));
  const clientRef = useRef(new VsCodeMessageClient(vscode, bodySession()));
  const studioGenerationRef = useRef(clientRef.current.session.generation);
  const startupErrorRef = useRef(false);
  const startupReadyIdsRef = useRef(new Set<string>());
  const startupStopRef = useRef<(() => void) | undefined>(undefined);
  const startupStagesRef = useRef({ opened: false, page: false, error: false });
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = React.useState(window.innerWidth);
  const drawerId = 'record-detail';
  const workspaceTabs = useManualTabs({
    ids: tabs.map((tab) => tab.id),
    activeId: state.activeTab,
    onActivate: (tab) => {
      if (tab !== 'table') queryController.pauseFollowing();
      if (tab !== state.activeTab && queryStudioOpen && !queryStudioPinned) closeQueryStudio(false);
      dispatch({ type: 'SET_ACTIVE_TAB', tab });
    },
    idPrefix: 'workspace-views',
  });
  const indexingCompleteRef = useRef(false);
  const [filterColumnId, setFilterColumnId] = React.useState(restored?.filter?.columnId ?? '');
  const [filterOperator, setFilterOperator] = React.useState<RowFilterOperator>(restored?.filter?.operator ?? 'contains');
  const [filterValue, setFilterValue] = React.useState(
    restored?.filter?.value === undefined ? '' : String(restored.filter.value),
  );
  const [filterCaseSensitive, setFilterCaseSensitive] = React.useState(restored?.filter?.caseSensitive ?? false);
  const followModeRef = useRef(restored?.followMode ?? false);
  const invalidationRef = useRef<WorkspaceState['invalidationReason']>(undefined);
  // Keep the last accepted snapshot identity synchronously. React's state
  // effect can lag behind a burst of OPENED/SOURCE_INVALIDATED messages, so a
  // same-generation OPENED must not accidentally clear the stale barrier.
  const acceptedSessionRef = useRef<ViewportIdentity | undefined>(undefined);
  const automaticFullDetailKeyRef = useRef<string | undefined>(undefined);
  const selectedDetailKeyRef = useRef<string | undefined>(undefined);
  const detailIntentRef = useRef<{ ref: RecordRef; full: boolean } | undefined>(undefined);
  const sourceUpdateRetryRef = useRef<{ generation: string; attempts: number }>({ generation: '', attempts: 0 });
  const schemaRequestKeyRef = useRef('');
  const schemaRequestIdRef = useRef('');
  const projectionRefreshAttemptRef = useRef('');
  const failedRowsRequestOptionsRef = useRef<RowsRequestOptions | undefined>(undefined);
  const [schemaLoadFailed, setSchemaLoadFailed] = React.useState(false);
  // Keep aggregate failures separate from row projection failures. The
  // latter are local dataset hydration issues and must not replace the main
  // Insights loading/empty state.
  const [insightsRequestError, setInsightsRequestError] = React.useState<string | undefined>(undefined);
  const [lineageLookup, setLineageLookup] = React.useState<LineageLookupState>({ status: 'idle', extraRows: [] });
  const lineageNavigationRef = useRef<LineageNavigation | undefined>(undefined);
  const lineageControllerRef = useRef<RecordLineageUiController | undefined>(undefined);
  if (lineageControllerRef.current === undefined) lineageControllerRef.current = new RecordLineageUiController({
    client: clientRef.current,
    getContext: () => ({ summary: stateRef.current.summary, rows: stateRef.current.rows,
      available: stateRef.current.detailOpen && stateRef.current.detailTab === 'lineage' && stateRef.current.phase === 'ready'
        && !stateRef.current.pending.rows && !stateRef.current.pending.profile && canReadSnapshot(invalidationRef.current) }),
    onChange: setLineageLookup,
  });
  const lineageController = lineageControllerRef.current;
  const lineageRows = useMemo(() => [...state.rows, ...lineageLookup.extraRows], [state.rows, lineageLookup.extraRows]);
  useEffect(() => {
    if (!state.detailOpen || state.detailTab !== 'lineage') lineageController.cancel();
    return () => lineageController.cancel();
  }, [lineageController, state.detailOpen, state.detailTab]);
  const openNavigator = useCallback((): void => {
    // Route through the correlated client so NAVIGATOR_STATUS is accepted by
    // the same request-response gate as every other Host action. A raw
    // postMessage has no pending entry and would be discarded as stale.
    const request = clientRef.current.send('OPEN_SESSION_NAVIGATOR', {});
    dispatch({ type: 'REQUEST_SENT', request });
  }, []);

  const savePreviewAs = useCallback((): void => {
    const session = clientRef.current.session;
    vscode.postMessage(createProtocolEnvelope({
      type: 'SAVE_PREVIEW_AS', documentId: session.documentId, generation: session.generation,
      ...(session.epoch === undefined ? {} : { epoch: session.epoch }),
      delivery: 'request', requestId: crypto.randomUUID(), payload: {},
    }));
  }, []);

  const diagnoseError = useCallback(async (error: NonNullable<WorkspaceState['error']>, action: 'explain' | 'copy'): Promise<void> => {
    const localText = action === 'explain'
      ? formatStartupDiagnosticPrompt(error)
      : formatStartupDiagnosticContext(error);
    let copied = false;
    try {
      copied = await copyText(localText);
    } catch {
      copied = false;
    }
    setDiagnosticActionStatus(action === 'explain'
      ? copied
        ? 'Diagnostic prompt copied. If Chat does not open, paste it manually.'
        : 'Chat handoff attempted. Clipboard unavailable; open diagnostic context and copy it manually.'
      : copied
        ? 'Diagnostic context copied.'
        : 'Clipboard unavailable; open diagnostic context and copy it manually.');
    const session = clientRef.current.session;
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `diagnostic-${Date.now().toString(36)}`;
    try {
      vscode.postMessage(createProtocolEnvelope({
        type: 'DIAGNOSE_ERROR',
        documentId: session.documentId,
        generation: session.generation,
        ...(session.epoch === undefined ? {} : { epoch: session.epoch }),
        delivery: 'request',
        requestId,
        payload: {
          code: error.code.slice(0, MAX_DIAGNOSTIC_CODE_LENGTH),
          message: error.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
          action,
        },
      }));
    } catch {
      setDiagnosticActionStatus((current) => current === undefined
        ? 'The host is unavailable. Open diagnostic context and copy it manually.'
        : current);
    }
  }, []);

  useEffect(() => {
    stateRef.current = state;
    analysisIntentRevisionRef.current = Math.max(analysisIntentRevisionRef.current, state.analysisIntentRevision);
    persistedStateRef.current = toPersistedState(state);
    // State persistence is non-critical for first paint. Coalesce bursts of
    // indexing/progress updates and flush the latest snapshot during idle time.
    return deferIdle(() => {
      vscode.setState({ ...persistedStateRef.current, navigatorBridgeState });
    });
  }, [navigatorBridgeState, state]);

  useEffect(() => {
    const flushPersistedState = (): void => {
      vscode.setState({ ...persistedStateRef.current, navigatorBridgeState });
    };
    window.addEventListener('pagehide', flushPersistedState);
    return () => window.removeEventListener('pagehide', flushPersistedState);
  }, [navigatorBridgeState]);

  const finishCancelled = useCallback((kind: RequestKind, ids: string[]): void => {
    for (const requestId of ids) dispatch({ type: 'REQUEST_FINISHED', kind, requestId });
  }, []);

  const cancelReadRequests = useCallback((): void => {
    lineageController.cancel();
    for (const kind of ['rows', 'problems', 'detail', 'schema', 'insights'] as const) {
      finishCancelled(kind, clientRef.current.cancel(kind));
    }
  }, [finishCancelled, lineageController]);

  const revealControllerRef = useRef<WebviewRevealController | undefined>(undefined);
  const loadingRevealRef = useRef(false);
  const queryControllerRef = useRef<RowQueryController | undefined>(undefined);
  if (queryControllerRef.current === undefined) {
    queryControllerRef.current = new RowQueryController({
      client: clientRef.current,
      getContext: () => ({
        workspace: stateRef.current,
        session: clientRef.current.session,
        invalidationReason: invalidationRef.current,
        indexingComplete: indexingCompleteRef.current,
        followMode: followModeRef.current,
      }),
      dispatch,
      cancelReadRequests,
      onPageInputChange: setPageInputState,
      onRowsRequestStarted: () => {
        if (!loadingRevealRef.current) revealControllerRef.current?.invalidate();
        failedRowsRequestOptionsRef.current = undefined;
        setRowsProjectionFailed(false);
      },
      fallbackColumns,
    }, state, PAGE_SIZE);
  }
  const queryController = queryControllerRef.current;
  if (revealControllerRef.current === undefined) {
    revealControllerRef.current = new WebviewRevealController({
      getSession: () => clientRef.current.session,
      isLocal: (message) => !stateRef.current.pending.rows && stateRef.current.rows.some((row) =>
        row.ref.generation === message.generation && row.ref.ordinal === message.payload.anchorOrdinal),
      load: (ordinal) => {
        loadingRevealRef.current = true;
        try { return queryController.revealOrdinal(ordinal)?.id; }
        finally { loadingRevealRef.current = false; }
      },
      acknowledge: (message, payload) => clientRef.current.acknowledgeReveal(message, payload),
      onChange: setRevealTarget,
    });
  }
  const revealController = revealControllerRef.current;
  useEffect(() => {
    if (queuedReveal === undefined || state.activeTab !== 'table') return;
    setQueuedReveal(undefined);
    revealController.begin(queuedReveal);
  }, [queuedReveal, revealController, state.activeTab]);
  const onRevealRendered = useCallback((requestId: string, ordinal: string) => {
    revealController.rendered(requestId, ordinal);
  }, [revealController]);
  useEffect(() => () => revealController.cancel(), [revealController]);
  const requestRows = useCallback((options?: RowsRequestOptions, metadata: RowsRequestMetadata = {}): void => {
    queryController.requestRows(options, metadata);
  }, [queryController]);

  useLayoutEffect(() => {
    const measureWorkspace = (): void => {
      const width = workspaceRef.current?.clientWidth;
      if (width === undefined || width <= 0) return;
      setWorkspaceWidth(width);
    };
    measureWorkspace();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measureWorkspace);
    if (workspaceRef.current !== null) observer?.observe(workspaceRef.current);
    if (observer === undefined) window.addEventListener('resize', measureWorkspace);
    return () => {
      observer?.disconnect();
      if (observer === undefined) window.removeEventListener('resize', measureWorkspace);
    };
  }, []);

  const requestSchema = useCallback((): void => {
    if (!canReadSnapshot(invalidationRef.current)) return;
    const client = clientRef.current;
    finishCancelled('schema', client.cancel('schema'));
    const request = client.send('GET_SCHEMA', { offset: 0, limit: SCHEMA_PAGE_SIZE });
    schemaRequestIdRef.current = request.id;
    setSchemaLoadFailed(false);
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestProblems = useCallback((options?: {
    anchorOrdinal?: string;
    direction?: 'forward' | 'backward';
  }): void => {
    if (!canReadSnapshot(invalidationRef.current)) return;
    const client = clientRef.current;
    finishCancelled('problems', client.cancel('problems'));
    const request = client.send('GET_PROBLEMS', {
      limit: PAGE_SIZE,
      ...(options?.anchorOrdinal === undefined ? {} : { anchorOrdinal: options.anchorOrdinal }),
      ...(options?.direction === undefined ? {} : { direction: options.direction }),
    });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestInsights = useCallback((options?: {
    dimension?: InsightDimension;
    scope?: InsightScope;
    minimumRevision?: number;
    automatic?: boolean;
  }): void => {
    if (!canReadSnapshot(invalidationRef.current)) return;
    const client = clientRef.current;
    if (client.hasPending('profile')) return;
    const workspace = stateRef.current;
    const summary = workspace.summary;
    if (summary?.profileVersion === undefined) return;
    const dimension = options?.dimension ?? workspace.insightDimension;
    const scope = options?.scope ?? workspace.insightScope;
    const predicate = scope === 'current-view' ? compileQueryCondition({
      query: queryController.query,
      filters: queryController.filters,
      ...(queryController.rowTypes === undefined ? {} : { rowTypes: queryController.rowTypes }),
      filterColumns: workspace.columns.length > 0 ? workspace.columns : fallbackColumns(workspace.rows),
    }) : undefined;
    const intentRevision = Math.max(analysisIntentRevisionRef.current, workspace.analysisIntentRevision,
      options?.minimumRevision ?? 0) + 1;
    const intent = {
      version: 1 as const,
      intentRevision,
      dimension,
      scope,
      document: {
        documentId: summary.snapshot.documentId,
        generation: summary.snapshot.generation,
        ...(summary.snapshot.epoch === undefined ? {} : { sourceEpoch: summary.snapshot.epoch }),
      },
      profile: { id: summary.profileId, version: summary.profileVersion },
      ...(predicate === undefined ? {} : { predicate }),
    };
    if (!shouldIssueInsightRequest(intent, workspace.failedAnalysisIntent, options?.automatic === true)) return;
    finishCancelled('insights', client.cancel('insights'));
    analysisIntentRevisionRef.current = intentRevision;
    setInsightsRequestError(undefined);
    dispatch({ type: 'SET_ANALYSIS_INTENT', intent });
    const request = client.send('GET_INSIGHTS', {
      intent,
    });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled, queryController]);

  const requestDetail = useCallback((ref: RecordRef, full = false, select = true): void => {
    const client = clientRef.current;
    if (ref.generation !== client.session.generation) return;
    if (select) {
      lineageController.cancel();
      if (!lineageNavigationRef.current?.isNavigating()) lineageNavigationRef.current?.reset();
    }
    if (select) queryController.pauseFollowing();
    selectedDetailKeyRef.current = recordRefKey(ref);
    if (select) automaticFullDetailKeyRef.current = undefined;
    detailIntentRef.current = { ref, full };
    finishCancelled('detail', client.cancel('detail'));
    if (select) dispatch({ type: 'SELECT_ROW', ref, ordinal: ref.ordinal });
    if (!canReadSnapshot(invalidationRef.current)) return;
    const request = client.send('GET_DETAIL', { ref, ...(full ? { full: true } : {}) });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled, lineageController, queryController]);

  const lineageNavigation = useLineageNavigation({ state, getState: () => stateRef.current, getDocumentId: () => clientRef.current.session.documentId,
    requestDetail, revealOrdinal: (ordinal) => queryController.revealOrdinal(ordinal)?.id, gridFocusBridgeRef,
    showTable: () => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'table' }), showTree: () => dispatch({ type: 'SET_DETAIL_TAB', tab: 'tree' }) });
  lineageNavigationRef.current = lineageNavigation;

  const closeDetail = useCallback((): void => {
    lineageController.cancel(); lineageNavigationRef.current?.reset();
    detailIntentRef.current = undefined;
    finishCancelled('detail', clientRef.current.cancel('detail'));
    dispatch({ type: 'CLOSE_DETAIL' });
  }, [finishCancelled, lineageController]);

  const setColumnWidth = useCallback((columnId: string, width: number | undefined): void => {
    dispatch({ type: 'SET_COLUMN_WIDTH', columnId, width });
  }, []);

  const setColumnOrder = useCallback((order: string[]): void => {
    dispatch({ type: 'SET_COLUMN_ORDER', order });
  }, []);

  const setSortDirection = useCallback((direction: SortDirection): void => {
    queryController.requestRowOrder(direction);
  }, [queryController]);

  const rebuild = useCallback((): void => {
    queryController.rebuild();
  }, [queryController]);

  useEffect(() => {
    const error = state.error;
    if (error?.code !== 'SOURCE_UPDATING' || state.summary === undefined) {
      if (error === undefined) sourceUpdateRetryRef.current = { generation: '', attempts: 0 };
      return;
    }
    const generation = state.summary.snapshot.generation;
    if (sourceUpdateRetryRef.current.generation !== generation) {
      sourceUpdateRetryRef.current = { generation, attempts: 0 };
    }
    if (sourceUpdateRetryRef.current.attempts >= 8) return;
    sourceUpdateRetryRef.current.attempts += 1;
    const timer = window.setTimeout(() => {
      const intent = detailIntentRef.current;
      if (intent !== undefined && stateRef.current.detailOpen) requestDetail(intent.ref, intent.full, false);
      else requestRows();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [requestDetail, requestRows, state.error, state.summary]);

  useEffect(() => {
    if (
      canReadSnapshot(state.invalidationReason)
      && state.activeTab === 'problems'
      && state.summary
      && !state.problems
      && !state.pending.problems
    ) {
      requestProblems();
    }
  }, [requestProblems, state.activeTab, state.invalidationReason, state.pending.problems, state.problems, state.summary]);

  const onMessage = useEffectEvent((event: MessageEvent<unknown>): void => {
      const message = clientRef.current.accept(event.data);
      if (!message) return;
      lineageNavigation.receive(message);
      if (lineageController.receive(message)) return;
      if (message.type === 'ERROR' && stateRef.current.pending.insights?.id === message.requestId) {
        setInsightsRequestError(message.payload.message);
      } else if (message.type === 'INSIGHTS' && stateRef.current.pending.insights?.id === message.requestId) {
        setInsightsRequestError(undefined);
      }
      if (message.type === 'ERROR' && stateRef.current.pending.rows?.id === message.requestId) {
        failedRowsRequestOptionsRef.current = queryController.retryOptionsFor(message.requestId);
        setRowsProjectionFailed(true);
      } else if (message.type === 'ROWS') {
        failedRowsRequestOptionsRef.current = undefined;
        setRowsProjectionFailed(false);
      }
      if (message.type === 'PREVIEW_STATUS') { setPreviewStatus(message.payload); return; }
      if (message.type === 'NAVIGATOR_VISIBILITY') { setNavigatorVisible(message.payload.visible); return; }
      if (message.type === 'NAVIGATOR_STATUS') setNavigatorBridgeState(navigatorUiState(message.payload));
      if (message.type === 'ERROR' && stateRef.current.pending.rows?.id === message.requestId) {
        const failedState = stateRef.current;
        if (failedState.page !== undefined && failedState.summary !== undefined) {
          const required = rowProjectionPlanForView(
            failedState.activeTab,
            failedState.displayMode,
            failedState.summary.profileId,
          );
          const available = failedState.page.projection ?? legacyRowProjectionPlan(
            failedState.pageProjectionProfileId ?? failedState.summary.profileId,
          );
          if (!rowProjectionPlanCovers(available, required)) {
            projectionRefreshAttemptRef.current = projectionIntentKey(failedState, required);
          }
        }
      }
      if (message.type === 'ERROR' && acceptedSessionRef.current === undefined
        && startupReadyIdsRef.current.has(message.requestId)) {
        startupErrorRef.current = true;
        startupStopRef.current?.();
        if (!startupStagesRef.current.error) {
          startupStagesRef.current.error = true;
          reportStartupStage('startup-error', bodySession());
        }
      }
      const currentFollowMode = followModeRef.current;
      const firstOpenedSession = message.type === 'OPENED' && acceptedSessionRef.current === undefined;
      const openedGenerationChanged = message.type === 'OPENED'
        && snapshotIdentityChanged(acceptedSessionRef.current, message.payload.snapshot);
      if (message.type === 'SOURCE_INVALIDATED') {
        invalidationRef.current = nextInvalidationReason(invalidationRef.current, message.payload.reason);
      } else if (openedGenerationChanged) invalidationRef.current = undefined;
      if (openedGenerationChanged || message.type === 'DETAIL') {
        detailIntentRef.current = undefined;
      }
      if (openedGenerationChanged || message.type === 'PROFILE_CHANGED') {
        selectedDetailKeyRef.current = undefined;
        automaticFullDetailKeyRef.current = undefined;
        if (message.type === 'PROFILE_CHANGED') detailIntentRef.current = undefined;
      }
      if (message.type === 'REVEAL') {
        dispatch({ type: 'SET_ACTIVE_TAB', tab: 'table' });
        queryController.pauseFollowing();
        dispatch({ type: 'SELECT_ROW', ordinal: message.payload.anchorOrdinal });
        setQueuedReveal(message);
        dispatch({ type: 'CLOSE_DETAIL' });
      } else if (message.type === 'SOURCE_INVALIDATED' || openedGenerationChanged || message.type === 'PROFILE_CHANGED') {
        setQueuedReveal(undefined);
        revealController.invalidate();
      } else if (message.type === 'ROWS') {
        revealController.rowsAccepted(message.requestId, message.payload);
      } else if (message.type === 'ERROR') revealController.requestFailed(message.requestId, message.payload.code);
      if (message.type === 'OPENED') {
        if (openedGenerationChanged) setSchemaLoadFailed(false);
        indexingCompleteRef.current = message.payload.indexingComplete;
        acceptedSessionRef.current = {
          documentId: message.payload.snapshot.documentId,
          generation: message.payload.snapshot.generation,
          ...(message.payload.snapshot.epoch === undefined ? {} : { epoch: message.payload.snapshot.epoch }),
        };
        if (firstOpenedSession && !startupStagesRef.current.opened) {
          startupStopRef.current?.();
          startupStagesRef.current.opened = true;
          reportStartupStage('opened-accepted', message.payload.snapshot);
        }
      } else if (message.type === 'INDEX_PROGRESS'
        && acceptedSessionRef.current?.generation === message.generation) {
        indexingCompleteRef.current = message.payload.indexingComplete;
      }
      const followUp = queryController.handleAcceptedMessage(message, { firstOpenedSession, openedGenerationChanged });
      if (message.type === 'SCHEMA' && message.requestId === schemaRequestIdRef.current) {
        setSchemaLoadFailed(false);
      } else if (message.type === 'ERROR' && message.requestId === schemaRequestIdRef.current) {
        setSchemaLoadFailed(true);
      }
      dispatch({ type: 'MESSAGE_RECEIVED', message });
      if (message.type === 'SOURCE_INVALIDATED') {
        if (invalidationRef.current === 'append') {
          for (const kind of ['profile', 'follow'] as const) finishCancelled(kind, clientRef.current.cancel(kind));
        } else {
          cancelReadRequests();
          for (const kind of ['profile', 'follow'] as const) finishCancelled(kind, clientRef.current.cancel(kind));
        }
      }
      followUp();
      if (message.type === 'OPENED' && currentFollowMode && openedGenerationChanged) {
        const request = clientRef.current.send('SET_FOLLOW_MODE', { enabled: true });
        dispatch({ type: 'REQUEST_SENT', request });
      }
  });

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const payload = restored === undefined ? {} : { restoredState: restored };
    const stop = startStartupHandshake(
      () => {
        const request = clientRef.current.send('READY', payload);
        startupReadyIdsRef.current.add(request.id);
        dispatch({ type: 'REQUEST_SENT', request });
      },
      () => acceptedSessionRef.current !== undefined || startupErrorRef.current,
      () => {
        dispatch({ type: 'STARTUP_TIMEOUT' });
        if (!startupStagesRef.current.error) {
          startupStagesRef.current.error = true;
          reportStartupStage('startup-error', bodySession());
        }
        vscode.postMessage({ type: 'JSONLVIEW_DIAGNOSTIC', diagnosticProtocolVersion: JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION,
          name: 'StartupTimeout', message: 'OPENED was not received after three READY attempts' });
      },
    );
    startupStopRef.current = stop;
    return () => {
      stop();
      if (startupStopRef.current === stop) startupStopRef.current = undefined;
    };
  }, [restored]);

  useEffect(() => {
    if (startupStagesRef.current.page || state.page === undefined || state.summary === undefined) return;
    const session = acceptedSessionRef.current;
    if (session?.documentId !== state.summary.snapshot.documentId
      || session.generation !== state.summary.snapshot.generation) return;
    startupStagesRef.current.page = true;
    reportStartupStage('page-committed', session, state.rows.length);
  }, [state.page, state.rows, state.summary]);

  useEffect(() => {
    const summary = state.summary;
    if (!summary || !canReadSnapshot(state.invalidationReason) || state.pending.schema) return;
    const stage = summary.indexingComplete ? 'complete' : state.columns.length > 0 ? 'rows' : 'open';
    const key = `${summary.snapshot.generation}:${stage}`;
    if (schemaRequestKeyRef.current === key) return;
    schemaRequestKeyRef.current = key;
    requestSchema();
  }, [requestSchema, state.columns.length, state.invalidationReason, state.pending.schema, state.summary]);

  useEffect(() => {
    if (!state.page || state.pending.rows || revealController.pending || queuedReveal !== undefined || !state.summary
      || !canReadSnapshot(state.invalidationReason)
      || state.summary.snapshot.generation !== clientRef.current.session.generation) return;
    const selected = selectedRecordColumns(state.columns, state.schema, state.columnVisibility);
    if (!selected?.some((column) => state.columnVisibility[column.id] === true
      && !state.columns.some((current) => current.id === column.id))) return;
    const viewport = queryController.currentViewportOptions();
    requestRows({ ...viewport, columns: selected }, { preserveOnRebuild: true });
  }, [requestRows, queuedReveal, revealController.pending, state.columnVisibility, state.columns, state.invalidationReason,
    state.page, state.pending.rows, state.schema, state.summary, queryController.currentViewportOptions]);

  useEffect(() => {
    if (!state.page || state.pending.rows || revealController.pending || queuedReveal !== undefined || !state.summary
      || !canReadSnapshot(state.invalidationReason)
      || state.summary.snapshot.generation !== clientRef.current.session.generation) return;
    const required = rowProjectionPlanForView(state.activeTab, state.displayMode, state.summary.profileId);
    const available = state.page.projection ?? legacyRowProjectionPlan(
      state.pageProjectionProfileId ?? state.summary.profileId,
    );
    if (rowProjectionPlanCovers(available, required)) {
      projectionRefreshAttemptRef.current = '';
      return;
    }
    const intent = projectionIntentKey(state, required);
    if (projectionRefreshAttemptRef.current === intent) return;
    projectionRefreshAttemptRef.current = intent;
    requestRows(queryController.currentViewportOptions(), { preserveOnRebuild: true });
  }, [requestRows, queuedReveal, revealController.pending, state.activeTab, state.displayMode, state.filters, state.invalidationReason,
    state.page, state.pageProjectionProfileId, state.pending.rows, state.query, state.rowTypes, state.sort, state.summary,
    queryController.currentViewportOptions, state]);

  useEffect(() => {
    if (state.pending.insights && state.analysisIntent === undefined) {
      finishCancelled('insights', clientRef.current.cancel('insights'));
      return;
    }
    if (
      canReadSnapshot(state.invalidationReason)
      && state.activeTab === 'insights'
      && state.summary
      && !state.insights
      && !state.pending.insights
      && !state.pending.profile
    ) {
      requestInsights({ automatic: true, minimumRevision: state.analysisIntentRevision });
    }
    if (state.activeTab !== 'insights' && state.pending.insights) {
      finishCancelled('insights', clientRef.current.cancel('insights'));
    }
  }, [finishCancelled, requestInsights, state.activeTab, state.analysisIntent, state.invalidationReason,
    state.analysisIntentRevision, state.insights, state.pending.insights, state.pending.profile,
    state.summary]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (shouldCloseDetailOnEscape(event.key, stateRef.current)) {
        closeDetail();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeDetail]);

  const summary = state.summary;
  const profileOptions = profileOptionList(
    summary?.profileId,
    summary?.profileSuggestions ?? [],
  );
  const baseColumns = useMemo(
    () => workspaceBaseColumns(state.columns, state.rows),
    [state.columns, state.rows],
  );
  const selectedRecordIds = selectedRecordColumnIds(baseColumns, state.schema, state.columnVisibility);
  const availableColumns = useMemo(
    () => workspaceAvailableColumns(baseColumns, state.schema, state.columnVisibility),
    [baseColumns, state.schema, state.columnVisibility],
  );
  const recordColumnLimit = workspaceRecordColumnLimit(baseColumns);
  const filterableColumns = availableColumns;
  const tableColumns = workspaceTableColumns(baseColumns, state.columnVisibility, state.columnOrder);
  const timelineRows = selectTimelineRows(state);
  const problems = selectProblems(state);
  const problemEntries = state.problems === undefined
    ? problems
    : state.problems.items.map((problem) => ({
      ...problem,
      ...(problem.ref?.ordinal === undefined ? {} : { ordinal: problem.ref.ordinal }),
    }));
  const drawerOpen = state.detailOpen;

  useEffect(() => {
    if (!state.detailStale || state.rebuildDetail === undefined || state.pending.detail
      || !state.summary || !canReadSnapshot(state.invalidationReason)
      || !canReadSnapshot(invalidationRef.current)) return;
    // A recovery page is intentionally bounded and may not contain the pinned
    // record.  A rebased intent proves this is the same physical append-only
    // source, so request the detail directly by byte coordinates. Keep the
    // old payload marked stale until the response arrives; never relabel
    // cached content as the new snapshot.
    const ref = state.rebuildDetail.ref.generation === state.summary.snapshot.generation
      ? state.rebuildDetail.ref
      : undefined;
    if (ref === undefined) return;
    const key = `rebuild:${recordRefKey(ref)}`;
    if (automaticFullDetailKeyRef.current === key) return;
    automaticFullDetailKeyRef.current = key;
    requestDetail(ref, true, false);
  }, [requestDetail, state.detailStale, state.invalidationReason, state.pending.detail, state.rebuildDetail, state.summary]);

  useEffect(() => {
    const ref = state.selectedRef;
    if (!state.detailOpen || ref === undefined || state.detailStale || state.pending.detail
      || !canReadSnapshot(state.invalidationReason) || !canReadSnapshot(invalidationRef.current)
      || sameRecordRef(state.detail?.ref, ref)) return;
    const key = recordRefKey(ref);
    if (selectedDetailKeyRef.current === key) return;
    requestDetail(ref, false, false);
  }, [requestDetail, state.detail, state.detailOpen, state.detailStale, state.invalidationReason, state.pending.detail, state.selectedRef]);

  useEffect(() => {
    const detail = state.detail;
    if (detail === undefined || state.selectedOrdinal !== detail.ref.ordinal) {
      return;
    }
    if (state.detailStale) return;
    if (
      !canReadSnapshot(state.invalidationReason)
      || !canReadSnapshot(invalidationRef.current)
      || !shouldAutomaticallyHydrateSelectedRecord(
        detail,
        state.selectedOrdinal,
        drawerOpen,
        Boolean(state.pending.detail),
      )
    ) {
      return;
    }

    const key = `full:${recordRefKey(detail.ref)}`;
    if (automaticFullDetailKeyRef.current === key) return;
    automaticFullDetailKeyRef.current = key;
    requestDetail(detail.ref, true, false);
  }, [drawerOpen, requestDetail, state.detail, state.detailStale, state.invalidationReason, state.pending.detail, state.selectedOrdinal]);

  const overlayDetail = isOverlayDetailWorkspace(workspaceWidth);
  const displayedDetailWidth = clampDetailWidth(state.detailWidth, workspaceWidth);
  const detailSplitter = useDetailSplitter({
    readContainerWidth: () => workspaceRef.current?.clientWidth ?? window.innerWidth,
    readPointerStartWidth: () => displayedDetailWidth,
    readKeyboardStartWidth: () => displayedDetailWidth,
    setWidth: (width) => dispatch({ type: 'SET_DETAIL_WIDTH', width }),
    pauseFollowing: () => queryController.pauseFollowing(),
  });
  const selectedFilterColumn = useMemo(
    () => filterableColumns.find((column) => column.id === filterColumnId),
    [filterColumnId, filterableColumns],
  );
  const availableFilterOperators = useMemo(
    () => selectedFilterColumn?.source === 'profile'
      ? filterOperators.filter((operator) => operator.value !== 'kind_is')
      : filterOperators,
    [selectedFilterColumn],
  );

  useEffect(() => {
    if (filterableColumns.length === 0) return;
    if (!filterableColumns.some((column) => column.id === filterColumnId)) {
      setFilterColumnId(filterableColumns[0]!.id);
    }
  }, [filterColumnId, filterableColumns]);

  useEffect(() => {
    if (availableFilterOperators.some((operator) => operator.value === filterOperator)) return;
    const fallback = availableFilterOperators[0]?.value;
    if (fallback !== undefined) setFilterOperator(fallback);
  }, [availableFilterOperators, filterOperator]);

  const submitStructuredFilter = (): void => {
    const filter = buildStructuredFilter({
      columnId: filterColumnId,
      operator: filterOperator,
      value: filterValue,
      caseSensitive: filterCaseSensitive,
      selectedColumn: selectedFilterColumn,
      filterColumns: filterableColumns,
    });
    if (filter === undefined) return;
    queryController.applyFilters([...queryController.filters, filter]);
  };

  const setProfile = (profileId: string): void => {
    if (invalidationRef.current !== undefined) return;
    queryController.abandonRestore();
    finishCancelled('insights', clientRef.current.cancel('insights'));
    finishCancelled('profile', clientRef.current.cancel('profile'));
    const request = clientRef.current.send('SET_PROFILE', { profileId });
    dispatch({ type: 'REQUEST_SENT', request });
  };

  const setFollow = (enabled: boolean): void => {
    if (invalidationRef.current !== undefined) return;
    queryController.abandonRestore();
    followModeRef.current = enabled;
    dispatch({ type: 'SET_FOLLOW_MODE', enabled });
    finishCancelled('follow', clientRef.current.cancel('follow'));
    const request = clientRef.current.send('SET_FOLLOW_MODE', { enabled });
    dispatch({ type: 'REQUEST_SENT', request });
    if (enabled) queryController.returnToLatest();
  };

  const returnToLatest = (): void => {
    queryController.returnToLatest();
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'table' });
    setFilterValue('');
  };

  const reportTailVisible = useCallback((ref: RecordRef): void => {
    dispatch({ type: 'TAIL_VISIBLE', generation: ref.generation, ordinal: ref.ordinal, indexedRecords: state.latestSeq });
  }, [state.latestSeq]);

  const pauseFollowing = useCallback((ref?: RecordRef): void => {
    queryController.pauseFollowing(ref);
  }, [queryController]);

  const reportViewport = useCallback((ref: RecordRef): void => {
    queryController.reportViewport(ref);
  }, [queryController]);

  const resumeFollowingAtTail = useCallback((ref: RecordRef): boolean => {
    return queryController.resumeFollowingAtTail(ref);
  }, [queryController]);

  const selectProblem = (ordinal: string): void => {
    const problem = state.problems?.items.find((candidate) => candidate.ref?.ordinal === ordinal);
    const row = state.rows.find((candidate) => candidate.ref.ordinal === ordinal);
    const ref = problem?.ref ?? row?.ref;
    if (ref) {
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'table' });
      requestDetail(ref);
    }
  };

  const continueProblems = useCallback((): void => {
    const page = stateRef.current.problems;
    if (page === undefined || !page.hasAfter || stateRef.current.pending.problems) return;
    requestProblems({
      anchorOrdinal: page.scan.cursorOrdinal ?? page.anchorOrdinal,
      direction: 'forward',
    });
  }, [requestProblems]);

  const nextPage = (): void => queryController.nextPage();
  const previousPage = (): void => queryController.previousPage();
  const jumpToPage = (): void => queryController.submitPageInput();

  const pageRange = workspacePageRange(state.rows);
  const partialScan = workspacePartialScan(state.page);
  const datasetSummary = useMemo(
    () => workspaceDatasetSummary(state.rows, partialScan),
    [state.rows, partialScan],
  );
  const bfclSummary = useMemo(
    () => workspaceBfclSummary(state.rows, partialScan),
    [state.rows, partialScan],
  );
  const opentelemetrySummary = useMemo(
    () => workspaceOpenTelemetrySummary(state.rows, partialScan),
    [state.rows, partialScan],
  );
  const datasetProjectionAvailable = workspaceDatasetProjectionAvailable(state);
  const showRowsProjectionFailure = rowsProjectionFailed && !state.pending.rows;
  const showDatasetProjectionPending = state.pending.rows !== undefined
    && state.page !== undefined
    && (bfclSummary !== undefined || opentelemetrySummary !== undefined || !datasetProjectionAvailable)
    && !showRowsProjectionFailure;
  const showInsightsTransitionStatus = showRowsProjectionFailure || showDatasetProjectionPending;
  const showBfclInsights = bfclSummary !== undefined && datasetProjectionAvailable
    && !state.pending.rows && !showRowsProjectionFailure;
  const showOpenTelemetryInsights = opentelemetrySummary !== undefined
    && state.summary?.profileId === 'opentelemetry'
    && !state.pending.rows && !showRowsProjectionFailure;
  const showPrimaryInsights = !showBfclInsights && !showOpenTelemetryInsights;
  const hasPartialContinuation = workspaceHasPartialContinuation(partialScan, state.sort, state.page);
  const partialBannerIdentity = workspacePartialBannerIdentity(state.page);
  const showPageControls = workspaceShowsPageControls(state.activeTab, state.rows, state.page, hasPartialContinuation);
  const canAdvancePage = state.page?.hasAfter === true && (
    state.sort === undefined
      ? true
      : (() => {
        try {
          const offset = BigInt(state.sortOffset);
          const nextOffset = state.page?.sortNextOffset === undefined
            ? offset + BigInt(PAGE_SIZE)
            : BigInt(state.page.sortNextOffset);
           return canRequestSortedPage(queryController.sort, nextOffset, PAGE_SIZE);
        } catch {
          return false;
        }
      })()
  );

  const queryControlProps: RecordQueryControlsProps = {
    query: state.query,
    searchDisabled: !summary || !canReadSnapshot(state.invalidationReason),
    sortDirection: state.sort?.columnId === '__ordinal' && state.sort.direction === 'desc' ? 'desc' : 'asc',
    descendingDisabled: summary?.indexingComplete !== true
      || state.invalidationReason !== undefined
      || Boolean(state.pending.rebuild)
      || Boolean(state.pending.order),
    descendingDisabledReason: state.invalidationReason !== undefined
      ? 'Rebuild the changed source before reversing row order'
      : state.pending.rebuild
        ? 'Rebuilding the index'
        : state.pending.order
          ? 'Saving the row order preference'
          : 'Indexing the file before reverse order is available',
    onSortDirectionChange: setSortDirection,
    onSearchSubmit: () => {
      const query = queryController.query;
      requestRows({ query });
    },
    onSearchChange: (query) => {
      queryController.pauseFollowing();
      queryController.editQuery(query);
    },
    onSearchClear: () => {
      queryController.releasePageInputFocus();
      queryController.editQuery('');
      requestRows({ query: '' });
    },
    filterActive: state.filters.length > 0,
    filters: state.filters,
    filterableColumns,
    filterColumnId,
    filterOperator,
    filterOperators: availableFilterOperators,
    filterValue,
    filterCaseSensitive,
    onFilterColumnChange: setFilterColumnId,
    onFilterOperatorChange: setFilterOperator,
    onFilterValueChange: setFilterValue,
    onFilterCaseSensitiveChange: setFilterCaseSensitive,
    onFilterSubmit: submitStructuredFilter,
    onFilterClear: () => queryController.applyFilters([]),
    onFilterRemove: (index) => queryController.applyFilters(queryController.filters.filter((_, current) => current !== index)),
  };

  const tableQueryControls = state.activeTab === 'table' ? TableQueryToolbar({
    previewStatus,
    onSaveAs: savePreviewAs,
    queryControls: queryControlProps,
    rowTypes: {
      sources: rowTypeSources(baseColumns, state.schema, state.rows, state.rowTypes),
      selection: state.rowTypes,
      disabled: !summary || !canReadSnapshot(state.invalidationReason),
      onChange: (selection) => queryController.applyRowTypes(selection),
    },
    showColumns: state.displayMode === 'table',
    columns: {
      columns: availableColumns,
      schema: state.schema,
      selectedRecordIds,
      visibility: state.columnVisibility,
      recordColumnLimit,
      schemaComplete: state.schemaComplete,
      schemaLoadFailed,
      onRetrySchema: requestSchema,
      onVisibilityChange: (column, visible) => {
        dispatch({ type: 'SET_COLUMN_VISIBILITY', columnId: column.id, visible });
        if (column.source !== 'record') return;
        const nextVisibility = { ...state.columnVisibility, [column.id]: visible };
        const columns = selectedRecordColumns(baseColumns, state.schema, nextVisibility) ?? [];
        // Retain the current page's bounded projection for display-only
        // changes. Missing fields (including promoted overflow) still
        // require hydration through the existing viewport query.
        if (columns.every((selected) => state.columns.some((current) => current.id === selected.id))) return;
        requestRows({ ...queryController.currentViewportOptions(), columns }, { preserveOnRebuild: true });
      },
    },
  }) : null;

  const openQueryStudio = (): void => {
    studioRestoreFocusRef.current = true;
    const invokingElement = document.activeElement;
    studioTriggerRef.current = invokingElement instanceof HTMLElement ? invokingElement : null;
    const bridge = state.activeTab === 'table' ? gridFocusBridgeRef.current : undefined;
    studioFocusRef.current = bridge?.capture();
    studioFocusGenerationRef.current = bridge?.generation
      ?? (studioFocusRef.current?.kind === 'data' ? studioFocusRef.current.generation : undefined);
    setQueryStudioSize(QUERY_STUDIO_DEFAULT_SIZE);
    setQueryStudioMaximized(false);
    setQueryStudioPinned(false);
    setQueryStudioOpen(true);
  };
  const closeQueryStudio = (restoreFocus = true): void => {
    studioRestoreFocusRef.current = restoreFocus;
    setQueryStudioSize(QUERY_STUDIO_DEFAULT_SIZE);
    setQueryStudioMaximized(false);
    setQueryStudioPinned(false);
    setQueryStudioOpen(false);
  };
  const resizeQueryStudio = (size: QueryStudioSize): void => {
    const next = clampQueryStudioSize(size);
    setQueryStudioSize((current) => current.width === next.width && current.height === next.height ? current : next);
  };
  const recordQueryHistory = (): void => {
    setQueryHistory((current) => addQueryHistory(current, queryController.query, queryController.filters));
  };
  const runQueryStudio = (): void => {
    if (!stateRef.current.summary || !canReadSnapshot(invalidationRef.current) || clientRef.current.hasPending('rows')) return;
    recordQueryHistory();
    requestRows({ query: queryController.query });
    if (!queryStudioPinned) closeQueryStudio();
  };
  const cancelQueryStudio = (): void => {
    queryController.cancelRows();
    closeQueryStudio();
  };
  const selectQueryHistory = (entry: QueryHistoryEntry): void => {
    // Applying a history item intentionally makes its query the active
    // workspace query; only the bounded history collection remains ephemeral.
    queryController.editQuery(entry.query);
    queryController.applyFilters(entry.filters);
  };

  const studioQueryControlProps: RecordQueryControlsProps = {
    ...queryControlProps,
    onSearchSubmit: runQueryStudio,
    onFilterSubmit: () => {
      queryControlProps.onFilterSubmit();
      recordQueryHistory();
    },
  };

  const observedStudioGeneration = state.summary?.snapshot.generation;

  useLayoutEffect(() => {
    const wasOpen = priorStudioOpenRef.current;
    if (!queryStudioOpen && wasOpen) {
      const capturedCell = studioFocusRef.current;
      const capturedGeneration = studioFocusGenerationRef.current;
      const bridge = gridFocusBridgeRef.current;
      const canRestoreGrid = capturedCell !== undefined
        && bridge !== undefined
        && capturedGeneration !== undefined
        && (capturedCell.kind !== 'data' || capturedCell.generation === capturedGeneration)
        && bridge.generation === capturedGeneration
        && (observedStudioGeneration === undefined || observedStudioGeneration === capturedGeneration);
      if (studioRestoreFocusRef.current) {
        if (canRestoreGrid) {
          if (!bridge.restore(capturedCell)) {
            const trigger = studioTriggerRef.current;
            if (trigger?.isConnected === true) trigger.focus({ preventScroll: true });
          }
        } else {
          const trigger = studioTriggerRef.current;
          if (trigger?.isConnected === true) trigger.focus({ preventScroll: true });
        }
      }
      studioFocusRef.current = undefined;
      studioTriggerRef.current = null;
      studioFocusGenerationRef.current = undefined;
    }
    priorStudioOpenRef.current = queryStudioOpen;
  }, [observedStudioGeneration, queryStudioOpen]);

  useEffect(() => {
    const generation = observedStudioGeneration ?? clientRef.current.session.generation;
    if (generation === studioGenerationRef.current) return;
    studioGenerationRef.current = generation;
    studioRestoreFocusRef.current = false;
    setQueryStudioSize(QUERY_STUDIO_DEFAULT_SIZE);
    setQueryStudioMaximized(false);
    setQueryHistory([]);
    setQueryStudioPinned(false);
    setQueryStudioOpen(false);
  }, [observedStudioGeneration]);

  const workspaceStyle = drawerOpen
    ? ({ '--detail-pane-width': `${displayedDetailWidth}px` } as CSSProperties)
    : undefined;

  return (
    <div className="app-shell" onFocusCapture={(event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type !== 'checkbox') queryController.pauseFollowing();
    }}>
      <WorkspaceHeader
        indexedBytes={summary?.indexedBytes ?? '0'}
        sizeBytes={summary?.snapshot.sizeBytes ?? '0'}
        indexedRecords={summary?.indexedRecords ?? '0'}
        validRecords={summary?.validRecords ?? '0'}
        problemRecords={summary?.problemRecords ?? '0'}
        complete={summary?.indexingComplete ?? false}
        phase={state.invalidationReason === 'append' ? 'snapshot' : state.phase}
        appendPending={state.invalidationReason === 'append'}
        rebuildAvailable={summary !== undefined && state.invalidationReason !== undefined}
        rebuildBusy={Boolean(state.pending.rebuild)}
        navigatorVisible={navigatorVisible}
        onRebuild={rebuild}
        onOpenNavigator={openNavigator}
        navigation={
          <nav {...workspaceTabs.tabListProps} className="workspace-tabs" aria-label="Workspace views">
            {tabs.map(({ id, label, icon: Icon }) => {
              const count = id === 'timeline' ? timelineRows.length : id === 'problems' ? problemEntries.length : undefined;
              return (
                <button type="button" className={state.activeTab === id ? 'is-active' : ''}
                  aria-label={label + (count === undefined ? '' : ', ' + String(count) + (id === 'problems' ? ' entries' : ''))}
                  title={label}
                  {...workspaceTabs.getTabProps(id)} key={id}>
                  <Icon size={14} aria-hidden /><span className="workspace-tab-label">{label}</span>
                  {count !== undefined ? <span className="tab-count" aria-hidden="true"
                    title={id === 'problems' ? 'Problem entries in the current scan page; the status strip counts distinct problem records observed so far' : undefined}>
                    {count}{id === 'problems' ? <span className="tab-count-unit">entries</span> : null}
                  </span> : null}
                </button>
              );
            })}
          </nav>
        }
        secondary={(
          <>
            <TopQueryStudio
              open={queryStudioOpen}
              pinned={queryStudioPinned}
              size={queryStudioSize}
              maximized={queryStudioMaximized}
              queryControls={studioQueryControlProps}
              history={queryHistory}
              pending={Boolean(state.pending.rows)}
              disabled={!summary || !canReadSnapshot(state.invalidationReason)}
              onToggle={() => queryStudioOpen ? closeQueryStudio() : openQueryStudio()}
              onTogglePin={() => setQueryStudioPinned((current) => !current)}
              onSizeChange={resizeQueryStudio}
              onToggleMaximize={() => setQueryStudioMaximized((current) => !current)}
              onClose={closeQueryStudio}
              onRun={runQueryStudio}
              onCancel={cancelQueryStudio}
              onHistorySelect={selectQueryHistory}
            />
            {tableQueryControls}
          </>
        )}
      >
        <div className="toolbar-context" title="File identity is provided by the VS Code editor tab">
          <span className="toolbar-context-mark" aria-hidden>JSONL</span>
          {previewStatus && state.activeTab !== 'table' ? <TemporaryPreviewActions status={previewStatus} onSaveAs={savePreviewAs} /> : null}
        </div>
        <label className="compact-field profile-field" title="Profile controls semantic field labels and dataset projections">
          <span className="profile-label">Profile</span>
          <span className="profile-control">
            <select
              aria-label="Profile"
              value={summary?.profileId ?? 'generic'}
              disabled={!summary || state.invalidationReason !== undefined || Boolean(state.pending.profile)}
              onChange={(event) => setProfile(event.target.value)}
            >
              {profileOptions.options.map((option) => (
                <option value={option.id} key={option.id}>{option.displayName}</option>
              ))}
            </select>
            {profileOptions.suggested ? (
              <span
                className="profile-suggestion"
                role="note"
                title={`Suggested for this file: ${profileOptions.suggested.displayName}`}
                aria-label={`Suggested profile: ${profileOptions.suggested.displayName}`}
              >
                Suggested
              </span>
            ) : null}
            {summary?.datasetProvenance ? (
              <span
                className={`dataset-head-status dataset-head-status-${summary.datasetProvenance.status}`}
                role="status"
                title={datasetProvenanceTooltip(summary.datasetProvenance)}
                aria-label={datasetProvenanceTooltip(summary.datasetProvenance)}
              >
                head sample: {summary.datasetProvenance.status}
              </span>
            ) : null}
          </span>
        </label>
        <label className="follow-toggle" title="Follow appended records">
            <input
              aria-label="Follow appended records"
              type="checkbox"
              checked={state.followMode}
              disabled={!summary || state.invalidationReason !== undefined || Boolean(state.pending.follow)}
            onChange={(event) => setFollow(event.target.checked)}
          />
          <span>Follow</span>
        </label>
      </WorkspaceHeader>

      {state.invalidationReason !== undefined && state.invalidationReason !== 'append' ? (
        <div className="workspace-banner invalidated-banner" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>Source changed ({state.invalidationReason ?? 'unknown'}). This view is a stale snapshot.</span>
        </div>
      ) : null}
      {state.error && (state.error.code !== 'SOURCE_UPDATING' || state.summary === undefined) ? (
        <div className={`workspace-banner error-banner${state.error.recoverable ? ' is-recoverable' : ''}`} role="alert">
          <CircleAlert size={15} aria-hidden />
          <span><strong>{state.error.code}</strong> {state.error.message}</span>
            <button type="button" className="error-action" onClick={() => { void diagnoseError(state.error!, 'explain'); }}>Explain with VS Code Chat</button>
            <button type="button" className="error-action" onClick={() => { void diagnoseError(state.error!, 'copy'); }}>Copy context</button>
            <details className="diagnostic-context-fallback">
              <summary>View diagnostic context</summary>
              <div className="diagnostic-context-panel">
                <pre>{formatStartupDiagnosticContext(state.error)}</pre>
                <button
                  type="button"
                  className="diagnostic-context-copy"
                  aria-label="Copy diagnostic context"
                  title="Copy diagnostic context"
                  onClick={() => { void diagnoseError(state.error!, 'copy'); }}
                >
                  <Copy size={13} aria-hidden />
                  <span>Copy context</span>
                </button>
              </div>
            </details>
            {diagnosticActionStatus ? <span className="diagnostic-action-status" role="status" aria-live="polite">{diagnosticActionStatus}</span> : null}
            {state.error.recoverable && state.summary !== undefined ? (
              <button type="button" aria-label="Dismiss error" title="Dismiss error" onClick={() => dispatch({ type: 'DISMISS_ERROR' })}>
                <X size={14} aria-hidden />
              </button>
            ) : null}
        </div>
      ) : null}

      <WorkspaceSurface
        lineageRows={lineageRows}
        lineageNotice={lineageNavigation.notice}
        onSelectLineageRecord={(ref) => lineageNavigation.select(ref)}
        lineageControls={{ lookup: lineageLookup, onLookup: (ref, relation) => lineageController.lookup(ref, relation),
          onCancelLookup: () => lineageController.cancel(), onRevealRecord: (ref) => lineageNavigation.select(ref, true),
          returnRef: lineageNavigation.history.at(-1), onBack: lineageNavigation.back, pageRows: state.rows.length }}
        revealTarget={revealTarget}
        onRevealRendered={onRevealRendered}
        state={state}
        workspaceRef={workspaceRef}
        workspaceStyle={workspaceStyle}
        getPanelProps={workspaceTabs.getPanelProps}
        clientDocumentId={clientRef.current.session.documentId}
        tableColumns={tableColumns}
        partialBannerIdentity={partialBannerIdentity}
        timelineRows={timelineRows}
        problemEntries={problemEntries}
        gridFocusBridgeRef={gridFocusBridgeRef}
        showPrimaryInsights={showPrimaryInsights}
        showInsightsTransitionStatus={showInsightsTransitionStatus}
        showRowsProjectionFailure={showRowsProjectionFailure}
        showBfclInsights={showBfclInsights}
        showOpenTelemetryInsights={showOpenTelemetryInsights}
        snapshotReadable={canReadSnapshot(state.invalidationReason)}
        datasetSummary={datasetSummary}
        datasetProjectionAvailable={datasetProjectionAvailable}
        bfclSummary={bfclSummary}
        opentelemetrySummary={opentelemetrySummary}
        insightsRequestError={insightsRequestError}
        showPageControls={showPageControls}
        canAdvancePage={canAdvancePage}
        pageInput={pageInput}
        pageRange={pageRange}
        drawerOpen={drawerOpen}
        overlayDetail={overlayDetail}
        drawerId={drawerId}
        displayedDetailWidth={displayedDetailWidth}
        detailWidthMin={MIN_DETAIL_WIDTH}
        detailWidthMax={maxDetailWidth(workspaceWidth)}
        detailWidthText={detailWidthValueText(displayedDetailWidth)}
        detailSplitter={detailSplitter}
        onRequestDetail={requestDetail}
        onColumnWidthChange={setColumnWidth}
        onColumnOrderChange={setColumnOrder}
        onReadingAnchor={pauseFollowing}
        onViewportAnchor={reportViewport}
        onTailVisible={reportTailVisible}
        onManualTailVisible={resumeFollowingAtTail}
        onReturnToLatest={returnToLatest}
        onSelectProblem={selectProblem}
        onContinueProblems={continueProblems}
        onRetryRows={() => {
          const retryOptions = failedRowsRequestOptionsRef.current
            ?? queryController.currentViewportOptions();
          failedRowsRequestOptionsRef.current = undefined;
          setRowsProjectionFailed(false);
          requestRows({ ...retryOptions,
            projection: { conversation: false, dataset: true } }, { preserveOnRebuild: true });
        }}
        onInsightDimensionChange={(dimension) => {
          dispatch({ type: 'SET_INSIGHT_DIMENSION', dimension });
          requestInsights({ dimension, minimumRevision: state.analysisIntentRevision + 1 });
        }}
        onInsightScopeChange={(scope) => {
          dispatch({ type: 'SET_INSIGHT_SCOPE', scope });
          requestInsights({ scope, minimumRevision: state.analysisIntentRevision + 1 });
        }}
        onInsightRefresh={() => requestInsights()}
        onPreviousPage={previousPage}
        onNextPage={nextPage}
        onJumpToPage={jumpToPage}
        onPageInputFocus={() => queryController.focusPageInput(true)}
        onPageInputChange={(value) => queryController.editPageInput(value)}
        onPageInputKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            jumpToPage();
          }
        }}
        onPageInputBlur={() => {
          queryController.focusPageInput(false);
          jumpToPage();
        }}
        onDetailTabChange={(tab) => dispatch({ type: 'SET_DETAIL_TAB', tab })}
        onDetailInteraction={pauseFollowing}
        onOpenRecordText={() => {
          const current = stateRef.current;
          const ref = current.detail?.ref;
          if (ref !== undefined && !current.detailStale && current.invalidationReason === undefined && !current.pending.detail) {
            clientRef.current.send('OPEN_RECORD_TEXT', { ref });
          }
        }}
        onRequestFull={() => {
          const ref = stateRef.current.detail?.ref;
          if (ref !== undefined) {
            automaticFullDetailKeyRef.current = `full:${recordRefKey(ref)}`;
            requestDetail(ref, true, false);
          }
        }}
        onCloseDetail={closeDetail}
        onDetailDoubleClick={() => {
          queryController.pauseFollowing();
          const containerWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
          dispatch({ type: 'SET_DETAIL_WIDTH', width: clampDetailWidth(DEFAULT_DETAIL_WIDTH, containerWidth) });
        }}
      />
    </div>
  );
}
