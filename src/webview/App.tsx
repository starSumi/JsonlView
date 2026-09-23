import React, { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Braces,
  Check,
  CircleAlert,
  Columns3,
  FileJson2,
  LoaderCircle,
  RefreshCw,
  Table2,
  ArrowDownUp,
  X,
} from 'lucide-react';
import type {
  ColumnSpec,
  InsightDimension,
  JsonKind,
  RecordRef,
  RowFilter,
  RowFilterOperator,
  RowSort,
} from '../shared/types';
import { DetailDrawer } from './detail-drawer';
import { deferIdle } from './idle';
import { InsightsView } from './insights-view';
import { formatBytes, visibleColumns } from './format';
import {
  buildRecordQueryRequest,
  canRequestSortedPage,
  formatScanLimit,
  RecordPager,
  RecordQueryBanner,
  RecordQueryControls,
  textPredicate,
} from './features/record-query';
import {
  advanceSortPage,
  anchorForPage,
  normalizeSortOffset,
  normalizeSortOffsetHistory,
  normalizeSortPage,
  pageFromOrdinal,
  pageFromSortOffset,
  previousSortPage,
  rowsOptionsAfterOpened,
  rowsOptionsAfterEmptyRebuild,
  rowsOptionsAfterRebuild,
  rowsOptionsAfterOpenedRequest,
  rowsOptionsForViewport,
  type ViewportIdentity,
} from './paging';
import { VsCodeMessageClient } from './protocol-client';
import { parseFilterLiteral, predicateForFilter } from './query';
import {
  createInitialState,
  reconcileProfileQueryState,
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
  MIN_DETAIL_WIDTH,
  MIN_PRIMARY_WIDTH,
  resizedDetailWidth,
  SPLITTER_WIDTH,
} from './split-pane';

const configuredPageSize = Number(document.body.dataset.pageSize ?? '100');
const PAGE_SIZE = Number.isSafeInteger(configuredPageSize)
  ? Math.min(500, Math.max(20, configuredPageSize))
  : 100;
// Keep logical sorted paging inside the engine's bounded retained window.
// This is a protocol guard as well as a UX guard: the engine rejects a page
// whose `sortOffset + limit` exceeds this value.
const SCHEMA_PAGE_SIZE = 250;

interface ViewportCursor {
  documentId: string;
  generation: string;
  query: string;
  firstVisibleOrdinal?: string;
}

interface RowsRequestOptions {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  query?: string;
  sort?: RowSort;
  sortOffset?: string;
  filterColumns?: readonly ColumnSpec[];
}

interface RowsRequestMetadata {
  preserveOnRebuild?: boolean;
  restoreAfterRebuild?: boolean;
  restorePhase?: RestoreViewportPhase;
  supersedesRestore?: boolean;
  allowWhileInvalidated?: boolean;
  pageInputSubmission?: boolean;
}

type RestoreViewportPhase = 'initial' | 'waiting-index' | 'retrying';

interface PendingViewportIntent {
  requestId: string;
  documentId: string;
  generation: string;
  query: string;
  options: RowsRequestOptions;
  preserveOnRebuild: boolean;
  restoreAfterRebuild: boolean;
}

interface RebuildViewportIntent {
  requestId: string;
  documentId: string;
  generation: string;
  query: string;
  viewportQuery: string;
  firstVisibleOrdinal?: string;
  pageText: string;
  options: RowsRequestOptions;
}

interface RestoreViewportIntent {
  documentId: string;
  generation: string;
  query: string;
  requestId: string;
  firstVisibleOrdinal?: string;
  pageText: string;
  phase: RestoreViewportPhase;
}

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

function fileLabel(uri: string | undefined): string {
  if (!uri) return 'JSONL document';
  try {
    const parsed = new URL(uri);
    const path = decodeURIComponent(parsed.pathname);
    return path.split('/').filter(Boolean).at(-1) ?? uri;
  } catch {
    return uri.split(/[\\/]/).at(-1) ?? uri;
  }
}

function profileOptions(
  current: string | undefined,
  suggestions: Array<{ id: string; displayName: string }>,
): Array<{ id: string; displayName: string }> {
  const options = new Map<string, string>();
  options.set('generic', 'Generic JSONL');
  if (current) options.set(current, current === 'generic' ? 'Generic JSONL' : current);
  for (const suggestion of suggestions) options.set(suggestion.id, suggestion.displayName);
  return [...options].map(([id, displayName]) => ({ id, displayName }));
}

interface StatusStripProps {
  filename: string;
  indexedBytes: string;
  sizeBytes: string;
  indexedRecords: string;
  validRecords: string;
  problemRecords: string;
  complete: boolean;
  phase: string;
}

function StatusStrip(props: StatusStripProps): React.JSX.Element {
  const indexed = Number(props.indexedBytes);
  const size = Number(props.sizeBytes);
  const progress = size > 0 && Number.isFinite(indexed) ? Math.min(100, (indexed / size) * 100) : 0;
  return (
    <div className="status-strip" role="status" aria-live="polite">
      <span className="status-file" title={props.filename}><FileJson2 size={14} aria-hidden />{props.filename}</span>
      <span>{props.indexedRecords} rows</span>
      <span>{formatBytes(props.indexedBytes)} / {formatBytes(props.sizeBytes)}</span>
      <span className="status-valid"><Check size={13} aria-hidden />{props.validRecords}</span>
      <span
        className={props.problemRecords === '0' ? '' : 'status-problem'}
        title="Problem records observed during hydration for this document generation; this is not a complete-file total"
        aria-label={`${props.problemRecords} problem records observed during hydration; not a complete-file total`}
      >
        <CircleAlert size={13} aria-hidden />
        <span>{props.problemRecords}</span>
        <span className="status-scope">observed</span>
      </span>
      <span className="status-spacer" />
      <span className="status-phase">
        {!props.complete ? <LoaderCircle size={13} className="spin" aria-hidden /> : null}
        {props.phase}
      </span>
      <span className="progress-track" aria-label={`${progress.toFixed(0)}% indexed`}>
        <span style={{ width: `${progress}%` }} />
      </span>
    </div>
  );
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
  const restored = useMemo(() => vscode.getState(), []);
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
  const pageInputRef = useRef('1');
  const pageInputDirtyRef = useRef(false);
  const pageInputFocusedRef = useRef(false);
  const pageInputRequestRef = useRef<string | undefined>(undefined);
  const queryRef = useRef(restored?.query ?? '');
  const filterRef = useRef<RowFilter | undefined>(restored?.filter);
  const sortRef = useRef<RowSort | undefined>(restored?.sort);
  const sortOffsetRef = useRef(restored?.sort === undefined ? '0' : normalizeSortOffset(restored.sortOffset));
  const sortOffsetHistoryRef = useRef(
    restored?.sort === undefined
      ? []
      : normalizeSortOffsetHistory(restored.sortOffsetHistory, sortOffsetRef.current),
  );
  const sortPageRef = useRef(
    restored?.sort === undefined
      ? '1'
      : normalizeSortPage(restored.sortPage, sortOffsetRef.current, PAGE_SIZE),
  );
  const columnsRef = useRef<readonly ColumnSpec[]>([]);
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
  const viewportCursorRef = useRef<ViewportCursor | undefined>(undefined);
  const pendingViewportRef = useRef<PendingViewportIntent | undefined>(undefined);
  const rebuildViewportRef = useRef<RebuildViewportIntent | undefined>(undefined);
  const restoreViewportRef = useRef<RestoreViewportIntent | undefined>(undefined);

  const setPageInput = useCallback((value: string): void => {
    pageInputRef.current = value;
    setPageInputState(value);
  }, []);

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

  useEffect(() => {
    // Keep the user's page input visible while a generation-changing rebuild
    // temporarily clears rows. The next successful page response reconciles it
    // to the restored first ordinal.
    if (state.rows.length > 0 && !pageInputDirtyRef.current && !pageInputFocusedRef.current) {
      if (sortRef.current !== undefined) {
        setPageInput(sortPageRef.current);
      } else {
        setPageInput(pageFromOrdinal(state.rows[0]?.ref.ordinal, PAGE_SIZE));
      }
    }
  }, [state.rows]);

  const finishCancelled = useCallback((kind: RequestKind, ids: string[]): void => {
    for (const requestId of ids) dispatch({ type: 'REQUEST_FINISHED', kind, requestId });
  }, []);

  const requestRows = useCallback((
    options?: RowsRequestOptions,
    metadata: RowsRequestMetadata = {},
  ): void => {
    const client = clientRef.current;
    if (
      invalidationRef.current !== undefined
      && metadata.allowWhileInvalidated !== true
    ) return;
    if (metadata.restoreAfterRebuild !== true && metadata.supersedesRestore !== false) {
      // A new user/refresh request supersedes any pending empty-page recovery;
      // late INDEX_PROGRESS must never resurrect its old cursor.
      restoreViewportRef.current = undefined;
    }
    // A submitted page request may be superseded by a newer rows request
    // (search, profile, follow, or another page jump). Its response can no
    // longer reconcile the input, so release the submission barrier now.
    if (pageInputRequestRef.current !== undefined) {
      pageInputRequestRef.current = undefined;
      pageInputDirtyRef.current = false;
    }
    finishCancelled('rows', client.cancel('rows'));
    const query = options?.query ?? queryRef.current;
    const preserveOnRebuild = metadata.preserveOnRebuild ?? options !== undefined;
    const restoreAfterRebuild = metadata.restoreAfterRebuild === true;
    const sort = options?.sort ?? sortRef.current;
    const sortOffset = sort === undefined
      ? undefined
      : options?.sortOffset ?? sortOffsetRef.current;
    const filterColumns = options?.filterColumns
      ?? (stateRef.current.columns.length > 0
        ? stateRef.current.columns
        : fallbackColumns(stateRef.current.rows));
    const payload = buildRecordQueryRequest({
      limit: PAGE_SIZE,
      query,
      filterColumns,
      ...(filterRef.current === undefined ? {} : { filter: filterRef.current }),
      ...(options?.anchorOrdinal === undefined ? {} : { anchorOrdinal: options.anchorOrdinal }),
      ...(options?.direction === undefined ? {} : { direction: options.direction }),
      ...(sort === undefined ? {} : { sort }),
      ...(sortOffset === undefined ? {} : { sortOffset }),
    });
    const request = client.send('GET_ROWS', payload);
    if (metadata.pageInputSubmission === true) pageInputRequestRef.current = request.id;
    if (metadata.restoreAfterRebuild === true && restoreViewportRef.current !== undefined) {
      restoreViewportRef.current.requestId = request.id;
      restoreViewportRef.current.phase = metadata.restorePhase ?? 'initial';
    }
    pendingViewportRef.current = {
      requestId: request.id,
      documentId: client.session.documentId,
      generation: client.session.generation,
      query,
      preserveOnRebuild,
      restoreAfterRebuild,
      options: {
        ...(options?.anchorOrdinal === undefined ? {} : { anchorOrdinal: options.anchorOrdinal }),
        ...(options?.direction === undefined ? {} : { direction: options.direction }),
        ...(sort === undefined ? {} : {
          sort,
          ...(sortOffset === undefined ? {} : { sortOffset }),
        }),
      },
    };
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

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
    if (invalidationRef.current !== undefined) return;
    const client = clientRef.current;
    finishCancelled('schema', client.cancel('schema'));
    const request = client.send('GET_SCHEMA', { offset: 0, limit: SCHEMA_PAGE_SIZE });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestProblems = useCallback((options?: {
    anchorOrdinal?: string;
    direction?: 'forward' | 'backward';
  }): void => {
    if (invalidationRef.current !== undefined) return;
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
    if (invalidationRef.current !== undefined) return;
    const client = clientRef.current;
    finishCancelled('insights', client.cancel('insights'));
    const dimension = options?.dimension ?? stateRef.current.insightDimension;
    const predicate = textPredicate(options?.query ?? queryRef.current);
    const request = client.send('GET_INSIGHTS', {
      dimension,
      ...(predicate ? { predicate } : {}),
    });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestDetail = useCallback((ref: RecordRef, full = false): void => {
    if (invalidationRef.current !== undefined) return;
    const client = clientRef.current;
    finishCancelled('detail', client.cancel('detail'));
    dispatch({ type: 'SELECT_ROW', ordinal: ref.ordinal });
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
    sortRef.current = sort;
    sortOffsetRef.current = '0';
    sortOffsetHistoryRef.current = [];
    sortPageRef.current = '1';
    dispatch({ type: 'SET_SORT', sort });
    requestRows({ sortOffset: '0' });
  }, [requestRows]);

  const applyFilter = useCallback((filter: RowFilter | undefined): void => {
    filterRef.current = filter;
    sortOffsetRef.current = '0';
    sortOffsetHistoryRef.current = [];
    sortPageRef.current = '1';
    dispatch({ type: 'SET_FILTER', filter });
    requestRows({ sortOffset: '0' });
  }, [requestRows]);


  const rebuild = useCallback((): void => {
    const client = clientRef.current;
    const current = stateRef.current;
    // A fresh rebuild supersedes any recovery attempt from the prior
    // generation, including one waiting for background indexing to finish.
    restoreViewportRef.current = undefined;
    const saved = viewportCursorRef.current;
    const pending = pendingViewportRef.current;
    const savedBelongsToSession = saved?.documentId === client.session.documentId
      && saved.generation === client.session.generation;
    const currentQuery = queryRef.current;
    const currentFollowMode = followModeRef.current;
    const viewportQuery = savedBelongsToSession ? saved?.query ?? currentQuery : currentQuery;
    const queryMatchesViewport = viewportQuery === currentQuery;
    const pendingMatchesSession = pending?.documentId === client.session.documentId
      && pending.generation === client.session.generation
      && pending.query === currentQuery
      && pending.preserveOnRebuild;
    const firstVisibleOrdinal = queryMatchesViewport && savedBelongsToSession
      ? saved.firstVisibleOrdinal
      : current.rows[0]?.ref.ordinal;
    const effectiveFirstVisibleOrdinal = queryMatchesViewport ? firstVisibleOrdinal : undefined;
    const effectivePageInput = queryMatchesViewport ? pageInputRef.current : '1';
    // Rebuild supersedes a submitted page request. Preserve an unsubmitted
    // draft (its request ref is already empty), but do not leave a cancelled
    // submission permanently marking the input dirty.
    if (pageInputRequestRef.current !== undefined) {
      pageInputRequestRef.current = undefined;
      pageInputDirtyRef.current = false;
    }
    for (const kind of ['rows', 'problems', 'detail', 'schema', 'insights'] as const) {
      const cancelled = client.cancel(kind);
      finishCancelled(kind, cancelled);
      if (kind === 'rows' && pending?.requestId !== undefined && cancelled.includes(pending.requestId)) {
        pendingViewportRef.current = undefined;
      }
    }
    // The response may have completed just before cancel() and still be
    // represented by the local intent. It belongs to the old generation in
    // either case, so never let it compete with the captured rebuild intent.
    if (pendingMatchesSession) pendingViewportRef.current = undefined;
    const request = client.send('REBUILD_INDEX', {});
    // Capture the intent at click time. A pending GET_ROWS may be cancelled
    // above, and React state can be cleared by OPENED before the new page is
    // requested, so the rebuild response cannot reconstruct this reliably.
    rebuildViewportRef.current = {
      requestId: request.id,
      documentId: client.session.documentId,
      generation: client.session.generation,
      query: currentQuery,
      viewportQuery,
      ...(effectiveFirstVisibleOrdinal === undefined
        ? {} : { firstVisibleOrdinal: effectiveFirstVisibleOrdinal }),
      pageText: effectivePageInput,
      options: rowsOptionsForViewport(
        effectiveFirstVisibleOrdinal,
        effectivePageInput,
        PAGE_SIZE,
        currentFollowMode,
        pendingMatchesSession ? pending?.options : undefined,
      ),
    };
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  useEffect(() => {
    if (
      state.invalidationReason === undefined
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

      const currentQuery = queryRef.current;
      const currentFollowMode = followModeRef.current;
      const openedGenerationChanged = message.type === 'OPENED'
        && (
          acceptedSessionRef.current === undefined
          || acceptedSessionRef.current.documentId !== message.payload.snapshot.documentId
          || acceptedSessionRef.current.generation !== message.payload.snapshot.generation
          || (
            acceptedSessionRef.current.epoch !== undefined
            && message.payload.snapshot.epoch !== undefined
            && acceptedSessionRef.current.epoch !== message.payload.snapshot.epoch
          )
        );
      if (message.type === 'SOURCE_INVALIDATED') {
        // Set the barrier before any cancellation dispatch. React state is
        // asynchronous, while message handlers can be re-entered by a
        // synchronous control event in the same turn.
        invalidationRef.current = message.payload.reason;
      } else if (message.type === 'OPENED' && openedGenerationChanged) {
        // Only a genuinely new snapshot can clear the stale-source barrier.
        // Same-generation OPENED broadcasts must remain blocked.
        invalidationRef.current = undefined;
      }
      if (message.type === 'OPENED') {
        acceptedSessionRef.current = {
          documentId: message.payload.snapshot.documentId,
          generation: message.payload.snapshot.generation,
          ...(message.payload.snapshot.epoch === undefined ? {} : { epoch: message.payload.snapshot.epoch }),
        };
      }
      const profileQuery = message.type === 'PROFILE_CHANGED'
        && invalidationRef.current === undefined
        ? reconcileProfileQueryState(
          sortRef.current,
          filterRef.current,
          columnsRef.current,
          message.payload.columns,
        )
        : undefined;
      if (profileQuery !== undefined && message.type === 'PROFILE_CHANGED') {
        // React state commits after this handler. Update request-owned refs now
        // so the profile refresh cannot reuse a removed profile field.
        sortRef.current = profileQuery.sort;
        filterRef.current = profileQuery.filter;
        sortOffsetRef.current = '0';
        sortOffsetHistoryRef.current = [];
        sortPageRef.current = '1';
        columnsRef.current = message.payload.columns;
      }

      if (message.type === 'SOURCE_INVALIDATED') {
        // Stop all work against the stale generation, but leave the saved
        // viewport cursor intact so the next explicit rebuild can restore it.
        pageInputFocusedRef.current = false;
        if (pageInputRequestRef.current !== undefined) {
          pageInputRequestRef.current = undefined;
          pageInputDirtyRef.current = false;
        }
        restoreViewportRef.current = undefined;
        pendingViewportRef.current = undefined;
        // The in-flight rebuild belongs to the invalidated generation. Do not
        // let its captured page/query intent survive a second source change.
        rebuildViewportRef.current = undefined;
        for (const kind of ['rows', 'detail', 'schema', 'insights', 'profile', 'follow'] as const) {
          finishCancelled(kind, clientRef.current.cancel(kind));
        }
        dispatch({ type: 'MESSAGE_RECEIVED', message });
        return;
      }

      let restoredRowsIntent: RestoreViewportIntent | undefined;
      let restoredRowsOptions: RowsRequestOptions | undefined;

      if (
        message.type === 'ERROR'
        && pendingViewportRef.current?.requestId === message.requestId
        && pendingViewportRef.current.restoreAfterRebuild
      ) {
        restoreViewportRef.current = undefined;
        pendingViewportRef.current = undefined;
      }
      if (message.type === 'ERROR' && pageInputRequestRef.current === message.requestId) {
        // An error completes the submitted intent just like a successful
        // ROWS response. A newer unsubmitted draft has already cleared the
        // request ref and is therefore left untouched.
        pageInputRequestRef.current = undefined;
        pageInputDirtyRef.current = false;
      }

      // Record the viewport from the response itself rather than from React
      // state. This also covers the command-palette rebuild path, whose
      // broadcast OPENED message has an empty request id.
      if (message.type === 'ROWS') {
        columnsRef.current = message.payload.columns;
        if (message.payload.sortOffset !== undefined) {
          const responseOffset = normalizeSortOffset(message.payload.sortOffset);
          if (responseOffset !== sortOffsetRef.current) {
            sortOffsetHistoryRef.current = [];
            sortPageRef.current = pageFromSortOffset(responseOffset, PAGE_SIZE);
            dispatch({
              type: 'SET_SORT_OFFSET',
              offset: responseOffset,
              history: [],
              page: sortPageRef.current,
            });
          }
          sortOffsetRef.current = responseOffset;
        }
        const pendingViewport = pendingViewportRef.current;
        const restoreViewport = restoreViewportRef.current;
        if (
          pendingViewport?.requestId === message.requestId
          && pendingViewport.restoreAfterRebuild
          && restoreViewport?.documentId === message.documentId
          && restoreViewport.generation === message.generation
          && restoreViewport.requestId === message.requestId
        ) {
          restoredRowsIntent = restoreViewport;
          restoredRowsOptions = pendingViewport.options;
        }
        const previousViewport = viewportCursorRef.current;
        const responseQuery = pendingViewport?.requestId === message.requestId
          ? pendingViewport.query
          : currentQuery;
        // An empty continuation page is still a viewport result. Keep the
        // last non-empty first row for rebuild recovery when the query did not
        // change; otherwise a later source update would silently fall back to
        // page one. A genuinely new query must start with a fresh cursor.
        const sameViewport = previousViewport?.documentId === message.documentId
          && previousViewport.generation === message.generation
          && previousViewport.query === responseQuery;
        const firstVisibleOrdinal = message.payload.rows[0]?.ref.ordinal
          ?? (sameViewport ? previousViewport?.firstVisibleOrdinal : undefined);
        viewportCursorRef.current = {
          documentId: message.documentId,
          generation: message.generation,
          query: responseQuery,
          ...(firstVisibleOrdinal === undefined
            ? {}
            : { firstVisibleOrdinal }),
        };
        if (pendingViewport?.requestId === message.requestId) {
          if (pageInputRequestRef.current === message.requestId) {
            // A page draft is committed only by the response to the request
            // created from that draft. Background/profile rows must not erase
            // an unsubmitted value.
            pageInputDirtyRef.current = false;
            pageInputRequestRef.current = undefined;
          }
          pendingViewportRef.current = undefined;
        }
      }

      const savedViewport = viewportCursorRef.current;
      const pendingViewport = pendingViewportRef.current;
      const rebuildIntent = rebuildViewportRef.current;
      const pendingIdentity: ViewportIdentity | undefined = pendingViewport === undefined
        ? undefined
        : {
          documentId: pendingViewport.documentId,
          generation: pendingViewport.generation,
        };
      const rebuildIdentity: ViewportIdentity | undefined = rebuildIntent === undefined
        ? undefined
        : {
          documentId: rebuildIntent.documentId,
          generation: rebuildIntent.generation,
        };
      const priorViewport: ViewportIdentity | undefined = savedViewport ?? pendingIdentity ?? rebuildIdentity;
      const openedRows = message.type === 'OPENED'
        ? rowsOptionsAfterOpened(priorViewport, message.payload.snapshot, currentFollowMode)
        : undefined;
      const rebuildChangedGeneration = message.type === 'OPENED'
        && priorViewport !== undefined
        && priorViewport.documentId === message.documentId
        && priorViewport.generation !== message.payload.snapshot.generation;
      const pendingRebuildIntent = rebuildChangedGeneration
        && pendingViewport !== undefined
        && pendingViewport.preserveOnRebuild
        && pendingViewport.documentId === message.documentId
        && pendingViewport.generation !== message.payload.snapshot.generation
        ? pendingViewport
        : undefined;
      const manualRebuildIntent = rebuildChangedGeneration
        && rebuildIntent !== undefined
        && rebuildIntent.documentId === message.documentId
        && rebuildIntent.generation !== message.payload.snapshot.generation
        ? rebuildIntent
        : undefined;
      const candidateViewportQuery = pendingRebuildIntent?.query
        ?? manualRebuildIntent?.viewportQuery
        ?? savedViewport?.query;
      const queryMatchesViewport = candidateViewportQuery === undefined
        || candidateViewportQuery === currentQuery;
      const resumeRows = rebuildChangedGeneration && !currentFollowMode
        ? queryMatchesViewport
          ? pendingRebuildIntent?.options
            ?? manualRebuildIntent?.options
            ?? rowsOptionsAfterRebuild(savedViewport?.firstVisibleOrdinal, false)
          : {}
        : undefined;
      const candidateQuery = pendingRebuildIntent?.query
        ?? manualRebuildIntent?.query
        ?? savedViewport?.query;
      const resumeQuery = rebuildChangedGeneration && candidateQuery === currentQuery
        ? candidateQuery
        : undefined;
      if (rebuildChangedGeneration) {
        // Any page submission belongs to the retired generation. Release its
        // request marker so a missing/cancelled old response cannot keep the
        // page input dirty forever; an unsubmitted draft has no marker and is
        // intentionally preserved.
        if (pageInputRequestRef.current !== undefined) {
          pageInputRequestRef.current = undefined;
          pageInputDirtyRef.current = false;
        }
        if (!currentFollowMode) {
          const capturedFirstVisibleOrdinal = manualRebuildIntent?.firstVisibleOrdinal
            ?? (queryMatchesViewport ? savedViewport?.firstVisibleOrdinal : undefined);
          const capturedPageText = manualRebuildIntent?.pageText
            ?? (queryMatchesViewport ? pageInputRef.current : '1');
          restoreViewportRef.current = {
            documentId: message.documentId,
            generation: message.payload.snapshot.generation,
            query: currentQuery,
            ...(capturedFirstVisibleOrdinal === undefined
              ? {} : { firstVisibleOrdinal: capturedFirstVisibleOrdinal }),
            pageText: capturedPageText,
            requestId: '',
            phase: 'initial',
          };
        } else {
          restoreViewportRef.current = undefined;
        }
        // Consume the old-generation cursor before issuing the replacement
        // request. A duplicate OPENED for the new generation then leaves the
        // in-flight request alone instead of starting from page one again.
        viewportCursorRef.current = undefined;
        pendingViewportRef.current = undefined;
        rebuildViewportRef.current = undefined;
      }
      dispatch({ type: 'MESSAGE_RECEIVED', message });
      const requestRestoreFallback = (
        restore: RestoreViewportIntent,
        totalRecords: string | undefined,
        requestedOptions: RowsRequestOptions | undefined,
        matchedRecords?: string,
        scanTruncated = false,
      ): void => {
        if (invalidationRef.current !== undefined) {
          restoreViewportRef.current = undefined;
          return;
        }
        if (restore.query !== queryRef.current) {
          // The search box is editable before submission. A pending recovery
          // must never replace a user's newer draft query.
          restoreViewportRef.current = undefined;
          return;
        }
        if (restore.phase === 'retrying') {
          // One bounded retry is enough to cover a shrinking file. A second
          // empty response is a legitimate no-match query or another source
          // change, so stop rather than looping.
          restoreViewportRef.current = undefined;
          return;
        }
        const fallback = rowsOptionsAfterEmptyRebuild(
          restore.firstVisibleOrdinal,
          restore.pageText,
          PAGE_SIZE,
          totalRecords,
          restore.query,
          requestedOptions?.sortOffset,
          matchedRecords,
          scanTruncated,
        );
        if (fallback === undefined) {
          if (totalRecords === undefined) restore.phase = 'waiting-index';
          else restoreViewportRef.current = undefined;
          return;
        }
        if (totalRecords === '0' || (
          requestedOptions !== undefined
          && requestedOptions.anchorOrdinal === fallback.anchorOrdinal
          && requestedOptions.direction === fallback.direction
          && requestedOptions.sortOffset === fallback.sortOffset
        )) {
          restoreViewportRef.current = undefined;
          return;
        }
        restore.phase = 'retrying';
        requestRows(
          {
            ...fallback,
            ...(restore.query.trim() ? { query: restore.query } : {}),
          },
          {
            preserveOnRebuild: true,
            restoreAfterRebuild: true,
            restorePhase: 'retrying',
            supersedesRestore: false,
          },
        );
      };
      if (message.type === 'ROWS' && restoredRowsIntent !== undefined) {
        if (message.payload.rows.length > 0) {
          restoreViewportRef.current = undefined;
        } else {
          requestRestoreFallback(
            restoredRowsIntent,
            message.payload.totalRecords,
            restoredRowsOptions,
            message.payload.matchedRecords,
            message.payload.scan?.truncatedReason !== undefined,
          );
        }
      } else if (message.type === 'INDEX_PROGRESS') {
        const restore = restoreViewportRef.current;
        if (
          restore !== undefined
          && restore.documentId === message.documentId
          && restore.generation === message.generation
          && restore.phase === 'waiting-index'
          && message.payload.indexingComplete
        ) {
          requestRestoreFallback(restore, message.payload.indexedRecords, undefined);
        }
      }
      if (
        message.type === 'OPENED'
        && openedRows !== undefined
        && (invalidationRef.current === undefined || rebuildChangedGeneration)
      ) {
        const openedRequestOptions: RowsRequestOptions = {
          ...rowsOptionsAfterOpenedRequest(
            openedRows,
            resumeRows,
            currentFollowMode,
          ),
          ...(resumeQuery === undefined ? {} : { query: resumeQuery }),
        };
        if (rebuildChangedGeneration && !currentFollowMode) {
          const restore = restoreViewportRef.current;
          if (restore !== undefined) {
            restore.query = resumeQuery ?? currentQuery;
            restore.phase = 'initial';
          }
        }
        requestRows(
          openedRequestOptions,
          rebuildChangedGeneration
            ? {
              preserveOnRebuild: true,
              restoreAfterRebuild: !currentFollowMode,
              restorePhase: 'initial',
              supersedesRestore: false,
              allowWhileInvalidated: true,
            }
            : { allowWhileInvalidated: true },
        );
      } else if (message.type === 'PROFILE_CHANGED') {
        const restore = restoreViewportRef.current;
        const pendingRestore = pendingViewportRef.current?.restoreAfterRebuild === true
          && restore !== undefined;
        // A restoring row request may have captured the old profile query.
        // Replace it while retaining the physical rebuild cursor; a recovery
        // that is merely waiting for more index progress remains untouched.
        if (invalidationRef.current === undefined && (restore === undefined || pendingRestore)) {
          const profileRefresh = pendingRestore && !currentFollowMode
            ? rowsOptionsForViewport(
              restore.firstVisibleOrdinal,
              restore.pageText,
              PAGE_SIZE,
              false,
            )
            : rowsOptionsAfterRebuild(
              viewportCursorRef.current?.firstVisibleOrdinal,
              currentFollowMode,
            );
          requestRows(
            {
              ...profileRefresh,
              ...(currentQuery.trim() ? { query: currentQuery } : {}),
              filterColumns: message.payload.columns,
              ...(profileQuery?.sort === undefined ? {} : { sortOffset: '0' }),
            },
            pendingRestore
              ? {
                preserveOnRebuild: true,
                restoreAfterRebuild: true,
                restorePhase: restore.phase === 'retrying' ? 'retrying' : 'initial',
                supersedesRestore: false,
              }
              : { preserveOnRebuild: true },
          );
        }
      } else if (
        message.type === 'ERROR'
        && pendingViewportRef.current?.requestId === message.requestId
      ) {
        pendingViewportRef.current = undefined;
      } else if (
        message.type === 'ERROR'
        && rebuildViewportRef.current?.requestId === message.requestId
      ) {
        rebuildViewportRef.current = undefined;
      }
      if (
        message.type === 'OPENED'
        && currentFollowMode
        // Restore Follow once for the first/new snapshot. Duplicate
        // same-generation OPENED broadcasts must not enqueue another toggle.
        && openedGenerationChanged
      ) {
        const request = clientRef.current.send('SET_FOLLOW_MODE', { enabled: true });
        dispatch({ type: 'REQUEST_SENT', request });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [requestRows]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const payload = restored === undefined ? {} : { restoredState: restored };
    const request = clientRef.current.send('READY', payload);
    dispatch({ type: 'REQUEST_SENT', request });
  }, [restored]);

  useEffect(() => {
    if (
      state.invalidationReason === undefined
      && state.activeTab === 'schema'
      && state.summary
      && state.schema.length === 0
      && !state.pending.schema
    ) {
      requestSchema();
    }
  }, [requestSchema, state.activeTab, state.invalidationReason, state.pending.schema, state.schema.length, state.summary]);

  useEffect(() => {
    if (
      state.invalidationReason === undefined
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
      if (event.key === 'Escape' && (stateRef.current.detail || stateRef.current.pending.detail)) {
        finishCancelled('detail', clientRef.current.cancel('detail'));
        dispatch({ type: 'CLOSE_DETAIL' });
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [finishCancelled]);

  const summary = state.summary;
  const options = profileOptions(summary?.profileId, summary?.profileSuggestions ?? []);
  const baseColumns = useMemo(
    () => state.columns.length > 0 ? state.columns : fallbackColumns(state.rows),
    [state.columns, state.rows],
  );
  const filterableColumns = useMemo(
    () => baseColumns.filter((column) => column.id !== '__ordinal' && column.id !== '$ordinal'),
    [baseColumns],
  );
  const tableColumns = visibleColumns(baseColumns, state.columnVisibility, state.columnOrder);
  const timelineRows = selectTimelineRows(state);
  const problems = selectProblems(state);
  const problemEntries = state.problems === undefined
    ? problems
    : state.problems.items.map((problem) => ({
      ...problem,
      ...(problem.ref?.ordinal === undefined ? {} : { ordinal: problem.ref.ordinal }),
    }));
  const drawerOpen = Boolean(state.detail || state.pending.detail);
  const filename = fileLabel(summary?.snapshot.uri ?? document.body.dataset.uri);
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
    if (!filterColumnId) return;
    const needsValue = !['exists', 'is_null'].includes(filterOperator);
    const literal = parseFilterLiteral(filterValue);
    const kindValue = filterValue.trim();
    const filterBase: RowFilter = {
      columnId: filterColumnId,
      operator: filterOperator,
      ...(selectedFilterColumn?.source === 'profile'
        ? { source: 'profile' as const }
        : selectedFilterColumn?.path === undefined
          ? {}
          : { source: 'record' as const, path: selectedFilterColumn.path }),
      ...(needsValue ? { value: literal } : {}),
      ...(filterOperator === 'contains' || filterOperator === 'starts_with' || filterOperator === 'ends_with'
        ? { caseSensitive: filterCaseSensitive }
        : {}),
    };
    const filter: RowFilter = filterOperator === 'kind_is' && kindValue.length > 0
      ? { ...filterBase, kind: kindValue as JsonKind }
      : filterBase;
    if (predicateForFilter(filter, filterableColumns) === undefined) return;
    applyFilter(filter);
  };

  const setProfile = (profileId: string): void => {
    if (invalidationRef.current !== undefined) return;
    restoreViewportRef.current = undefined;
    finishCancelled('profile', clientRef.current.cancel('profile'));
    const request = clientRef.current.send('SET_PROFILE', { profileId });
    dispatch({ type: 'REQUEST_SENT', request });
  };

  const setFollow = (enabled: boolean): void => {
    if (invalidationRef.current !== undefined) return;
    restoreViewportRef.current = undefined;
    followModeRef.current = enabled;
    dispatch({ type: 'SET_FOLLOW_MODE', enabled });
    finishCancelled('follow', clientRef.current.cancel('follow'));
    const request = clientRef.current.send('SET_FOLLOW_MODE', { enabled });
    dispatch({ type: 'REQUEST_SENT', request });
    if (enabled) requestRows({ direction: 'backward' });
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

  const nextPage = (): void => {
    if (sortRef.current !== undefined) {
      const currentOffset = normalizeSortOffset(sortOffsetRef.current);
      const offset = BigInt(currentOffset);
      let nextOffset: bigint;
      try {
        nextOffset = state.page?.sortNextOffset === undefined
          ? offset + BigInt(PAGE_SIZE)
          : BigInt(state.page.sortNextOffset);
      } catch {
        nextOffset = offset + BigInt(PAGE_SIZE);
      }
      if (nextOffset <= offset) return;
      if (!canRequestSortedPage(sortRef.current, nextOffset, PAGE_SIZE)) return;
      const next = nextOffset.toString();
      const position = advanceSortPage(
        sortOffsetHistoryRef.current,
        currentOffset,
        sortPageRef.current,
        next,
        PAGE_SIZE,
      );
      sortOffsetHistoryRef.current = position.history;
      sortOffsetRef.current = position.offset;
      sortPageRef.current = position.page;
      dispatch({ type: 'SET_SORT_OFFSET', ...position });
      setPageInput(position.page);
      requestRows({ sortOffset: position.offset });
      return;
    }
    const scanCursor = state.page?.scan?.truncatedReason
      && state.page.scan.direction === 'forward'
      ? state.page.scan.cursorOrdinal
      : undefined;
    const anchorOrdinal = scanCursor ?? state.rows.at(-1)?.ref.ordinal ?? state.page?.anchorOrdinal;
    if (anchorOrdinal) requestRows({ anchorOrdinal, direction: 'forward' });
  };

  const previousPage = (): void => {
    if (sortRef.current !== undefined) {
      const previous = previousSortPage(
        sortOffsetHistoryRef.current,
        sortOffsetRef.current,
        sortPageRef.current,
        PAGE_SIZE,
      );
      sortOffsetHistoryRef.current = previous.history;
      sortOffsetRef.current = previous.offset;
      sortPageRef.current = previous.page;
      dispatch({ type: 'SET_SORT_OFFSET', ...previous });
      setPageInput(previous.page);
      requestRows({ sortOffset: previous.offset });
      return;
    }
    const scanCursor = state.page?.scan?.truncatedReason
      && state.page.scan.direction === 'backward'
      ? state.page.scan.cursorOrdinal
      : undefined;
    const anchorOrdinal = scanCursor ?? state.rows[0]?.ref.ordinal ?? state.page?.anchorOrdinal;
    if (anchorOrdinal) requestRows({ anchorOrdinal, direction: 'backward' });
  };

  const jumpToPage = (): void => {
    // Do not normalize or clear a draft while the source barrier is active;
    // the disabled field may still dispatch a trailing blur event.
    if (invalidationRef.current !== undefined) return;
    // Focus/blur is not a navigation intent. This is important for a partial
    // sorted page whose display page can still be "1" at offsets such as 3.
    if (!pageInputDirtyRef.current) return;
    const value = pageInputRef.current.trim();
    if (sortRef.current !== undefined) {
      let page: bigint;
      try { page = BigInt(value); } catch { page = 0n; }
      const offset = page > 0n ? (page - 1n) * BigInt(PAGE_SIZE) : -1n;
      if (
        page < 1n
        || offset < 0n
        || !canRequestSortedPage(sortRef.current, offset, PAGE_SIZE)
      ) {
        pageInputDirtyRef.current = false;
        setPageInput(sortPageRef.current);
        return;
      }
      const offsetText = offset.toString();
      const pageText = page.toString();
      sortOffsetHistoryRef.current = [];
      sortOffsetRef.current = offsetText;
      sortPageRef.current = pageText;
      dispatch({ type: 'SET_SORT_OFFSET', offset: offsetText, history: [], page: pageText });
      requestRows({ sortOffset: offsetText }, { pageInputSubmission: true });
      return;
    }
    const anchorOrdinal = anchorForPage(value, PAGE_SIZE);
    if (anchorOrdinal === undefined && value !== '1') {
      pageInputDirtyRef.current = false;
      pageInputRequestRef.current = undefined;
      setPageInput(pageFromOrdinal(state.rows[0]?.ref.ordinal, PAGE_SIZE));
      return;
    }
    // An explicit jump to page one is still a viewport intent. Preserve the
    // empty options object so a concurrent rebuild does not fall back to an
    // older page cursor.
    requestRows(
      anchorOrdinal === undefined ? {} : { anchorOrdinal, direction: 'forward' },
      { pageInputSubmission: true },
    );
  };

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
           return canRequestSortedPage(sortRef.current, nextOffset, PAGE_SIZE);
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
      <header className="toolbar">
        <div className="toolbar-identity" title={summary?.snapshot.uri ?? filename}>
          <FileJson2 size={16} aria-hidden />
          <span>{filename}</span>
        </div>
        <label className="compact-field profile-field">
          <span>Profile</span>
          <select
            value={summary?.profileId ?? 'generic'}
            disabled={!summary || state.invalidationReason !== undefined || Boolean(state.pending.profile)}
            onChange={(event) => setProfile(event.target.value)}
          >
            {options.map((option) => <option value={option.id} key={option.id}>{option.displayName}</option>)}
          </select>
        </label>
        <label className="follow-toggle" title="Follow appended records">
            <input
              type="checkbox"
              checked={state.followMode}
              disabled={!summary || state.invalidationReason !== undefined || Boolean(state.pending.follow)}
            onChange={(event) => setFollow(event.target.checked)}
          />
          <span>Follow</span>
        </label>
        <RecordQueryControls
          query={state.query}
          searchDisabled={!summary || state.invalidationReason !== undefined}
          onSearchSubmit={() => {
            const query = queryRef.current;
            if (state.activeTab === 'insights') requestInsights({ query });
            else requestRows({ query });
          }}
          onSearchChange={(query) => {
            queryRef.current = query;
            sortOffsetRef.current = '0';
            sortOffsetHistoryRef.current = [];
            sortPageRef.current = '1';
            if (pageInputRequestRef.current !== undefined) {
              pageInputRequestRef.current = undefined;
              pageInputDirtyRef.current = false;
            }
            if (restoreViewportRef.current?.query !== query) restoreViewportRef.current = undefined;
            dispatch({ type: 'SET_QUERY', query });
          }}
          onSearchClear={() => {
            queryRef.current = '';
            sortOffsetRef.current = '0';
            sortOffsetHistoryRef.current = [];
            sortPageRef.current = '1';
            if (pageInputRequestRef.current !== undefined) {
              pageInputRequestRef.current = undefined;
              pageInputDirtyRef.current = false;
            }
            dispatch({ type: 'SET_QUERY', query: '' });
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
        <button
          type="button"
          className="icon-button"
          title="Rebuild index"
          aria-label="Rebuild index"
          disabled={!summary || Boolean(state.pending.rebuild)}
          onClick={rebuild}
        >
          <RefreshCw size={15} className={state.pending.rebuild ? 'spin' : ''} aria-hidden />
        </button>
        <details className="columns-menu">
          <summary className="icon-button" title="Choose columns" aria-label="Choose columns">
            <Columns3 size={15} aria-hidden />
          </summary>
          <div className="columns-popover">
            {[{ id: '__ordinal', label: '#' }, ...baseColumns].map((column) => (
              <label key={column.id}>
                <input
                  type="checkbox"
                  disabled={column.id === '__ordinal'}
                  checked={state.columnVisibility[column.id] !== false}
                  onChange={(event) => dispatch({
                    type: 'SET_COLUMN_VISIBILITY',
                    columnId: column.id,
                    visible: event.target.checked,
                  })}
                />
                <span title={column.label}>{column.label}</span>
              </label>
            ))}
          </div>
        </details>
      </header>

      <StatusStrip
        filename={filename}
        indexedBytes={summary?.indexedBytes ?? '0'}
        sizeBytes={summary?.snapshot.sizeBytes ?? '0'}
        indexedRecords={summary?.indexedRecords ?? '0'}
        validRecords={summary?.validRecords ?? '0'}
        problemRecords={summary?.problemRecords ?? '0'}
        complete={summary?.indexingComplete ?? false}
        phase={state.phase}
      />

      {state.invalidationReason !== undefined ? (
        <div className="workspace-banner invalidated-banner" role="alert">
          <AlertTriangle size={15} aria-hidden />
          <span>Source changed ({state.invalidationReason ?? 'unknown'}). This view is a stale snapshot.</span>
          <button type="button" onClick={rebuild}><RefreshCw size={14} aria-hidden />Rebuild</button>
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

      <nav className="workspace-tabs" aria-label="Workspace views">
        {tabs.map(({ id, label, icon: Icon }) => {
          const count = id === 'timeline' ? timelineRows.length : id === 'problems' ? problemEntries.length : undefined;
          return (
            <button
              type="button"
              className={state.activeTab === id ? 'is-active' : ''}
              aria-selected={state.activeTab === id}
              key={id}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: id })}
            >
              <Icon size={14} aria-hidden />
              {label}
              {count !== undefined ? (
                <span
                  className="tab-count"
                  title={id === 'problems' ? 'Problem entries in the current visible page; the status strip is an observed problem-record count' : undefined}
                >
                  {count}
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
          {state.activeTab === 'table' ? (
            <RecordTable
              rows={state.rows}
              columns={tableColumns}
              selectedOrdinal={state.selectedOrdinal}
              loading={Boolean(state.pending.rows) || state.phase === 'booting'}
              onSelect={requestDetail}
              columnWidths={state.columnWidths}
              onColumnWidthChange={setColumnWidth}
              sort={state.sort}
              onSortChange={setSort}
              onColumnOrderChange={setColumnOrder}
            />
          ) : null}
          {state.activeTab === 'timeline' ? (
            <TimelineView rows={timelineRows} selectedOrdinal={state.selectedOrdinal} onSelect={requestDetail} />
          ) : null}
          {state.activeTab === 'schema' ? (
            <SchemaView fields={state.schema} total={state.schemaTotal} loading={Boolean(state.pending.schema)} />
          ) : null}
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
          {state.activeTab === 'insights' ? (
            <div className="insights-shell">
              <div className="insights-toolbar">
                <label className="compact-field">
                  <span>Group by</span>
                  <select
                    value={state.insightDimension}
                    disabled={state.invalidationReason !== undefined || Boolean(state.pending.insights)}
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
                  disabled={state.invalidationReason !== undefined || Boolean(state.pending.insights)}
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
          <RecordPager
            visible={showPageControls}
            busy={Boolean(state.pending.rows)}
            invalidated={state.invalidationReason !== undefined}
            hasBefore={state.page?.hasBefore === true}
            canAdvance={canAdvancePage}
            pageInput={pageInput}
            pageRange={pageRange}
            onPrevious={previousPage}
            onNext={nextPage}
            onJump={jumpToPage}
            onInputFocus={() => {
              pageInputFocusedRef.current = true;
            }}
            onInputChange={(value) => {
              const submittedPageRequest = pageInputRequestRef.current;
              pageInputRequestRef.current = undefined;
              if (
                submittedPageRequest !== undefined
                && pendingViewportRef.current?.requestId === submittedPageRequest
              ) {
                pendingViewportRef.current = undefined;
              }
              rebuildViewportRef.current = undefined;
              pageInputDirtyRef.current = true;
              restoreViewportRef.current = undefined;
              setPageInput(value);
            }}
            onInputKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                jumpToPage();
              }
            }}
            onInputBlur={() => {
              pageInputFocusedRef.current = false;
              jumpToPage();
            }}
          />
        </section>
        {drawerOpen ? (
          <>
            <div
              className="detail-splitter"
              role="separator"
              aria-label="Resize record detail"
              aria-orientation="vertical"
              aria-valuemin={MIN_DETAIL_WIDTH}
              aria-valuemax={Math.max(
                MIN_DETAIL_WIDTH,
                workspaceWidth - MIN_PRIMARY_WIDTH - SPLITTER_WIDTH,
              )}
              aria-valuenow={displayedDetailWidth}
              tabIndex={0}
              title="Drag to resize detail"
              onPointerDown={resizeDetailFromPointer}
              onKeyDown={resizeDetailFromKeyboard}
              onDoubleClick={() => {
                const containerWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
                dispatch({ type: 'SET_DETAIL_WIDTH', width: clampDetailWidth(DEFAULT_DETAIL_WIDTH, containerWidth) });
              }}
            />
            <DetailDrawer
              detail={state.detail}
              loading={Boolean(state.pending.detail)}
              activeTab={state.detailTab}
              onTabChange={(tab) => dispatch({ type: 'SET_DETAIL_TAB', tab })}
              onRequestFull={() => {
                const ref = stateRef.current.detail?.ref;
                if (ref !== undefined) requestDetail(ref, true);
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
