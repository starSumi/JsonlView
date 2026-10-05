import React, { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Braces,
  CircleAlert,
  Columns3,
  RefreshCw,
  Table2,
  X,
} from 'lucide-react';
import type {
  ColumnSpec,
  InsightDimension,
  RecordRef,
  RowFilter,
  RowFilterOperator,
  RowSort,
  SortDirection,
} from '../shared/types';
import { MAX_TABLE_COLUMNS } from '../shared/types';
import { DetailDrawer } from './detail-drawer';
import {
  shouldAutomaticallyHydrateSelectedRecord,
} from './full-record-intent';
import { deferIdle } from './idle';
import { InsightsView } from './insights-view';
import { visibleColumns } from './format';
import {
  buildStructuredFilter,
  canRequestSortedPage,
  formatScanLimit,
  RecordPager,
  recordColumnOptions,
  RecordQueryBanner,
  RecordQueryControls,
  SCHEMA_PAGE_SIZE,
  selectedRecordColumns,
  textPredicate,
} from './features/record-query';
import type { ViewportIdentity } from './paging';
import { VsCodeMessageClient } from './protocol-client';
import { RowQueryController, type RowsRequestMetadata, type RowsRequestOptions } from './row-query-controller';
import { snapshotIdentityChanged } from './snapshot-identity';
import { profileOptionList } from './profile-options';
import { WorkspaceHeader } from './workspace-header';
import { useLightDismiss } from './use-light-dismiss';
import { useManualTabs } from './use-manual-tabs';
import { useNarrowViewport } from './use-modal-focus';
import { useViewportPopover } from './use-viewport-popover';
import {
  canReadSnapshot,
  createInitialState,
  nextInvalidationReason,
  selectProblems,
  selectTimelineRows,
  toPersistedState,
  workspaceReducer,
  type PersistedWorkspaceState,
  type RequestKind,
  type WorkspaceTab,
  type WorkspaceState,
} from './state';
import {
  fallbackColumns,
  ProblemsView,
  SchemaView,
  TimelineView,
} from './views';
import { RecordTable } from './features/record-query';
import {
  clampDetailWidth,
  DEFAULT_DETAIL_WIDTH,
  detailWidthValueText,
  MIN_DETAIL_WIDTH,
  MIN_PRIMARY_WIDTH,
  resizedDetailWidth,
  SPLITTER_WIDTH,
} from './split-pane';

const configuredPageSize = Number(document.body.dataset.pageSize ?? '100');
const PAGE_SIZE = Number.isSafeInteger(configuredPageSize)
  ? Math.min(500, Math.max(20, configuredPageSize))
  : 100;
const vscode = acquireVsCodeApi<PersistedWorkspaceState>();

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
  const stateRef = useRef(state);
  const persistedStateRef = useRef<PersistedWorkspaceState>(toPersistedState(state));
  const clientRef = useRef(new VsCodeMessageClient(vscode, bodySession()));
  const startedRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const columnsMenuRef = useRef<HTMLDetailsElement>(null);
  useLightDismiss(columnsMenuRef);
  useViewportPopover(columnsMenuRef);
  const narrowViewport = useNarrowViewport();
  const drawerId = 'record-detail';
  const workspaceTabs = useManualTabs({
    ids: tabs.map((tab) => tab.id),
    activeId: state.activeTab,
    onActivate: (tab) => dispatch({ type: 'SET_ACTIVE_TAB', tab }),
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
  const schemaRequestKeyRef = useRef('');
  const schemaRequestIdRef = useRef('');
  const [schemaLoadFailed, setSchemaLoadFailed] = React.useState(false);

  useEffect(() => {
    stateRef.current = state;
    persistedStateRef.current = toPersistedState(state);
    // State persistence is non-critical for first paint. Coalesce bursts of
    // indexing/progress updates and flush the latest snapshot during idle time.
    return deferIdle(() => {
      vscode.setState(persistedStateRef.current);
    });
  }, [state]);

  useEffect(() => {
    const flushPersistedState = (): void => {
      vscode.setState(persistedStateRef.current);
    };
    window.addEventListener('pagehide', flushPersistedState);
    return () => window.removeEventListener('pagehide', flushPersistedState);
  }, []);

  const finishCancelled = useCallback((kind: RequestKind, ids: string[]): void => {
    for (const requestId of ids) dispatch({ type: 'REQUEST_FINISHED', kind, requestId });
  }, []);

  const cancelReadRequests = useCallback((): void => {
    for (const kind of ['rows', 'problems', 'detail', 'schema', 'insights'] as const) {
      finishCancelled(kind, clientRef.current.cancel(kind));
    }
  }, [finishCancelled]);

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
      fallbackColumns,
    }, state, PAGE_SIZE);
  }
  const queryController = queryControllerRef.current;
  const requestRows = useCallback((options?: RowsRequestOptions, metadata: RowsRequestMetadata = {}): void => {
    queryController.requestRows(options, metadata);
  }, [queryController]);

  useEffect(() => {
    const clampToViewport = (): void => {
      const width = workspaceRef.current?.clientWidth;
      if (width === undefined || width <= 900) return;
      const next = clampDetailWidth(stateRef.current.detailWidth, width);
      if (next !== stateRef.current.detailWidth) dispatch({ type: 'SET_DETAIL_WIDTH', width: next });
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
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
    query?: string;
  }): void => {
    if (!canReadSnapshot(invalidationRef.current)) return;
    const client = clientRef.current;
    finishCancelled('insights', client.cancel('insights'));
    const dimension = options?.dimension ?? stateRef.current.insightDimension;
    const predicate = textPredicate(options?.query ?? queryController.query);
    const request = client.send('GET_INSIGHTS', {
      dimension,
      ...(predicate ? { predicate } : {}),
    });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestDetail = useCallback((ref: RecordRef, full = false): void => {
    const client = clientRef.current;
    finishCancelled('detail', client.cancel('detail'));
    dispatch({ type: 'SELECT_ROW', ordinal: ref.ordinal });
    if (!canReadSnapshot(invalidationRef.current)) return;
    const request = client.send('GET_DETAIL', { ref, ...(full ? { full: true } : {}) });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const setColumnWidth = useCallback((columnId: string, width: number | undefined): void => {
    dispatch({ type: 'SET_COLUMN_WIDTH', columnId, width });
  }, []);

  const setColumnOrder = useCallback((order: string[]): void => {
    dispatch({ type: 'SET_COLUMN_ORDER', order });
  }, []);

  const setSort = useCallback((sort: RowSort | undefined): void => {
    queryController.changeSort(sort);
  }, [queryController]);

  const setSortDirection = useCallback((direction: SortDirection): void => {
    queryController.requestRowOrder(direction);
  }, [queryController]);

  const applyFilter = useCallback((filter: RowFilter | undefined): void => {
    queryController.applyFilter(filter);
  }, [queryController]);

  const rebuild = useCallback((): void => {
    queryController.rebuild();
  }, [queryController]);

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

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const message = clientRef.current.accept(event.data);
      if (!message) return;
      const currentFollowMode = followModeRef.current;
      const firstOpenedSession = message.type === 'OPENED' && acceptedSessionRef.current === undefined;
      const openedGenerationChanged = message.type === 'OPENED'
        && snapshotIdentityChanged(acceptedSessionRef.current, message.payload.snapshot);
      if (message.type === 'SOURCE_INVALIDATED') {
        invalidationRef.current = nextInvalidationReason(invalidationRef.current, message.payload.reason);
      } else if (openedGenerationChanged) invalidationRef.current = undefined;
      if (message.type === 'OPENED') {
        if (openedGenerationChanged) setSchemaLoadFailed(false);
        indexingCompleteRef.current = message.payload.indexingComplete;
        acceptedSessionRef.current = {
          documentId: message.payload.snapshot.documentId,
          generation: message.payload.snapshot.generation,
          ...(message.payload.snapshot.epoch === undefined ? {} : { epoch: message.payload.snapshot.epoch }),
        };
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
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [cancelReadRequests, finishCancelled, queryController]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const payload = restored === undefined ? {} : { restoredState: restored };
    const request = clientRef.current.send('READY', payload);
    dispatch({ type: 'REQUEST_SENT', request });
  }, [restored]);

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
    if (!state.page || state.pending.rows || !state.summary
      || !canReadSnapshot(state.invalidationReason)
      || state.summary.snapshot.generation !== clientRef.current.session.generation) return;
    const selected = selectedRecordColumns(state.columns, state.schema, state.columnVisibility);
    if (!selected?.some((column) => state.columnVisibility[column.id] === true
      && !state.columns.some((current) => current.id === column.id))) return;
    const viewport = queryController.currentViewportOptions();
    requestRows({ ...viewport, columns: selected }, { preserveOnRebuild: true });
  }, [requestRows, state.columnVisibility, state.columns, state.invalidationReason,
    state.page, state.pending.rows, state.schema, state.summary]);

  useEffect(() => {
    if (
      canReadSnapshot(state.invalidationReason)
      && state.activeTab === 'insights'
      && state.summary
      && !state.insights
      && !state.pending.insights
    ) {
      requestInsights();
    }
    if (state.activeTab !== 'insights' && state.pending.insights) {
      finishCancelled('insights', clientRef.current.cancel('insights'));
    }
  }, [finishCancelled, requestInsights, state.activeTab, state.invalidationReason, state.insights, state.pending.insights, state.summary]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && (
        stateRef.current.detail || stateRef.current.pending.detail || stateRef.current.blockedDetailOrdinal
      )) {
        finishCancelled('detail', clientRef.current.cancel('detail'));
        dispatch({ type: 'CLOSE_DETAIL' });
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [finishCancelled]);

  const summary = state.summary;
  const profileOptions = profileOptionList(
    summary?.profileId,
    summary?.profileSuggestions ?? [],
  );
  const baseColumns = useMemo(
    () => state.columns.length > 0 ? state.columns : fallbackColumns(state.rows),
    [state.columns, state.rows],
  );
  const selectedRecordIds = new Set(
    selectedRecordColumns(baseColumns, state.schema, state.columnVisibility)?.map((column) => column.id) ?? [],
  );
  const availableColumns = useMemo(
    () => recordColumnOptions(baseColumns, state.schema),
    [baseColumns, state.schema],
  );
  const recordColumnLimit = Math.max(
    0,
    MAX_TABLE_COLUMNS - baseColumns.filter((column) => column.source === 'profile').length,
  );
  const filterableColumns = availableColumns;
  const tableColumns = visibleColumns(baseColumns, state.columnVisibility, state.columnOrder);
  const timelineRows = selectTimelineRows(state);
  const problems = selectProblems(state);
  const problemEntries = state.problems === undefined
    ? problems
    : state.problems.items.map((problem) => ({
      ...problem,
      ...(problem.ref?.ordinal === undefined ? {} : { ordinal: problem.ref.ordinal }),
    }));
  const drawerOpen = Boolean(state.detail || state.pending.detail || state.blockedDetailOrdinal);

  useEffect(() => {
    const detail = state.detail;
    if (detail === undefined || state.selectedOrdinal !== detail.ref.ordinal) {
      automaticFullDetailKeyRef.current = undefined;
      return;
    }
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

    const key = `${detail.ref.generation}:${detail.ref.ordinal}`;
    if (automaticFullDetailKeyRef.current === key) return;
    automaticFullDetailKeyRef.current = key;
    requestDetail(detail.ref, true);
  }, [drawerOpen, requestDetail, state.detail, state.invalidationReason, state.pending.detail, state.selectedOrdinal]);

  const workspaceWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
  const displayedDetailWidth = workspaceWidth > 900
    ? clampDetailWidth(state.detailWidth, workspaceWidth)
    : state.detailWidth;
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
    applyFilter(filter);
  };

  const setProfile = (profileId: string): void => {
    if (invalidationRef.current !== undefined) return;
    queryController.abandonRestore();
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
    if (enabled) queryController.requestFollowRows();
  };

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

  const pageRange = state.rows.length > 0
    ? `Rows #${state.rows[0]?.ref.ordinal}-#${state.rows.at(-1)?.ref.ordinal}`
    : `${state.rows.length} rows`;
  const partialScan = state.page?.scan?.truncatedReason !== undefined;
  const hasPartialContinuation = partialScan
    && (state.sort !== undefined || state.page?.scan?.cursorOrdinal !== undefined);
  const showPageControls = (state.activeTab === 'table' || state.activeTab === 'timeline')
    && (
      state.rows.length > 0
      || state.page?.hasBefore === true
      || state.page?.hasAfter === true
      || hasPartialContinuation
    );
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

  const resizeDetailFromPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const containerWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
    const initialPointerX = event.clientX;
    const initialWidth = displayedDetailWidth;
    const splitter = event.currentTarget;
    try {
      splitter.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still handle the drag if pointer capture is unavailable.
    }
    document.body.classList.add('is-resizing-detail');

    const onPointerMove = (moveEvent: PointerEvent): void => {
      dispatch({
        type: 'SET_DETAIL_WIDTH',
        width: resizedDetailWidth(initialWidth, initialPointerX, moveEvent.clientX, containerWidth),
      });
    };
    const finish = (): void => {
      document.body.classList.remove('is-resizing-detail');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const resizeDetailFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const containerWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
    const step = event.shiftKey ? 64 : 16;
    let desired: number | undefined;
    if (event.key === 'ArrowLeft') desired = state.detailWidth + step;
    if (event.key === 'ArrowRight') desired = state.detailWidth - step;
    if (event.key === 'Home') desired = 0;
    if (event.key === 'End') desired = containerWidth;
    if (desired === undefined) return;
    event.preventDefault();
    dispatch({ type: 'SET_DETAIL_WIDTH', width: clampDetailWidth(desired, containerWidth) });
  };

  const workspaceStyle = drawerOpen
    ? ({ '--detail-pane-width': `${displayedDetailWidth}px` } as CSSProperties)
    : undefined;

  return (
    <div className="app-shell">
      <WorkspaceHeader
        indexedBytes={summary?.indexedBytes ?? '0'}
        sizeBytes={summary?.snapshot.sizeBytes ?? '0'}
        indexedRecords={summary?.indexedRecords ?? '0'}
        validRecords={summary?.validRecords ?? '0'}
        problemRecords={summary?.problemRecords ?? '0'}
        complete={summary?.indexingComplete ?? false}
        phase={state.invalidationReason === 'append' ? 'snapshot' : state.phase}
        appendPending={state.invalidationReason === 'append'}
        rebuildBusy={Boolean(state.pending.rebuild)}
        onRebuild={rebuild}
      >
        <div className="toolbar-context" title="File identity is provided by the VS Code editor tab" aria-label="JSONL workspace">
          <span className="toolbar-context-mark" aria-hidden>JSONL</span>
        </div>
        <label className="compact-field profile-field">
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
        <RecordQueryControls
          query={state.query}
          searchDisabled={!summary || !canReadSnapshot(state.invalidationReason)}
          sortDirection={state.sort?.columnId === '__ordinal' && state.sort.direction === 'desc' ? 'desc' : 'asc'}
           descendingDisabled={summary?.indexingComplete !== true
             || state.invalidationReason !== undefined
             || Boolean(state.pending.rebuild)
             || Boolean(state.pending.order)}
           descendingDisabledReason={state.invalidationReason !== undefined
             ? 'Rebuild the changed source before reversing row order'
             : state.pending.rebuild
               ? 'Rebuilding the index'
               : state.pending.order
                 ? 'Saving the row order preference'
                 : 'Indexing the file before reverse order is available'}
          onSortDirectionChange={setSortDirection}
          onSearchSubmit={() => {
            const query = queryController.query;
            if (state.activeTab === 'insights') requestInsights({ query });
            else requestRows({ query });
          }}
          onSearchChange={(query) => queryController.editQuery(query)}
          onSearchClear={() => {
            // Clear is an explicit cross-control action. Release a stale
            // Page focus gate even when the host did not deliver onBlur.
            queryController.releasePageInputFocus();
            queryController.editQuery('');
            if (state.activeTab === 'insights') requestInsights({ query: '' });
            else requestRows({ query: '' });
          }}
          filterActive={Boolean(state.filter)}
          filterableColumns={filterableColumns}
          filterColumnId={filterColumnId}
          filterOperator={filterOperator}
          filterOperators={availableFilterOperators}
          filterValue={filterValue}
          filterCaseSensitive={filterCaseSensitive}
          onFilterColumnChange={setFilterColumnId}
          onFilterOperatorChange={setFilterOperator}
          onFilterValueChange={setFilterValue}
          onFilterCaseSensitiveChange={setFilterCaseSensitive}
          onFilterSubmit={submitStructuredFilter}
          onFilterClear={() => applyFilter(undefined)}
        />
        {state.invalidationReason === undefined ? (
          <button
            type="button"
            className="icon-button rebuild-action"
            title="Rebuild index"
            aria-label="Rebuild index"
            disabled={!summary || Boolean(state.pending.rebuild)}
            onClick={rebuild}
          >
            <RefreshCw size={15} className={state.pending.rebuild ? 'spin' : ''} aria-hidden />
          </button>
        ) : null}
        <details ref={columnsMenuRef} className="columns-menu">
          <summary className="icon-button" title="Choose columns" aria-label="Choose columns">
            <Columns3 size={15} aria-hidden />
          </summary>
          <div className="columns-popover">
            {schemaLoadFailed ? (
              <button type="button" onClick={requestSchema}>Retry fields</button>
            ) : null}
            {([{ id: '__ordinal', label: '#', source: 'system' }, ...availableColumns] as ColumnSpec[]).map((column) => {
              const record = column.source === 'record';
              const checked = column.id === '__ordinal'
                || (record
                  ? selectedRecordIds.has(column.id)
                  : state.columnVisibility[column.id] !== false);
              const limitReached = record && !checked && selectedRecordIds.size >= recordColumnLimit;
              return <label key={column.id} title={limitReached ? `Up to ${recordColumnLimit} record fields can be shown at once` : undefined}>
                <input
                  type="checkbox"
                  disabled={column.id === '__ordinal' || limitReached}
                  checked={checked}
                  onChange={(event) => {
                    const visible = event.target.checked;
                    dispatch({ type: 'SET_COLUMN_VISIBILITY', columnId: column.id, visible });
                    if (!record) return;
                    const nextVisibility = { ...state.columnVisibility, [column.id]: visible };
                    const columns = selectedRecordColumns(baseColumns, state.schema, nextVisibility) ?? [];
                    const viewport = queryController.currentViewportOptions();
                    requestRows({ ...viewport, columns }, { preserveOnRebuild: true });
                  }}
                />
                <span title={column.label}>{column.label}</span>
              </label>;
            })}
          </div>
        </details>
      </WorkspaceHeader>

      {state.invalidationReason !== undefined && state.invalidationReason !== 'append' ? (
        <div className="workspace-banner invalidated-banner" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>Source changed ({state.invalidationReason ?? 'unknown'}). This view is a stale snapshot.</span>
          <button type="button" disabled={Boolean(state.pending.rebuild)} onClick={rebuild}><RefreshCw size={14} aria-hidden />Rebuild</button>
        </div>
      ) : null}
      {state.error ? (
        <div className={`workspace-banner error-banner${state.error.recoverable ? ' is-recoverable' : ''}`} role="alert">
          <CircleAlert size={15} aria-hidden />
          <span><strong>{state.error.code}</strong> {state.error.message}</span>
          {state.error.recoverable ? (
            <button type="button" aria-label="Dismiss error" title="Dismiss error" onClick={() => dispatch({ type: 'DISMISS_ERROR' })}>
              <X size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      <RecordQueryBanner scan={state.page?.scan} sort={state.sort} />

      <nav {...workspaceTabs.tabListProps} className="workspace-tabs" aria-label="Workspace views">
        {tabs.map(({ id, label, icon: Icon }) => {
          const count = id === 'timeline' ? timelineRows.length : id === 'problems' ? problemEntries.length : undefined;
          return (
            <button
              type="button"
              className={state.activeTab === id ? 'is-active' : ''}
              {...workspaceTabs.getTabProps(id)}
              key={id}
            >
              <Icon size={14} aria-hidden />
              {label}
              {count !== undefined ? (
                <span
                  className="tab-count"
                  title={id === 'problems' ? 'Problem entries in the current scan page; the status strip counts distinct problem records observed so far' : undefined}
                >
                  {count}
                  {id === 'problems' ? <span className="tab-count-unit">entries</span> : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div
        ref={workspaceRef}
        className={`workspace${drawerOpen ? ' has-drawer' : ''}`}
        style={workspaceStyle}
      >
        <section className="workspace-primary" aria-label={`${state.activeTab} view`}>
          <div {...workspaceTabs.getPanelProps('table')} className="workspace-tab-panel">
          {state.activeTab === 'table' ? (
            <RecordTable
              sessionId={clientRef.current.session.documentId}
              rows={state.rows}
              columns={tableColumns}
              selectedOrdinal={state.selectedOrdinal}
              loading={Boolean(state.pending.rows) || state.phase === 'booting'}
              onSelect={requestDetail}
              columnWidths={state.columnWidths}
              onColumnWidthChange={setColumnWidth}
              sort={state.sort ?? { columnId: '__ordinal', direction: 'asc' }}
              onColumnOrderChange={setColumnOrder}
            />
          ) : null}
          </div>
          <div {...workspaceTabs.getPanelProps('timeline')} className="workspace-tab-panel">
          {state.activeTab === 'timeline' ? (
            <TimelineView rows={timelineRows} selectedOrdinal={state.selectedOrdinal} onSelect={requestDetail} />
          ) : null}
          </div>
          <div {...workspaceTabs.getPanelProps('schema')} className="workspace-tab-panel">
          {state.activeTab === 'schema' ? (
            <SchemaView fields={state.schema} total={state.schemaTotal} loading={Boolean(state.pending.schema)} />
          ) : null}
          </div>
          <div {...workspaceTabs.getPanelProps('problems')} className="workspace-tab-panel">
          {state.activeTab === 'problems' ? (
            <ProblemsView
              problems={problemEntries}
              onSelectOrdinal={selectProblem}
              complete={state.problems?.complete ?? false}
              hasAfter={state.problems?.hasAfter ?? false}
              onContinue={continueProblems}
              loading={Boolean(state.pending.problems)}
            />
          ) : null}
          </div>
          <div {...workspaceTabs.getPanelProps('insights')} className="workspace-tab-panel">
          {state.activeTab === 'insights' ? (
            <div className="insights-shell">
              <div className="insights-toolbar">
                <label className="compact-field">
                  <span>Group by</span>
                  <select
                    value={state.insightDimension}
                    disabled={!canReadSnapshot(state.invalidationReason) || Boolean(state.pending.insights)}
                    onChange={(event) => {
                      const dimension = event.target.value as InsightDimension;
                      dispatch({ type: 'SET_INSIGHT_DIMENSION', dimension });
                      requestInsights({ dimension });
                    }}
                  >
                    <option value="eventKind">Event</option>
                    <option value="severity">Severity</option>
                    <option value="service">Service</option>
                    <option value="status">Status</option>
                  </select>
                </label>
                <span className="insights-meta">
                  {state.insights
                    ? `${state.insights.examinedRecords} examined · ${state.insights.processedRecords} matched`
                    : ''}
                  {state.insights?.truncatedReason
                    ? ` · ${formatInsightLimit(state.insights.truncatedReason)}`
                    : (state.insights?.truncated ? ' · limited' : '')}
                  {state.insights?.capacityReached ? ' · grouped overflow' : ''}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  title="Refresh aggregates"
                  aria-label="Refresh aggregates"
                  disabled={!canReadSnapshot(state.invalidationReason) || Boolean(state.pending.insights)}
                  onClick={() => requestInsights()}
                >
                  <RefreshCw size={14} className={state.pending.insights ? 'spin' : ''} aria-hidden />
                </button>
              </div>
              <InsightsView
                categories={state.insights?.categories ?? []}
                timeBuckets={state.insights?.timeBuckets ?? []}
                loading={Boolean(state.pending.insights)}
                error={state.error?.code === 'REQUEST_FAILED' ? state.error.message : undefined}
              />
            </div>
          ) : null}
          </div>
          <RecordPager
            visible={showPageControls}
            busy={Boolean(state.pending.rows)}
            invalidated={!canReadSnapshot(state.invalidationReason)}
            hasBefore={state.page?.hasBefore === true}
            canAdvance={canAdvancePage}
            pageInput={pageInput}
            pageRange={pageRange}
            onPrevious={previousPage}
            onNext={nextPage}
            onJump={jumpToPage}
            onInputFocus={() => queryController.focusPageInput(true)}
            onInputChange={(value) => queryController.editPageInput(value)}
            onInputKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                jumpToPage();
              }
            }}
            onInputBlur={() => {
              queryController.focusPageInput(false);
              jumpToPage();
            }}
          />
        </section>
        {drawerOpen ? (
          <>
            {!narrowViewport ? <div
              className="detail-splitter"
              role="separator"
              aria-label="Resize record detail"
              aria-orientation="vertical"
              aria-controls={drawerId}
              aria-valuemin={MIN_DETAIL_WIDTH}
              aria-valuemax={Math.max(
                MIN_DETAIL_WIDTH,
                workspaceWidth - MIN_PRIMARY_WIDTH - SPLITTER_WIDTH,
              )}
              aria-valuenow={displayedDetailWidth}
              aria-valuetext={detailWidthValueText(displayedDetailWidth)}
              tabIndex={0}
              title="Drag to resize detail"
              onPointerDown={resizeDetailFromPointer}
              onKeyDown={resizeDetailFromKeyboard}
              onDoubleClick={() => {
                const containerWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
                dispatch({ type: 'SET_DETAIL_WIDTH', width: clampDetailWidth(DEFAULT_DETAIL_WIDTH, containerWidth) });
              }}
            /> : null}
            <DetailDrawer
              id={drawerId}
              modal={narrowViewport}
              detail={state.detail}
              loading={Boolean(state.pending.detail)}
              readBlocked={!canReadSnapshot(state.invalidationReason)}
              blockedOrdinal={state.blockedDetailOrdinal}
              activeTab={state.detailTab}
              onTabChange={(tab) => dispatch({ type: 'SET_DETAIL_TAB', tab })}
              onRequestFull={() => {
                const ref = stateRef.current.detail?.ref;
                if (ref !== undefined) {
                  automaticFullDetailKeyRef.current = `${ref.generation}:${ref.ordinal}`;
                  requestDetail(ref, true);
                }
              }}
              onClose={() => {
                finishCancelled('detail', clientRef.current.cancel('detail'));
                dispatch({ type: 'CLOSE_DETAIL' });
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function formatInsightLimit(reason: import('../shared/types').ScanTruncationReason): string {
  return formatScanLimit(reason);
}
