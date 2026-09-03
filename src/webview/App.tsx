import React, { useCallback, useEffect, useMemo, useReducer, useRef, type CSSProperties } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Braces,
  Check,
  CircleAlert,
  Columns3,
  FileJson2,
  LoaderCircle,
  RefreshCw,
  Search,
  Table2,
  X,
} from 'lucide-react';
import type { InsightDimension, Predicate, RecordRef } from '../shared/types';
import { DetailDrawer } from './detail-drawer';
import { deferIdle } from './idle';
import { InsightsView } from './insights-view';
import { formatBytes, visibleColumns } from './format';
import { anchorForPage, pageFromOrdinal } from './paging';
import { VsCodeMessageClient } from './protocol-client';
import {
  createInitialState,
  selectProblems,
  selectTimelineRows,
  toPersistedState,
  workspaceReducer,
  type PersistedWorkspaceState,
  type RequestKind,
  type WorkspaceTab,
} from './state';
import {
  fallbackColumns,
  ProblemsView,
  SchemaView,
  TableView,
  TimelineView,
} from './views';
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
const SCHEMA_PAGE_SIZE = 250;

const vscode = acquireVsCodeApi<PersistedWorkspaceState>();

function bodySession(): { documentId: string; generation: string } {
  return {
    documentId: document.body.dataset.documentId ?? document.body.dataset.uri ?? 'jsonl-view-bootstrap',
    generation: document.body.dataset.generation ?? 'bootstrap',
  };
}

function textPredicate(query: string): Predicate | undefined {
  const value = query.trim();
  return value ? { op: 'text_search', value, caseSensitive: false } : undefined;
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
      <span className={props.problemRecords === '0' ? '' : 'status-problem'}>
        <CircleAlert size={13} aria-hidden />{props.problemRecords}
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

export function App(): React.JSX.Element {
  const restored = useMemo(() => vscode.getState(), []);
  const [state, dispatch] = useReducer(workspaceReducer, restored, createInitialState);
  const [pageInput, setPageInput] = React.useState('1');
  const stateRef = useRef(state);
  const persistedStateRef = useRef<PersistedWorkspaceState>(toPersistedState(state));
  const clientRef = useRef(new VsCodeMessageClient(vscode, bodySession()));
  const startedRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

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
    setPageInput(pageFromOrdinal(state.rows[0]?.ref.ordinal, PAGE_SIZE));
  }, [state.rows]);

  const finishCancelled = useCallback((kind: RequestKind, ids: string[]): void => {
    for (const requestId of ids) dispatch({ type: 'REQUEST_FINISHED', kind, requestId });
  }, []);

  const requestRows = useCallback((options?: {
    anchorOrdinal?: string;
    direction?: 'forward' | 'backward';
    query?: string;
  }): void => {
    const client = clientRef.current;
    finishCancelled('rows', client.cancel('rows'));
    const query = options?.query ?? stateRef.current.query;
    const predicate = textPredicate(query);
    const payload = {
      limit: PAGE_SIZE,
      ...(options?.anchorOrdinal ? { anchorOrdinal: options.anchorOrdinal } : {}),
      ...(options?.direction ? { direction: options.direction } : {}),
      ...(predicate ? { predicate } : {}),
    };
    const request = client.send('GET_ROWS', payload);
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
    const client = clientRef.current;
    finishCancelled('schema', client.cancel('schema'));
    const request = client.send('GET_SCHEMA', { offset: 0, limit: SCHEMA_PAGE_SIZE });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestInsights = useCallback((options?: {
    dimension?: InsightDimension;
    query?: string;
  }): void => {
    const client = clientRef.current;
    finishCancelled('insights', client.cancel('insights'));
    const dimension = options?.dimension ?? stateRef.current.insightDimension;
    const predicate = textPredicate(options?.query ?? stateRef.current.query);
    const request = client.send('GET_INSIGHTS', {
      dimension,
      ...(predicate ? { predicate } : {}),
    });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const requestDetail = useCallback((ref: RecordRef): void => {
    const client = clientRef.current;
    finishCancelled('detail', client.cancel('detail'));
    dispatch({ type: 'SELECT_ROW', ordinal: ref.ordinal });
    const request = client.send('GET_DETAIL', { ref });
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  const setColumnWidth = useCallback((columnId: string, width: number | undefined): void => {
    dispatch({ type: 'SET_COLUMN_WIDTH', columnId, width });
  }, []);

  const rebuild = useCallback((): void => {
    const client = clientRef.current;
    for (const kind of ['rows', 'detail', 'schema', 'insights'] as const) {
      finishCancelled(kind, client.cancel(kind));
    }
    const request = client.send('REBUILD_INDEX', {});
    dispatch({ type: 'REQUEST_SENT', request });
  }, [finishCancelled]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const message = clientRef.current.accept(event.data);
      if (!message) return;
      dispatch({ type: 'MESSAGE_RECEIVED', message });
      if (message.type === 'OPENED') {
        requestRows(stateRef.current.followMode ? { direction: 'backward' } : undefined);
      } else if (message.type === 'PROFILE_CHANGED') {
        requestRows();
      }
      if (message.type === 'OPENED' && stateRef.current.followMode) {
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
    if (state.activeTab === 'schema' && state.summary && state.schema.length === 0 && !state.pending.schema) {
      requestSchema();
    }
  }, [requestSchema, state.activeTab, state.pending.schema, state.schema.length, state.summary]);

  useEffect(() => {
    if (state.activeTab === 'insights' && state.summary && !state.insights && !state.pending.insights) {
      requestInsights();
    }
    if (state.activeTab !== 'insights' && state.pending.insights) {
      finishCancelled('insights', clientRef.current.cancel('insights'));
    }
  }, [finishCancelled, requestInsights, state.activeTab, state.insights, state.pending.insights, state.summary]);

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
  const baseColumns = state.columns.length > 0 ? state.columns : fallbackColumns(state.rows);
  const tableColumns = visibleColumns(baseColumns, state.columnVisibility);
  const timelineRows = selectTimelineRows(state);
  const problems = selectProblems(state);
  const drawerOpen = Boolean(state.detail || state.pending.detail);
  const filename = fileLabel(summary?.snapshot.uri ?? document.body.dataset.uri);
  const workspaceWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
  const displayedDetailWidth = workspaceWidth > 900
    ? clampDetailWidth(state.detailWidth, workspaceWidth)
    : state.detailWidth;

  const setProfile = (profileId: string): void => {
    finishCancelled('profile', clientRef.current.cancel('profile'));
    const request = clientRef.current.send('SET_PROFILE', { profileId });
    dispatch({ type: 'REQUEST_SENT', request });
  };

  const setFollow = (enabled: boolean): void => {
    dispatch({ type: 'SET_FOLLOW_MODE', enabled });
    finishCancelled('follow', clientRef.current.cancel('follow'));
    const request = clientRef.current.send('SET_FOLLOW_MODE', { enabled });
    dispatch({ type: 'REQUEST_SENT', request });
    if (enabled) requestRows({ direction: 'backward' });
  };

  const selectProblem = (ordinal: string): void => {
    const row = state.rows.find((candidate) => candidate.ref.ordinal === ordinal);
    if (row) {
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'table' });
      requestDetail(row.ref);
    }
  };

  const nextPage = (): void => {
    const anchorOrdinal = state.rows.at(-1)?.ref.ordinal;
    if (anchorOrdinal) requestRows({ anchorOrdinal, direction: 'forward' });
  };

  const previousPage = (): void => {
    const anchorOrdinal = state.rows[0]?.ref.ordinal ?? state.page?.anchorOrdinal;
    if (anchorOrdinal) requestRows({ anchorOrdinal, direction: 'backward' });
  };

  const jumpToPage = (): void => {
    const value = pageInput.trim();
    const anchorOrdinal = anchorForPage(value, PAGE_SIZE);
    if (anchorOrdinal === undefined && value !== '1') {
      setPageInput(pageFromOrdinal(state.rows[0]?.ref.ordinal, PAGE_SIZE));
      return;
    }
    requestRows(anchorOrdinal === undefined ? undefined : { anchorOrdinal, direction: 'forward' });
  };

  const pageRange = state.rows.length > 0
    ? `Rows #${state.rows[0]?.ref.ordinal}-#${state.rows.at(-1)?.ref.ordinal}`
    : `${state.rows.length} rows`;

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
            disabled={!summary || Boolean(state.pending.profile)}
            onChange={(event) => setProfile(event.target.value)}
          >
            {options.map((option) => <option value={option.id} key={option.id}>{option.displayName}</option>)}
          </select>
        </label>
        <label className="follow-toggle" title="Follow appended records">
          <input
            type="checkbox"
            checked={state.followMode}
            disabled={!summary || Boolean(state.pending.follow)}
            onChange={(event) => setFollow(event.target.checked)}
          />
          <span>Follow</span>
        </label>
        <form
          className="search-box"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (state.activeTab === 'insights') requestInsights({ query: state.query });
            else requestRows({ query: state.query });
          }}
        >
          <Search size={14} aria-hidden />
          <input
            value={state.query}
            placeholder="Search records"
            aria-label="Search records"
            disabled={!summary || state.phase === 'invalidated'}
            onChange={(event) => dispatch({ type: 'SET_QUERY', query: event.target.value })}
          />
          {state.query ? (
            <button
              type="button"
              className="search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => {
                dispatch({ type: 'SET_QUERY', query: '' });
                if (state.activeTab === 'insights') requestInsights({ query: '' });
                else requestRows({ query: '' });
              }}
            >
              <X size={13} aria-hidden />
            </button>
          ) : null}
        </form>
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

      {state.phase === 'invalidated' ? (
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

      <nav className="workspace-tabs" aria-label="Workspace views">
        {tabs.map(({ id, label, icon: Icon }) => {
          const count = id === 'timeline' ? timelineRows.length : id === 'problems' ? problems.length : undefined;
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
              {count !== undefined ? <span className="tab-count">{count}</span> : null}
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
            <TableView
              rows={state.rows}
              columns={tableColumns}
              selectedOrdinal={state.selectedOrdinal}
              loading={Boolean(state.pending.rows) || state.phase === 'booting'}
              onSelect={requestDetail}
              columnWidths={state.columnWidths}
              onColumnWidthChange={setColumnWidth}
            />
          ) : null}
          {state.activeTab === 'timeline' ? (
            <TimelineView rows={timelineRows} selectedOrdinal={state.selectedOrdinal} onSelect={requestDetail} />
          ) : null}
          {state.activeTab === 'schema' ? (
            <SchemaView fields={state.schema} total={state.schemaTotal} loading={Boolean(state.pending.schema)} />
          ) : null}
          {state.activeTab === 'problems' ? (
            <ProblemsView problems={problems} onSelectOrdinal={selectProblem} />
          ) : null}
          {state.activeTab === 'insights' ? (
            <div className="insights-shell">
              <div className="insights-toolbar">
                <label className="compact-field">
                  <span>Group by</span>
                  <select
                    value={state.insightDimension}
                    disabled={Boolean(state.pending.insights)}
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
                  disabled={Boolean(state.pending.insights)}
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
          {(state.activeTab === 'table' || state.activeTab === 'timeline') && state.rows.length > 0 ? (
            <footer className="page-controls" aria-busy={Boolean(state.pending.rows)}>
              <button
                type="button"
                title="Previous page"
                disabled={!state.page?.hasBefore || Boolean(state.pending.rows)}
                onClick={previousPage}
              >
                <ArrowLeft size={14} aria-hidden />Previous
              </button>
              <label className="page-jump" title="Jump to a physical record page; active filters may scan additional rows.">
                <span>Page</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  aria-label="Page number"
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      jumpToPage();
                    }
                  }}
                  onBlur={jumpToPage}
                />
              </label>
              <span className="page-cursor" aria-live="polite">
                {state.pending.rows ? 'Loading page...' : pageRange}
              </span>
              <button
                type="button"
                title="Next page"
                disabled={!state.page?.hasAfter || Boolean(state.pending.rows)}
                onClick={nextPage}
              >
                Next<ArrowRight size={14} aria-hidden />
              </button>
            </footer>
          ) : null}
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
  switch (reason) {
    case 'record_limit': return 'record limit';
    case 'byte_limit': return 'byte limit';
    case 'time_limit': return 'time limit';
  }
}
