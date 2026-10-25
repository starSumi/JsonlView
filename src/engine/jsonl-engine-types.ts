import type {
  AgentRowProjection,
  ColumnSpec,
  JsonScalar,
  ParseState,
  Predicate,
  RecordRef,
  RowPage,
  RowProjectionPlan,
  RowScanBudget,
  RowSort,
} from '@shared/types';
import type { SegmentIndexDiagnostics } from './segment-index-types';

export interface JsonlEngineOptions {
  documentId?: string;
  generation?: string;
  epoch?: number;
  uri?: string;
  readChunkBytes?: number;
  segmentTargetBytes?: number;
  segmentTargetRecords?: number;
  exactCacheSegments?: number;
  maxQueuedOperations?: number;
  maxRecordBytes?: number;
  /** Maximum bytes an explicit detail request may hydrate for one record. */
  fullRecordMaxBytes?: number;
  pageHydrationMaxBytes?: number;
  previewBytes?: number;
  rowPreviewCharacters?: number;
  defaultColumnLimit?: number;
  schemaMaxFields?: number;
  schemaMaxDepth?: number;
  schemaMaxArrayEntries?: number;
  schemaMaxExamples?: number;
  newlineScanner?: NativeNewlineScannerSetting;
}

export type NativeNewlineScannerSetting = 'off' | 'auto' | 'on';

export interface JsonlOperationContext {
  generation?: string;
  signal?: AbortSignal;
}

export interface RowEnricher {
  readonly profileId: string;
  readonly columns?: readonly ColumnSpec[];
  project(value: unknown, ref: RecordRef): AgentRowProjection | undefined;
  predicateFields?(
    projection: AgentRowProjection | undefined,
    value: unknown,
    ref: RecordRef,
  ): Readonly<Record<string, JsonScalar | undefined>>;
}

export type JsonlEngineQueueOperation =
  | 'none'
  | 'index_more'
  | 'finish_indexing'
  | 'get_rows'
  | 'inspect_rows'
  | 'get_problems'
  | 'get_detail'
  | 'get_schema'
  | 'classify_refresh';

export interface JsonlQueryTiming {
  readonly queueWaitMs: number;
  readonly engineExecMs: number;
  readonly queueBlockedBy: JsonlEngineQueueOperation;
  readonly indexWorkMs: number;
  readonly readWaitMs: number;
  readonly parseMs: number;
  readonly projectionMs: number;
  readonly snapshotCheckMs: number;
}

export interface GetRowsOptions extends JsonlOperationContext {
  anchorOrdinal?: string | bigint;
  direction?: 'forward' | 'backward';
  limit?: number;
  predicate?: Predicate;
  sort?: RowSort;
  /** Zero-based logical offset used only when sort is present. */
  sortOffset?: string | bigint;
  columns?: ColumnSpec[];
  /** Omitted by legacy callers to retain the historical full scene projection. */
  projection?: RowProjectionPlan;
  enricher?: RowEnricher;
  /** Receives each hydrated record without retaining it in the returned page. */
  onHydrated?: (record: { value?: unknown; ref: RecordRef; parseState: ParseState }) => void;
  scanBudget?: RowScanBudget;
  /** Optional caller-owned returned-byte cap; never exceeds the engine hydration cap. */
  maxReturnedBytes?: string | bigint;
  /** In-process metadata only; never included in a returned row or transport message. */
  onTiming?: (timing: JsonlQueryTiming) => void;
}

export type InspectRowsOptions = Pick<GetRowsOptions,
  'anchorOrdinal' | 'direction' | 'generation' | 'limit' | 'onHydrated' | 'scanBudget' | 'signal'>;

export type RowInspectionPage = Omit<RowPage, 'rows' | 'columns' | 'projection'>;

export interface GetProblemsOptions extends JsonlOperationContext {
  anchorOrdinal?: string | bigint;
  direction?: 'forward' | 'backward';
  limit?: number;
  scanBudget?: RowScanBudget;
}

export interface GetDetailOptions extends JsonlOperationContext {
  enricher?: RowEnricher;
  /** Requests complete record hydration within the explicit detail budget. */
  full?: boolean;
}

export interface IndexMoreOptions extends JsonlOperationContext {
  maxBytes?: number;
}

export interface BackgroundIndexHandle {
  readonly done: Promise<void>;
  cancel(): void;
}

export type SourceRefreshKind = 'unchanged' | 'append' | 'truncate' | 'replace' | 'delete' | 'unknown';

export interface SourceRefreshResult {
  kind: SourceRefreshKind;
  previousSizeBytes: string;
  currentSizeBytes?: string;
  observedAt: string;
}

export interface EngineDiagnostics extends SegmentIndexDiagnostics {
  open: boolean;
  observedSchemaRecords: string;
}
