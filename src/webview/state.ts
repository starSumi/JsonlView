import type {
  ColumnSpec,
  DocumentSummary,
  ExtensionMessage,
  FieldStats,
  InsightDimension,
  InsightSummary,
  ProblemRef,
  RecordDetail,
  RowPage,
  RowProjection,
} from '../shared/types';
import { DEFAULT_DETAIL_WIDTH } from './split-pane';

export type WorkspaceTab = 'table' | 'timeline' | 'schema' | 'problems' | 'insights';
export type DetailTab = 'tree' | 'raw' | 'derived' | 'bytes';
export type WorkspacePhase = 'booting' | 'loading' | 'ready' | 'invalidated' | 'degraded' | 'error';
export type RequestKind = 'ready' | 'rows' | 'detail' | 'schema' | 'insights' | 'profile' | 'follow' | 'rebuild';

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
  page?: Pick<RowPage, 'anchorOrdinal' | 'hasBefore' | 'hasAfter'> | undefined;
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
  followMode: boolean;
  columnVisibility: Record<string, boolean>;
  columnWidths: Record<string, number>;
  pending: Partial<Record<RequestKind, RequestState>>;
  invalidationReason?: 'append' | 'truncate' | 'replace' | 'delete' | 'unknown' | undefined;
  error?: WorkspaceError | undefined;
}

export interface PersistedWorkspaceState {
  activeTab?: WorkspaceTab;
  detailTab?: DetailTab;
  detailWidth?: number;
  query?: string;
  followMode?: boolean;
  insightDimension?: InsightDimension;
  columnVisibility?: Record<string, boolean>;
  columnWidths?: Record<string, number>;
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
  | { type: 'SET_FOLLOW_MODE'; enabled: boolean }
  | { type: 'SET_COLUMN_VISIBILITY'; columnId: string; visible: boolean }
  | { type: 'SET_COLUMN_WIDTH'; columnId: string; width?: number | undefined }
  | { type: 'SELECT_ROW'; ordinal?: string }
  | { type: 'CLOSE_DETAIL' }
  | { type: 'DISMISS_ERROR' };

export function createInitialState(restored?: PersistedWorkspaceState): WorkspaceState {
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
    followMode: restored?.followMode ?? false,
    columnVisibility: restored?.columnVisibility ?? {},
    columnWidths: restored?.columnWidths ?? {},
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

function receiveMessage(state: WorkspaceState, message: ExtensionMessage): WorkspaceState {
  const pending = completeRequest(state.pending, message.requestId);
  switch (message.type) {
    case 'OPENED': {
      const generationChanged = state.summary?.snapshot.generation !== message.payload.snapshot.generation;
      const preserveFollowViewport = generationChanged && state.followMode && state.rows.length > 0;
      return {
        ...state,
        phase: message.payload.indexingComplete ? 'ready' : 'loading',
        summary: message.payload,
        rows: generationChanged && !preserveFollowViewport ? [] : state.rows,
        columns: generationChanged && !preserveFollowViewport ? [] : state.columns,
        page: generationChanged && !preserveFollowViewport ? undefined : state.page,
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
      const selectedOrdinal = state.followMode
        ? message.payload.rows.at(-1)?.ref.ordinal
        : state.selectedOrdinal && message.payload.rows.some(
          (row) => row.ref.ordinal === state.selectedOrdinal,
        )
          ? state.selectedOrdinal
          : message.payload.rows[0]?.ref.ordinal;
      return {
        ...state,
        phase: state.summary?.indexingComplete === false ? 'loading' : 'ready',
        rows: message.payload.rows,
        columns: message.payload.columns,
        page: {
          anchorOrdinal: message.payload.anchorOrdinal,
          hasBefore: message.payload.hasBefore,
          hasAfter: message.payload.hasAfter,
        },
        selectedOrdinal,
        detail: state.detail?.ref.ordinal === selectedOrdinal ? state.detail : undefined,
        columnVisibility: reconcileVisibility(message.payload.columns, state.columnVisibility),
        pending,
        error: undefined,
      };
    }
    case 'DETAIL':
      return {
        ...state,
        detail: message.payload,
        selectedOrdinal: message.payload.ref.ordinal,
        pending,
        error: undefined,
      };
    case 'SCHEMA':
      return {
        ...state,
        schema: message.payload.fields,
        schemaTotal: message.payload.totalFields,
        schemaComplete: message.payload.complete,
        pending,
        error: undefined,
      };
    case 'INSIGHTS':
      return {
        ...state,
        insights: message.payload,
        insightDimension: message.payload.dimension,
        pending,
        error: undefined,
      };
    case 'INDEX_PROGRESS':
      return {
        ...state,
        phase: message.payload.indexingComplete ? 'ready' : 'loading',
        summary: message.payload,
        pending,
      };
    case 'PROFILE_CHANGED':
      return {
        ...state,
        columns: message.payload.columns,
        columnVisibility: reconcileVisibility(message.payload.columns, state.columnVisibility),
        summary: state.summary ? { ...state.summary, profileId: message.payload.profileId } : state.summary,
        pending,
        detail: undefined,
        insights: undefined,
      };
    case 'SOURCE_INVALIDATED':
      return {
        ...state,
        phase: 'invalidated',
        invalidationReason: message.payload.reason,
        pending,
      };
    case 'ERROR':
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
      return { ...state, query: action.query };
    case 'SET_FOLLOW_MODE':
      return { ...state, followMode: action.enabled };
    case 'SET_COLUMN_VISIBILITY':
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
    case 'SELECT_ROW':
      return {
        ...state,
        selectedOrdinal: action.ordinal,
        detail: state.detail?.ref.ordinal === action.ordinal ? state.detail : undefined,
      };
    case 'CLOSE_DETAIL':
      return { ...state, detail: undefined };
    case 'DISMISS_ERROR':
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
    followMode: state.followMode,
    insightDimension: state.insightDimension,
    columnVisibility: state.columnVisibility,
    columnWidths: state.columnWidths,
  };
}
