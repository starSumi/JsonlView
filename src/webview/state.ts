import type {
  ColumnSpec,
  DocumentSummary,
  ExtensionMessage,
  FieldStats,
  InsightDimension,
  InsightSummary,
  ProblemRef,
  ProblemPage,
  RecordDetail,
  RowFilter,
  RowPage,
  RowProjection,
  RowSort,
} from '../shared/types';
import { normalizeSortOffset, normalizeSortOffsetHistory, normalizeSortPage } from './paging';
import { DEFAULT_DETAIL_WIDTH } from './split-pane';

export type WorkspaceTab = 'table' | 'timeline' | 'schema' | 'problems' | 'insights';
export type DetailTab = 'tree' | 'raw' | 'derived' | 'bytes';
export type WorkspacePhase = 'booting' | 'loading' | 'ready' | 'invalidated' | 'degraded' | 'error';
export type RequestKind = 'ready' | 'rows' | 'problems' | 'detail' | 'schema' | 'insights' | 'profile' | 'follow' | 'rebuild';

export interface RequestState {
  id: string;
  kind: RequestKind;
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
  page?: Pick<RowPage, 'anchorOrdinal' | 'hasBefore' | 'hasAfter' | 'sort' | 'sortOffset' | 'sortNextOffset' | 'matchedRecords' | 'scan'> | undefined;
  problems?: ProblemPage | undefined;
  selectedOrdinal?: string | undefined;
  detail?: RecordDetail | undefined;
  schema: FieldStats[];
  schemaTotal: number;
  schemaComplete: boolean;
  insights?: InsightSummary | undefined;
  insightDimension: InsightDimension;
  activeTab: WorkspaceTab;
  detailTab: DetailTab;
  detailWidth: number;
  query: string;
  filter?: RowFilter | undefined;
  sort?: RowSort | undefined;
  sortOffset: string;
  sortOffsetHistory: string[];
  sortPage: string;
  followMode: boolean;
  columnVisibility: Record<string, boolean>;
  columnWidths: Record<string, number>;
  columnOrder: string[];
  pending: Partial<Record<RequestKind, RequestState>>;
  invalidationReason?: 'append' | 'truncate' | 'replace' | 'delete' | 'unknown' | undefined;
  error?: WorkspaceError | undefined;
}

export interface PersistedWorkspaceState {
  activeTab?: WorkspaceTab;
  detailTab?: DetailTab;
  detailWidth?: number;
  query?: string;
  filter?: RowFilter | undefined;
  sort?: RowSort | undefined;
  sortOffset?: string;
  sortOffsetHistory?: string[];
  sortPage?: string;
  followMode?: boolean;
  insightDimension?: InsightDimension;
  columnVisibility?: Record<string, boolean>;
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
}

export type WorkspaceAction =
  | { type: 'REQUEST_SENT'; request: RequestState }
  | { type: 'REQUEST_FINISHED'; kind: RequestKind; requestId: string }
  | { type: 'MESSAGE_RECEIVED'; message: ExtensionMessage }
  | { type: 'SET_ACTIVE_TAB'; tab: WorkspaceTab }
  | { type: 'SET_INSIGHT_DIMENSION'; dimension: InsightDimension }
  | { type: 'SET_DETAIL_TAB'; tab: DetailTab }
  | { type: 'SET_DETAIL_WIDTH'; width: number }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SET_FILTER'; filter?: RowFilter | undefined }
  | { type: 'SET_SORT'; sort?: RowSort | undefined }
  | { type: 'SET_SORT_OFFSET'; offset: string; history: string[]; page: string }
  | { type: 'SET_FOLLOW_MODE'; enabled: boolean }
  | { type: 'SET_COLUMN_VISIBILITY'; columnId: string; visible: boolean }
  | { type: 'SET_COLUMN_WIDTH'; columnId: string; width?: number | undefined }
  | { type: 'SET_COLUMN_ORDER'; order: string[] }
  | { type: 'SELECT_ROW'; ordinal?: string }
  | { type: 'CLOSE_DETAIL' }
  | { type: 'DISMISS_ERROR' };

export function createInitialState(restored?: PersistedWorkspaceState, pageSize = 100): WorkspaceState {
  const sortOffset = restored?.sort === undefined ? '0' : normalizeSortOffset(restored.sortOffset);
  return {
    phase: 'booting',
    rows: [],
    columns: [],
    schema: [],
    schemaTotal: 0,
    schemaComplete: false,
    insightDimension: restored?.insightDimension ?? 'eventKind',
    activeTab: restored?.activeTab ?? 'table',
    detailTab: restored?.detailTab ?? 'tree',
    detailWidth: restored?.detailWidth ?? DEFAULT_DETAIL_WIDTH,
    query: restored?.query ?? '',
    filter: restored?.filter,
    sort: restored?.sort,
    sortOffset,
    sortOffsetHistory: restored?.sort === undefined
      ? []
      : normalizeSortOffsetHistory(restored.sortOffsetHistory, sortOffset),
    sortPage: restored?.sort === undefined
      ? '1'
      : normalizeSortPage(restored.sortPage, sortOffset, pageSize),
    followMode: restored?.followMode ?? false,
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
  const next: Record<string, boolean> = { __ordinal: current.__ordinal ?? true };
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

export interface ReconciledProfileQueryState {
  sort?: RowSort;
  filter?: RowFilter;
}

function isOrdinalColumn(columnId: string): boolean {
  return columnId === '__ordinal' || columnId === '$ordinal';
}

function isEncodedRecordColumnId(columnId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(columnId);
    return Array.isArray(parsed) && parsed.length <= 32 && parsed.every((token) => {
      if (token === null || typeof token !== 'object' || Array.isArray(token)) return false;
      const candidate = token as Record<string, unknown>;
      return (candidate.kind === 'key' && typeof candidate.value === 'string')
        || (candidate.kind === 'index' && typeof candidate.value === 'number'
          && Number.isSafeInteger(candidate.value) && candidate.value >= 0);
    });
  } catch {
    return false;
  }
}

/**
 * Keep query state only when its column keeps the same meaning after a profile
 * switch. Record paths remain valid unless the new profile shadows the id;
 * profile fields must be explicitly present in the new profile columns.
 */
export function reconcileProfileQueryState(
  sort: RowSort | undefined,
  filter: RowFilter | undefined,
  currentColumns: readonly ColumnSpec[],
  nextColumns: readonly ColumnSpec[],
): ReconciledProfileQueryState {
  const currentById = new Map(currentColumns.map((column) => [column.id, column]));
  const nextById = new Map(nextColumns.map((column) => [column.id, column]));

  let nextSort: RowSort | undefined;
  if (sort !== undefined) {
    if (isOrdinalColumn(sort.columnId)) {
      nextSort = sort;
    } else {
      const currentColumn = currentById.get(sort.columnId);
      const nextColumn = nextById.get(sort.columnId);
      if (currentColumn?.source === 'record') {
        if (nextColumn === undefined || nextColumn.source === 'record') nextSort = sort;
      } else if (currentColumn !== undefined) {
        if (nextColumn?.source === currentColumn.source) nextSort = sort;
      } else if (nextColumn !== undefined || isEncodedRecordColumnId(sort.columnId)) {
        nextSort = sort;
      }
    }
  }

  let nextFilter: RowFilter | undefined;
  if (filter !== undefined) {
    const currentColumn = currentById.get(filter.columnId);
    const nextColumn = nextById.get(filter.columnId);
    const source = filter.source ?? currentColumn?.source;
    if (source === 'record') {
      if (nextColumn === undefined || nextColumn.source === 'record') nextFilter = filter;
    } else if (source === 'profile') {
      if (nextColumn?.source === 'profile') nextFilter = filter;
    } else if (currentColumn !== undefined) {
      if (nextColumn?.source === currentColumn.source) nextFilter = filter;
    } else if (nextColumn !== undefined) {
      nextFilter = filter;
    }
  }

  return {
    ...(nextSort === undefined ? {} : { sort: nextSort }),
    ...(nextFilter === undefined ? {} : { filter: nextFilter }),
  };
}

function receiveMessage(state: WorkspaceState, message: ExtensionMessage): WorkspaceState {
  const pending = completeRequest(state.pending, message.requestId);
  switch (message.type) {
    case 'OPENED': {
      const generationChanged = state.summary?.snapshot.generation !== message.payload.snapshot.generation;
      // A source invalidation is terminal for the current generation. Only a
      // genuinely new snapshot can clear the stale-source barrier; a late
      // same-generation OPENED must not hide it.
      if (state.invalidationReason !== undefined && !generationChanged) return { ...state, pending };
      const preserveFollowViewport = generationChanged && state.followMode && state.rows.length > 0;
      return {
        ...state,
        phase: message.payload.indexingComplete ? 'ready' : 'loading',
        summary: message.payload,
        rows: generationChanged && !preserveFollowViewport ? [] : state.rows,
        columns: generationChanged && !preserveFollowViewport ? [] : state.columns,
        page: generationChanged && !preserveFollowViewport ? undefined : state.page,
        problems: generationChanged ? undefined : state.problems,
        selectedOrdinal: generationChanged && !preserveFollowViewport ? undefined : state.selectedOrdinal,
        detail: generationChanged ? undefined : state.detail,
        schema: generationChanged ? [] : state.schema,
        schemaTotal: generationChanged ? 0 : state.schemaTotal,
        schemaComplete: generationChanged ? false : state.schemaComplete,
        insights: generationChanged ? undefined : state.insights,
        pending: generationChanged ? {} : pending,
        invalidationReason: undefined,
        error: undefined,
      };
    }
    case 'ROWS': {
      if (state.invalidationReason !== undefined) return { ...state, pending };
      const selectedOrdinal = state.followMode
        ? message.payload.rows.at(-1)?.ref.ordinal
        : state.selectedOrdinal && message.payload.rows.some(
          (row) => row.ref.ordinal === state.selectedOrdinal,
        )
          ? state.selectedOrdinal
          : message.payload.rows[0]?.ref.ordinal;
      const sortOffset = message.payload.sortOffset === undefined
        ? state.sortOffset
        : normalizeSortOffset(message.payload.sortOffset);
      return {
        ...state,
        phase: state.summary?.indexingComplete === false ? 'loading' : 'ready',
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
        },
        selectedOrdinal,
        detail: state.detail?.ref.ordinal === selectedOrdinal ? state.detail : undefined,
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
    case 'DETAIL':
      if (state.invalidationReason !== undefined) return { ...state, pending };
      return {
        ...state,
        detail: message.payload,
        selectedOrdinal: message.payload.ref.ordinal,
        pending,
        error: undefined,
      };
    case 'PROBLEMS':
      if (state.invalidationReason !== undefined) return { ...state, pending };
      return {
        ...state,
        problems: message.payload,
        pending,
        error: undefined,
      };
    case 'SCHEMA':
      if (state.invalidationReason !== undefined) return { ...state, pending };
      return {
        ...state,
        schema: message.payload.fields,
        schemaTotal: message.payload.totalFields,
        schemaComplete: message.payload.complete,
        pending,
        error: undefined,
      };
    case 'INSIGHTS':
      if (state.invalidationReason !== undefined) return { ...state, pending };
      return {
        ...state,
        insights: message.payload,
        insightDimension: message.payload.dimension,
        pending,
        error: undefined,
      };
    case 'INDEX_PROGRESS':
      if (state.invalidationReason !== undefined) return { ...state, pending };
      return {
        ...state,
        phase: message.payload.indexingComplete ? 'ready' : 'loading',
        summary: message.payload,
        pending,
      };
    case 'PROFILE_CHANGED': {
      if (state.invalidationReason !== undefined) return { ...state, pending };
      const profileQuery = reconcileProfileQueryState(
        state.sort,
        state.filter,
        state.columns,
        message.payload.columns,
      );
      return {
        ...state,
        columns: message.payload.columns,
        columnVisibility: reconcileVisibility(message.payload.columns, state.columnVisibility),
        columnOrder: reconcileColumnOrder(message.payload.columns, state.columnOrder),
        summary: state.summary ? { ...state.summary, profileId: message.payload.profileId } : state.summary,
        sort: profileQuery.sort,
        filter: profileQuery.filter,
        sortOffset: '0',
        sortOffsetHistory: [],
        sortPage: '1',
        pending,
        detail: undefined,
        insights: undefined,
      };
    }
    case 'SOURCE_INVALIDATED':
      return {
        ...state,
        phase: 'invalidated',
        invalidationReason: message.payload.reason,
        pending: {},
      };
    case 'ERROR':
      if (state.invalidationReason !== undefined) {
        return {
          ...state,
          phase: 'invalidated',
          error: message.payload,
          pending,
        };
      }
      return {
        ...state,
        phase: message.payload.recoverable ? 'degraded' : 'error',
        error: message.payload,
        pending,
      };
  }
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'REQUEST_SENT':
      return {
        ...state,
        phase: action.request.kind === 'ready' || action.request.kind === 'rebuild' ? 'loading' : state.phase,
        pending: {
          ...state.pending,
          [action.request.kind]: action.request,
        },
      };
    case 'REQUEST_FINISHED':
      return {
        ...state,
        pending: state.pending[action.kind]?.id === action.requestId
          ? { ...state.pending, [action.kind]: undefined }
          : state.pending,
      };
    case 'MESSAGE_RECEIVED':
      return receiveMessage(state, action.message);
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab };
    case 'SET_INSIGHT_DIMENSION':
      return { ...state, insightDimension: action.dimension, insights: undefined };
    case 'SET_DETAIL_TAB':
      return { ...state, detailTab: action.tab };
    case 'SET_DETAIL_WIDTH':
      return { ...state, detailWidth: action.width };
    case 'SET_QUERY':
      return { ...state, query: action.query, sortOffset: '0', sortOffsetHistory: [], sortPage: '1' };
    case 'SET_FILTER':
      return { ...state, filter: action.filter, sortOffset: '0', sortOffsetHistory: [], sortPage: '1' };
    case 'SET_SORT':
      return { ...state, sort: action.sort, sortOffset: '0', sortOffsetHistory: [], sortPage: '1' };
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
      return { ...state, followMode: action.enabled };
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
    case 'SELECT_ROW':
      return {
        ...state,
        selectedOrdinal: action.ordinal,
        detail: state.detail?.ref.ordinal === action.ordinal ? state.detail : undefined,
      };
    case 'CLOSE_DETAIL':
      return { ...state, detail: undefined };
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
    detailTab: state.detailTab,
    detailWidth: state.detailWidth,
    query: state.query,
    ...(state.filter === undefined ? {} : { filter: state.filter }),
    ...(state.sort === undefined ? {} : { sort: state.sort }),
    sortOffset: state.sortOffset,
    sortOffsetHistory: state.sortOffsetHistory,
    sortPage: state.sortPage,
    followMode: state.followMode,
    insightDimension: state.insightDimension,
    columnVisibility: state.columnVisibility,
    columnWidths: state.columnWidths,
    columnOrder: state.columnOrder,
  };
}
