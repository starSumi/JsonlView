import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { summarizeDatasetRecord } from '@profiles/dataset-analysis';
import { isBfclV3Candidate, summarizeBfclV3Record } from '@profiles/datasets/bfcl-v3';
import { summarizeOpenTelemetryRecord } from '@shared/otel-insights';
import { pathToFileURL } from 'node:url';
import { projectConversation } from '@profiles/conversation-projection';
import type {
  AgentRowProjection,
  CellProjection,
  ColumnSpec,
  DocumentSummary,
  FieldStats,
  JsonScalar,
  ParseState,
  Predicate,
  ProblemRef,
  ProblemPage,
  RecordDetail,
  RecordRef,
  RowPage,
  RowProjection,
  RowProjectionPlan,
  RowScanBudget,
  RowSort,
  ScanTruncationReason,
  SnapshotIdentity,
} from '@shared/types';
import { resolveRowProjectionPlan } from '@shared/row-projection';
import { MAX_TABLE_COLUMNS } from '@shared/types';
import { MAX_SOURCE_FILE_BYTES } from '@shared/source-limits';
import { JsonlEngineError, isAbortError } from './errors';
import { assertSourceObservation, observedReadAllowance, observedRowQueryGuard, validateSourceObservation } from './source-observation';
import { ForwardPageReadWindow } from './forward-page-read-window';
import { createNewlineScanner } from './newline-scanner';
import { evaluatePredicate, jsonKindOf, resolveFieldPath } from './predicate';
import {
  insertSortCandidate,
  isOrdinalSort,
  normalizeRowSort,
  sortColumnFromId,
  sortValueForColumn,
} from './row-sort';
import { ProgressiveSchemaTracker } from './schema';
import { QueryTimingAccumulator, createReadWaitObserver, withAsyncTrace, withTrace, type QueryTimingContext } from './query-timing';
import {
  AdaptiveSegmentIndex,
  type InternalRecordRef,
} from './segment-index';
import type {
  BackgroundIndexHandle,
  EngineDiagnostics,
  GetDetailOptions,
  GetProblemsOptions,
  GetRowsOptions,
  IndexMoreOptions,
  InspectRowsOptions,
  JsonlEngineOptions,
  JsonlEngineQueueOperation,
  JsonlOperationContext,
  NativeNewlineScannerSetting,
  RowEnricher,
  RowInspectionPage,
  SourceRefreshResult,
} from './jsonl-engine-types';
export type {
  BackgroundIndexHandle,
  EngineDiagnostics,
  GetDetailOptions,
  GetProblemsOptions,
  GetRowsOptions,
  IndexMoreOptions,
  InspectRowsOptions,
  JsonlEngineOptions,
  JsonlEngineQueueOperation,
  JsonlOperationContext,
  JsonlQueryTiming,
  NativeNewlineScannerSetting,
  RowEnricher,
  RowInspectionPage,
  SourceRefreshKind,
  SourceRefreshResult,
} from './jsonl-engine-types';
import {
  fingerprintRange,
  fingerprintStableRange,
  fingerprintWholeRange,
  assertBoundaryFingerprints,
  formatFingerprint,
  type FullSourceFingerprint,
  type ReadWaitObserver,
  type SourceFingerprint,
  readFileHandle,
} from './snapshot-fingerprint';

const DEFAULT_FINGERPRINT_BYTES = 64 * 1024;
// Small documents can establish an exact baseline during open. Larger files
// build it in the background so the first page is not gated by a second full
// read; a write that overlaps that deferred read is reported as unknown.
const INLINE_FULL_FINGERPRINT_BYTES = 8n * 1024n * 1024n;
// Sorting is intentionally a bounded operation until a durable external-sort
// projection is introduced. The limits keep an accidental click on a huge log
// from turning the extension host into an unbounded memory/CPU job.
const DEFAULT_SORT_MAX_EXAMINED_RECORDS = 100_000;
const DEFAULT_SORT_MAX_EXAMINED_BYTES = 64 * 1024 * 1024;
const DEFAULT_SORT_MAX_MILLISECONDS = 5_000;
const HARD_SORT_MAX_EXAMINED_RECORDS = 1_000_000;
const HARD_SORT_MAX_EXAMINED_BYTES = 512 * 1024 * 1024;
const HARD_SORT_MAX_MILLISECONDS = 60_000;
const MAX_SORT_WINDOW = 2_048;
const FORWARD_PAGE_READ_WINDOW_BYTES = 16 * 1024;
const FORWARD_PAGE_READ_WINDOW_MIN_LIMIT = 100;
const BACKGROUND_PROGRESS_THROTTLE_MS = 100;
// Problems are an independent bounded scan. They are not folded into the
// row page or DocumentSummary, so an explicit request can disclose progress
// without retaining the complete source or a global problem array in the UI.
const DEFAULT_PROBLEM_MAX_EXAMINED_RECORDS = 100_000;
const DEFAULT_PROBLEM_MAX_EXAMINED_BYTES = 64 * 1024 * 1024;
const DEFAULT_PROBLEM_MAX_MILLISECONDS = 5_000;
const HARD_PROBLEM_MAX_EXAMINED_RECORDS = 1_000_000;
const HARD_PROBLEM_MAX_EXAMINED_BYTES = 512 * 1024 * 1024;
const HARD_PROBLEM_MAX_MILLISECONDS = 60_000;

interface NormalizedOptions {
  readChunkBytes: number;
  segmentTargetBytes: number;
  segmentTargetRecords: number;
  exactCacheSegments: number;
  maxQueuedOperations: number;
  maxRecordBytes: number;
  fullRecordMaxBytes: number;
  pageHydrationMaxBytes: number;
  previewBytes: number;
  rowPreviewCharacters: number;
  defaultColumnLimit: number;
  schemaMaxFields: number;
  schemaMaxDepth: number;
  schemaMaxArrayEntries: number;
  schemaMaxExamples: number;
  newlineScanner: NativeNewlineScannerSetting;
}

interface NormalizedRowScanBudget {
  maxExaminedRecords?: bigint;
  maxExaminedBytes?: bigint;
  deadlineEpochMs?: number;
}

interface HydratedRecord {
  internal: InternalRecordRef;
  ref: RecordRef;
  state: ParseState;
  rawPreview: string;
  rawComplete: boolean;
  value?: unknown;
  problems: ProblemRef[];
}

interface SortCandidate {
  internal: InternalRecordRef;
  key: unknown;
}

interface SerialExecutorTask {
  name: JsonlEngineQueueOperation;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  blockedBy: JsonlEngineQueueOperation;
  enqueuedAt: number | undefined;
  onTiming: ((queueWaitMs: number, engineExecMs: number, blockedBy: JsonlEngineQueueOperation) => void) | undefined;
}

type QueuePriority = 'interactive' | 'background';

class SerialExecutor {
  private pending = 0;
  private activeOperation: JsonlEngineQueueOperation | undefined;
  private readonly interactiveQueue: SerialExecutorTask[] = [];
  private readonly backgroundQueue: SerialExecutorTask[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private readonly maximumPending: number;

  constructor(maximumPending: number) {
    this.maximumPending = maximumPending;
  }

  run<T>(
    name: JsonlEngineQueueOperation,
    operation: () => Promise<T>,
    onTiming?: (queueWaitMs: number, engineExecMs: number, blockedBy: JsonlEngineQueueOperation) => void,
    priority: QueuePriority = name === 'index_more' ? 'background' : 'interactive',
  ): Promise<T> {
    if (this.pending >= this.maximumPending) {
      return Promise.reject(new JsonlEngineError(
        'QUEUE_FULL',
        `The JSONL engine already has ${String(this.pending)} pending operations.`,
      ));
    }
    const isBackground = priority === 'background';
    const blockedBy = isBackground
      ? this.backgroundQueue.at(-1)?.name
        ?? this.interactiveQueue.at(-1)?.name
        ?? this.activeOperation
        ?? 'none'
      : this.interactiveQueue.at(-1)?.name ?? this.activeOperation ?? 'none';
    const enqueuedAt = onTiming === undefined ? undefined : performance.now();
    this.pending += 1;

    return new Promise<T>((resolve, reject) => {
      const task: SerialExecutorTask = {
        name,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        blockedBy,
        enqueuedAt,
        onTiming,
      };
      (isBackground ? this.backgroundQueue : this.interactiveQueue).push(task);
      this.dispatch();
    });
  }

  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private dispatch(): void {
    if (this.activeOperation !== undefined) return;
    const task = this.interactiveQueue.shift() ?? this.backgroundQueue.shift();
    if (task === undefined) return;

    this.activeOperation = task.name;
    const startedAt = task.onTiming === undefined ? undefined : performance.now();
    const queueWaitMs = task.enqueuedAt === undefined || startedAt === undefined
      ? undefined
      : startedAt - task.enqueuedAt;
    let result: Promise<unknown>;
    try {
      result = task.operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(
      (value) => this.complete(task, startedAt, queueWaitMs, () => task.resolve(value)),
      (error: unknown) => this.complete(task, startedAt, queueWaitMs, () => task.reject(error)),
    );
  }

  private complete(
    task: SerialExecutorTask,
    startedAt: number | undefined,
    queueWaitMs: number | undefined,
    settle: () => void,
  ): void {
    this.activeOperation = undefined;
    try {
      if (queueWaitMs !== undefined && startedAt !== undefined) {
        try {
          const engineExecMs = performance.now() - startedAt;
          task.onTiming?.(queueWaitMs, engineExecMs, task.blockedBy);
        } catch {
          // A diagnostic callback must never change the operation result.
        }
      }
    } finally {
      settle();
      this.pending -= 1;
      if (this.pending === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
      this.dispatch();
    }
  }
}

/**
 * Read-only, snapshot-bound JSONL engine. The source file is never written and
 * no API returns the complete source. Anchors are exclusive physical cursors.
 */
export class JsonlFileEngine {
  readonly filePath: string;
  readonly snapshot: SnapshotIdentity;
  private readonly handle: FileHandle;
  private readonly fileSize: bigint;
  private readonly options: NormalizedOptions;
  private readonly sourceDevice: bigint;
  private readonly sourceInode: bigint;
  private readonly sourceMtimeMs: number;
  private readonly sourceMtimeNs: bigint;
  private readonly sourceCtimeNs: bigint;
  private readonly prefixFingerprint: SourceFingerprint;
  private readonly tailFingerprint: SourceFingerprint;
  private fullFingerprint: Promise<FullSourceFingerprint | undefined> | undefined;
  private fullFingerprintKnown: boolean;
  private readonly fingerprintAbort: AbortController;

  private readonly executor: SerialExecutor;
  private readonly lifecycleAbort = new AbortController();
  private readonly backgroundControllers = new Set<AbortController>();
  private readonly index: AdaptiveSegmentIndex;
  private readonly schema: ProgressiveSchemaTracker;
  private closing = false;
  private closed = false;
  private invalidated = false;
  private readonly problemCache = new Map<bigint, readonly ProblemRef[]>();

  private constructor(
    filePath: string,
    handle: FileHandle,
    fileSize: bigint,
    snapshot: SnapshotIdentity,
    options: NormalizedOptions,
    sourceDevice: bigint,
    sourceInode: bigint,
    sourceMtimeMs: number,
    sourceMtimeNs: bigint,
    sourceCtimeNs: bigint,
    prefixFingerprint: SourceFingerprint,
    tailFingerprint: SourceFingerprint,
    fullFingerprint: Promise<FullSourceFingerprint | undefined> | undefined,
    fullFingerprintKnown: boolean,
    fingerprintAbort: AbortController,
  ) {
    this.filePath = filePath;
    this.snapshot = snapshot;
    this.handle = handle;
    this.fileSize = fileSize;
    this.options = options;
    this.sourceDevice = sourceDevice;
    this.sourceInode = sourceInode;
    this.sourceMtimeMs = sourceMtimeMs;
    this.sourceMtimeNs = sourceMtimeNs;
    this.sourceCtimeNs = sourceCtimeNs;
    this.prefixFingerprint = prefixFingerprint;
    this.tailFingerprint = tailFingerprint;
    this.fullFingerprint = fullFingerprint;
    this.fullFingerprintKnown = fullFingerprintKnown;
    this.fingerprintAbort = fingerprintAbort;
    this.executor = new SerialExecutor(options.maxQueuedOperations);
    this.index = new AdaptiveSegmentIndex(handle, fileSize, {
      readChunkBytes: options.readChunkBytes,
      segmentTargetBytes: options.segmentTargetBytes,
      segmentTargetRecords: options.segmentTargetRecords,
      exactCacheSegments: options.exactCacheSegments,
      maxRecordBytes: options.maxRecordBytes,
      newlineScanner: createNewlineScanner({ mode: scannerMode(options.newlineScanner) }),
      validateSnapshot: () => this.assertSnapshotMetadataUnchanged(),
    });
    this.schema = new ProgressiveSchemaTracker({
      maxFields: options.schemaMaxFields,
      maxDepth: options.schemaMaxDepth,
      maxArrayEntries: options.schemaMaxArrayEntries,
      maxExamples: options.schemaMaxExamples,
      exampleCharacters: options.rowPreviewCharacters,
    });
  }

  static async open(filePath: string, options: JsonlEngineOptions = {}): Promise<JsonlFileEngine> {
    const normalized = normalizeOptions(options);
    const absolutePath = resolve(filePath);
    const handle = await open(absolutePath, 'r');
    const fingerprintAbort = new AbortController();
    try {
      const sourceStat = await handle.stat({ bigint: true });
      if (!sourceStat.isFile()) {
        throw new JsonlEngineError('NOT_A_FILE', `JSONL source is not a regular file: ${absolutePath}`);
      }
      if (sourceStat.size > MAX_SOURCE_FILE_BYTES) {
        throw new JsonlEngineError(
          'SOURCE_TOO_LARGE',
          `JSONL source exceeds the ${String(MAX_SOURCE_FILE_BYTES / (1024n * 1024n * 1024n))} GiB hard limit: ${absolutePath}`,
        );
      }

      const prefixLength = Number(sourceStat.size < BigInt(DEFAULT_FINGERPRINT_BYTES)
        ? sourceStat.size
        : BigInt(DEFAULT_FINGERPRINT_BYTES));
      const tailLength = prefixLength;
      const prefixFingerprint = await fingerprintRange(handle, 0n, prefixLength);
      const tailFingerprint = await fingerprintRange(handle, sourceStat.size - BigInt(tailLength), tailLength);
      // Small files establish a baseline on the open path. Large logs defer
      // the O(n) digest until a refresh or snapshot guard needs an exact
      // append decision, keeping first-page work bounded.
      let fullFingerprint: Promise<FullSourceFingerprint | undefined> | undefined;
      let fullFingerprintKnown = false;
      if (sourceStat.size <= INLINE_FULL_FINGERPRINT_BYTES) {
        const baseline = await fingerprintStableRange(
          handle,
          sourceStat.size,
          sourceStat.mtimeNs,
          sourceStat.ctimeNs,
          fingerprintAbort.signal,
        );
        fullFingerprint = Promise.resolve(baseline);
        fullFingerprintKnown = baseline !== undefined;
      }
      const generation = options.generation ?? randomUUID();
      const documentId = options.documentId ?? randomUUID();
      const mtimeMs = Number(sourceStat.mtimeMs);
      const snapshot: SnapshotIdentity = {
        documentId,
        generation,
        ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
        uri: options.uri ?? pathToFileURL(absolutePath).toString(),
        scheme: options.uri === undefined ? 'file' : safeScheme(options.uri),
        sizeBytes: sourceStat.size.toString(),
        mtimeMs,
        prefixFingerprint: formatFingerprint(prefixFingerprint),
        observedAt: new Date().toISOString(),
      };
      if (sourceStat.dev !== 0n) snapshot.device = sourceStat.dev.toString();
      if (sourceStat.ino !== 0n) snapshot.inode = sourceStat.ino.toString();

      return new JsonlFileEngine(
        absolutePath,
        handle,
        sourceStat.size,
        snapshot,
        normalized,
        sourceStat.dev,
        sourceStat.ino,
        mtimeMs,
        sourceStat.mtimeNs,
        sourceStat.ctimeNs,
        prefixFingerprint,
        tailFingerprint,
        fullFingerprint,
        fullFingerprintKnown,
        fingerprintAbort,
      );
    } catch (error) {
      fingerprintAbort.abort();
      await handle.close();
      throw error;
    }
  }

  getSummary(profileId = 'generic'): DocumentSummary {
    return {
      snapshot: { ...this.snapshot },
      profileId,
      profileSuggestions: [],
      indexedBytes: this.index.indexedBytes.toString(),
      indexedRecords: this.index.indexedRecords.toString(),
      indexingComplete: this.index.indexingComplete,
      validRecords: this.schema.validRecordCount.toString(),
      problemRecords: this.schema.problemRecordCount.toString(),
    };
  }

  getDiagnostics(): EngineDiagnostics {
    return {
      ...this.index.diagnostics(),
      open: !this.closed,
      observedSchemaRecords: this.schema.observedRecordCount.toString(),
    };
  }

  indexMore(options: IndexMoreOptions = {}): Promise<DocumentSummary> {
    return this.enqueue('index_more', async () => {
      const guard = this.makeGuard(options);
      guard();
      await this.assertSnapshotUnchanged(guard);
      await this.index.indexMore(options.maxBytes ?? this.options.readChunkBytes, guard);
      await this.assertSnapshotUnchanged(guard);
      return this.getSummary();
    });
  }

  finishIndexing(context: JsonlOperationContext = {}): Promise<DocumentSummary> {
    return this.enqueue('finish_indexing', async () => {
      const guard = this.makeGuard(context);
      guard();
      await this.assertSnapshotUnchanged(guard);
      await this.index.finish(guard);
      await this.assertSnapshotUnchanged(guard);
      return this.getSummary();
    });
  }

  startBackgroundIndexing(
    onProgress?: (summary: DocumentSummary) => void,
    context: JsonlOperationContext = {},
  ): BackgroundIndexHandle {
    this.assertAccepting();
    const controller = new AbortController();
    this.backgroundControllers.add(controller);
    const forwardAbort = (): void => controller.abort();
    context.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (context.signal?.aborted === true) controller.abort();
    let settled = false;
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveDone = resolvePromise;
      rejectDone = rejectPromise;
    });
    let lastProgressReportedAt: number | undefined;

    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      this.backgroundControllers.delete(controller);
      context.signal?.removeEventListener('abort', forwardAbort);
      if (error === undefined || controller.signal.aborted || isAbortError(error)) resolveDone();
      else rejectDone(error);
    };

    const step = (): void => {
      if (controller.signal.aborted || this.closing || this.closed) {
        settle();
        return;
      }
      void this.indexMore({
        maxBytes: this.options.readChunkBytes,
        ...(context.generation === undefined ? {} : { generation: context.generation }),
        signal: controller.signal,
      }).then((summary) => {
        if (onProgress !== undefined) {
          const now = performance.now();
          if (
            summary.indexingComplete
            || lastProgressReportedAt === undefined
            || now - lastProgressReportedAt >= BACKGROUND_PROGRESS_THROTTLE_MS
          ) {
            lastProgressReportedAt = now;
            try {
              onProgress(summary);
            } catch {
              // Progress observers cannot interrupt indexing.
            }
          }
        }
        if (summary.indexingComplete) settle();
        else setImmediate(step);
      }).catch(settle);
    };
    setImmediate(step);

    return {
      done,
      cancel: () => {
        controller.abort();
      },
    };
  }

  getRows(options: GetRowsOptions = {}): Promise<RowPage> {
    return this.queryRows(options, true, 'get_rows');
  }

  /** Opportunistic page work yields to queued interactive operations at dispatch. */
  getBackgroundRows(options: GetRowsOptions = {}): Promise<RowPage> {
    return this.queryRows(options, true, 'get_rows', 'background');
  }

  /**
   * Opt-in physical forward pages with stat-only source checks before/after.
   * Requires an absolute deadline and a positive maxExaminedBytes, also used as
   * the total content-read request allowance across indexing and hydration.
   * Metadata changes reject SOURCE_CHANGED; exhausted reads reject
   * READ_BUDGET_EXCEEDED. Neither check starts a source fingerprint.
   */
  getObservedBackgroundRows(options: GetRowsOptions): Promise<RowPage> {
    return this.queryRows(options, true, 'get_rows', 'background', true);
  }
  inspectRows(options: InspectRowsOptions = {}): Promise<RowInspectionPage> {
    return this.queryRows(options, false, 'inspect_rows').then(({ rows: _rows, columns: _columns, projection: _projection, ...page }) => page);
  }

  /** Profile probes retain inspection semantics while using the background FIFO. */
  inspectBackgroundRows(options: InspectRowsOptions = {}): Promise<RowInspectionPage> {
    return this.queryRows(options, false, 'inspect_rows', 'background').then(({ rows: _rows, columns: _columns, projection: _projection, ...page }) => page);
  }

  private queryRows(
    options: GetRowsOptions,
    materializeRows: boolean,
    operationName: 'get_rows' | 'inspect_rows',
    priority: QueuePriority = 'interactive',
    observedSourceOnly = false,
  ): Promise<RowPage> {
    const timing = options.onTiming === undefined ? undefined : new QueryTimingAccumulator();
    let onReadWait = createReadWaitObserver(timing);
    return this.enqueue(operationName, async () => {
      const guard = observedSourceOnly ? observedRowQueryGuard(options, this.makeGuard(options)) : this.makeGuard(options);
      if (observedSourceOnly) onReadWait = observedReadAllowance(options, guard, onReadWait);
      const checkSnapshot = () => observedSourceOnly
        ? assertSourceObservation(() => this.validateObservedSource(options), guard)
        : this.assertSnapshotUnchanged(guard, onReadWait);
      guard();
      await withAsyncTrace(timing, 'snapshotCheckMs', checkSnapshot);
      const limit = boundedInteger(options.limit ?? 100, 1, 500, 'limit');
      const direction = options.direction ?? 'forward';
      const scanBudget = normalizeRowScanBudget(options.scanBudget, direction);
      const returnedByteLimit = normalizeReturnedByteLimit(options.maxReturnedBytes, this.options.pageHydrationMaxBytes);
      const sort = normalizeRowSort(options.sort);
      const projection = resolveRowProjectionPlan(options.projection, options.enricher?.profileId);
      const readWindow = direction === 'forward'
        && limit >= FORWARD_PAGE_READ_WINDOW_MIN_LIMIT
        && this.options.readChunkBytes >= FORWARD_PAGE_READ_WINDOW_BYTES
        && options.sort === undefined
        && options.predicate === undefined
        && options.enricher === undefined
        && options.onHydrated === undefined
        && options.scanBudget === undefined
        && scanBudget === undefined
        ? new ForwardPageReadWindow(
          this.handle,
          this.fileSize,
          FORWARD_PAGE_READ_WINDOW_BYTES,
        )
        : undefined;
      const physicalCursor = options.anchorOrdinal !== undefined || options.direction !== undefined;
      if (sort !== undefined) {
        if (physicalCursor && (!isOrdinalSort(sort) || options.sortOffset !== undefined)) {
          throw new JsonlEngineError(
            'INVALID_ARGUMENT',
            'Physical cursors require ordinal order and cannot include a sorted offset.',
          );
        }
        if (isOrdinalSort(sort) && !physicalCursor) {
          return this.getOrdinalSortedRows(options, guard, limit, sort, materializeRows, projection, timing, onReadWait);
        }
        if (!isOrdinalSort(sort)) {
          return this.getSortedRows(options, guard, limit, sort, materializeRows, projection, timing, onReadWait);
        }
      }
      const anchor = options.anchorOrdinal === undefined
        ? undefined
        : parseNonNegativeBigInt(options.anchorOrdinal, 'anchorOrdinal');
      const collected: Array<{ hydrated: HydratedRecord; profile?: AgentRowProjection }> = [];
      let retainedBytes = 0n;
      let stoppedByBudget = false;
      let examinedRecords = 0n;
      let examinedBytes = 0n;
      let scanCursor: bigint | undefined;
      let scanTruncatedReason: ScanTruncationReason | undefined;
      let sawUninspectableRecord = false;

      if (direction === 'forward') {
        let ordinal = anchor === undefined ? 0n : anchor + 1n;
        // Always probe one record beyond the requested page. With a bounded
        // scan this is what distinguishes an exact page at EOF from a page
        // that has more matches behind the scan budget.
        const collectionTarget = limit + 1;
        while (collected.length < collectionTarget) {
          guard();
          // A deadline is a hard stop and should not trigger another index
          // read. Record/byte limits are checked after probing the next ref so
          // an exact budget at EOF is not reported as a false truncation.
          if (scanBudget?.deadlineEpochMs !== undefined && Date.now() >= scanBudget.deadlineEpochMs) {
            scanTruncatedReason = 'time_limit';
            break;
          }
          const internal = await withAsyncTrace(timing, 'indexWorkMs', () =>
            this.index.getRecord(ordinal, guard, onReadWait));
          if (internal === undefined) break;
          scanTruncatedReason = scanLimitBeforeNextRecord(
            scanBudget,
            examinedRecords,
            examinedBytes,
          );
          if (scanTruncatedReason !== undefined) break;
          if (
            scanBudget?.maxExaminedBytes !== undefined
            && examinedBytes + internal.contentByteLength > scanBudget.maxExaminedBytes
          ) {
            scanTruncatedReason = 'byte_limit';
            break;
          }
          if (
            collected.length > 0
            && retainedBytes + internal.contentByteLength > returnedByteLimit
          ) {
            // Leave the boundary record unconsumed. The next continuation can
            // present it without sampling a record excluded by this page cap.
            stoppedByBudget = true;
            scanTruncatedReason = 'hydration_limit';
            break;
          }
          const candidate = await this.hydrate(internal, guard, false, readWindow, timing, onReadWait);
          options.onHydrated?.({ value: candidate.value, ref: candidate.ref, parseState: candidate.state });
          guard();
          if (options.predicate !== undefined && candidate.value === undefined) {
            sawUninspectableRecord = true;
          }
          const profile = candidate.value === undefined
            ? undefined
            : withTrace(timing, 'projectionMs', () => options.enricher?.project(candidate.value, candidate.ref));
          const matches = withTrace(timing, 'projectionMs', () =>
            this.matches(candidate, options.predicate, options.enricher, profile));
          if (matches) {
            collected.push(profile === undefined ? { hydrated: candidate } : { hydrated: candidate, profile });
            retainedBytes += candidate.internal.contentByteLength;
          }
          examinedRecords += 1n;
          examinedBytes += internal.contentByteLength;
          scanCursor = ordinal;
          ordinal += 1n;
        }
      } else {
        let ordinal: bigint;
        if (anchor === undefined) {
          await withAsyncTrace(timing, 'indexWorkMs', () => this.index.finish(guard, onReadWait));
          ordinal = this.index.indexedRecords - 1n;
        } else if (await withAsyncTrace(timing, 'indexWorkMs', () => this.index.ensureOrdinal(anchor, guard, onReadWait))) {
          ordinal = anchor - 1n;
        } else {
          ordinal = this.index.indexedRecords - 1n;
        }

        while (ordinal >= 0n && collected.length <= limit) {
          guard();
          if (scanBudget?.deadlineEpochMs !== undefined && Date.now() >= scanBudget.deadlineEpochMs) {
            scanTruncatedReason = 'time_limit';
            break;
          }
          const internal = await withAsyncTrace(timing, 'indexWorkMs', () =>
            this.index.getRecord(ordinal, guard, onReadWait));
          if (internal === undefined) break;
          scanTruncatedReason = scanLimitBeforeNextRecord(
            scanBudget,
            examinedRecords,
            examinedBytes,
          );
          if (scanTruncatedReason !== undefined) break;
          if (
            scanBudget?.maxExaminedBytes !== undefined
            && examinedBytes + internal.contentByteLength > scanBudget.maxExaminedBytes
          ) {
            scanTruncatedReason = 'byte_limit';
            break;
          }
          if (
            collected.length > 0
            && retainedBytes + internal.contentByteLength > returnedByteLimit
          ) {
            // Leave the boundary record unconsumed so the next backward page
            // can present it without sampling excluded data.
            stoppedByBudget = true;
            scanTruncatedReason = 'hydration_limit';
            break;
          }
          const candidate = await this.hydrate(internal, guard, false, undefined, timing, onReadWait);
          options.onHydrated?.({ value: candidate.value, ref: candidate.ref, parseState: candidate.state });
          guard();
          if (options.predicate !== undefined && candidate.value === undefined) {
            sawUninspectableRecord = true;
          }
          const profile = candidate.value === undefined
            ? undefined
            : withTrace(timing, 'projectionMs', () => options.enricher?.project(candidate.value, candidate.ref));
          if (withTrace(timing, 'projectionMs', () =>
            this.matches(candidate, options.predicate, options.enricher, profile))) {
            collected.push(profile === undefined ? { hydrated: candidate } : { hydrated: candidate, profile });
            retainedBytes += candidate.internal.contentByteLength;
          }
          examinedRecords += 1n;
          examinedBytes += internal.contentByteLength;
          scanCursor = ordinal;
          ordinal -= 1n;
        }
      }

      const hasExtra = collected.length > limit
        || stoppedByBudget
        || scanTruncatedReason !== undefined
        || sawUninspectableRecord;
      if (scanTruncatedReason === undefined && sawUninspectableRecord) {
        scanTruncatedReason = 'uninspectable_record';
      }
      let selected = collected.slice(0, limit);
      if (direction === 'backward') selected = selected.reverse();
      const columns = materializeRows
        ? options.columns === undefined
          ? this.defaultColumns(options.enricher?.columns)
          : options.columns.slice(0, MAX_TABLE_COLUMNS)
        : [];
      const rows = materializeRows
        ? withTrace(timing, 'projectionMs', () => selected.map(({ hydrated, profile }) =>
          this.projectRow(hydrated, columns, profile, options.enricher?.profileId, projection)))
        : [];
      const firstOrdinal = selected[0]?.hydrated.internal.ordinal;
      const lastOrdinal = selected[selected.length - 1]?.hydrated.internal.ordinal;
      // When the bounded probe collected one extra matching row, keep the
      // continuation cursor at the visible page boundary. Returning the
      // last examined ordinal would skip that extra row on the next page.
      const continuationCursor = collected.length > limit && selected.length > 0
        ? (direction === 'forward' ? lastOrdinal : firstOrdinal)
        : scanCursor;
      const total = this.index.totalRecords;
      const cursorAdvanced = continuationCursor !== undefined && (anchor === undefined
        || (direction === 'forward' ? continuationCursor > anchor : continuationCursor < anchor));
      const hasPhysicalRemainder = continuationCursor !== undefined && (direction === 'forward'
        ? total === undefined || continuationCursor + 1n < total
        : continuationCursor > 0n);
      const canContinue = hasExtra && cursorAdvanced && hasPhysicalRemainder;
      const hasBefore = direction === 'backward'
        ? canContinue
        : firstOrdinal !== undefined ? firstOrdinal > 0n : anchor !== undefined && anchor > 0n;
      const hasAfter = direction === 'forward'
        ? canContinue
        : lastOrdinal !== undefined ? (total === undefined || lastOrdinal + 1n < total)
          : anchor !== undefined && (total === undefined || anchor + 1n < total);
      // The scan selects an adjacent physical window; the ordinal sort controls presentation.
      if (sort?.direction === 'desc') rows.reverse();

      await withAsyncTrace(timing, 'snapshotCheckMs', checkSnapshot);

      return {
        rows,
        columns,
        ...(options.projection === undefined ? {} : { projection }),
        anchorOrdinal: direction === 'forward'
          ? (lastOrdinal ?? anchor ?? 0n).toString()
          : (firstOrdinal ?? anchor ?? 0n).toString(),
        hasBefore: sort?.direction === 'desc' ? hasAfter : hasBefore,
        hasAfter: sort?.direction === 'desc' ? hasBefore : hasAfter,
        ...(sort === undefined ? {} : { sort }),
        indexedRecords: this.index.indexedRecords.toString(),
        ...(total === undefined ? {} : { totalRecords: total.toString() }),
        ...(sort === undefined && scanBudget === undefined && !stoppedByBudget && scanTruncatedReason === undefined ? {} : {
          scan: {
            examinedRecords: examinedRecords.toString(),
            examinedBytes: examinedBytes.toString(),
            ...(continuationCursor === undefined ? {} : { cursorOrdinal: continuationCursor.toString() }),
            ...(sort === undefined && scanTruncatedReason === undefined ? {} : { direction }),
            ...(scanTruncatedReason === undefined ? {} : { truncatedReason: scanTruncatedReason }),
          },
        }),
      };
    }, timing === undefined ? undefined : (queueWaitMs, engineExecMs, blockedBy) => {
      try {
        options.onTiming?.(timing.toTiming(queueWaitMs, engineExecMs, blockedBy));
      } catch {
        // Timing callbacks are observational and cannot change query results.
      }
    }, priority);
  }

  /**
   * Physical ordinal sorting is a cursor operation, not a field sort. It can
   * read the newest records from EOF without retaining a global candidate set.
   */
  private async getOrdinalSortedRows(
    options: GetRowsOptions,
    guard: () => void,
    limit: number,
    sort: RowSort,
    materializeRows: boolean,
    projection: RowProjectionPlan,
    timing: QueryTimingContext,
    onReadWait: ReadWaitObserver | undefined,
  ): Promise<RowPage> {
    const offset = parseNonNegativeBigInt(options.sortOffset ?? '0', 'sortOffset');
    const direction = sort.direction === 'desc' ? 'backward' : 'forward';
    const scanBudget = normalizeRowScanBudget(options.scanBudget, direction);
    const returnedByteLimit = normalizeReturnedByteLimit(options.maxReturnedBytes, this.options.pageHydrationMaxBytes);
    await withAsyncTrace(timing, 'indexWorkMs', () => this.index.finish(guard, onReadWait));
    const total = this.index.totalRecords ?? this.index.indexedRecords;
    const selected: Array<{ hydrated: HydratedRecord; profile?: AgentRowProjection }> = [];
    let retainedBytes = 0n;
    let examinedRecords = 0n;
    let examinedBytes = 0n;
    let matchedRecords = 0n;
    let scanCursor: bigint | undefined;
    let truncatedReason: ScanTruncationReason | undefined;
    let sawUninspectableRecord = false;
    let hydrationTruncated = false;

    if (options.predicate === undefined) {
      // With no predicate, logical offset maps directly to a physical ordinal.
      const first = direction === 'forward' ? offset : total - 1n - offset;
      for (let index = 0; index < limit; index += 1) {
        const ordinal = direction === 'forward' ? first + BigInt(index) : first - BigInt(index);
        if (ordinal < 0n || ordinal >= total) break;
        guard();
        const internal = await withAsyncTrace(timing, 'indexWorkMs', () => this.index.getRecord(ordinal, guard, onReadWait));
        if (internal === undefined) break;
        if (
          selected.length > 0
          && retainedBytes + internal.contentByteLength > returnedByteLimit
        ) {
          hydrationTruncated = true;
          truncatedReason = 'hydration_limit';
          break;
        }
        const hydrated = await this.hydrate(internal, guard, false, undefined, timing, onReadWait);
        options.onHydrated?.({ value: hydrated.value, ref: hydrated.ref, parseState: hydrated.state });
        const profile = hydrated.value === undefined
          ? undefined
          : withTrace(timing, 'projectionMs', () => options.enricher?.project(hydrated.value, hydrated.ref));
        selected.push(profile === undefined ? { hydrated } : { hydrated, profile });
        retainedBytes += internal.contentByteLength;
        examinedRecords += 1n;
        examinedBytes += internal.contentByteLength;
        scanCursor = ordinal;
      }
      matchedRecords = total;
    } else {
      let ordinal = direction === 'forward' ? 0n : total - 1n;
      const targetEnd = offset + BigInt(limit);
      while (ordinal >= 0n && ordinal < total) {
        guard();
        truncatedReason = scanLimitBeforeNextRecord(scanBudget, examinedRecords, examinedBytes);
        if (truncatedReason !== undefined) break;
        const internal = await withAsyncTrace(timing, 'indexWorkMs', () => this.index.getRecord(ordinal, guard, onReadWait));
        if (internal === undefined) break;
        if (
          scanBudget?.maxExaminedBytes !== undefined
          && examinedBytes + internal.contentByteLength > scanBudget.maxExaminedBytes
        ) {
          truncatedReason = 'byte_limit';
          break;
        }
        const hydrated = await this.hydrate(internal, guard, false, undefined, timing, onReadWait);
        options.onHydrated?.({ value: hydrated.value, ref: hydrated.ref, parseState: hydrated.state });
        if (hydrated.value === undefined) sawUninspectableRecord = true;
        const profile = hydrated.value === undefined
          ? undefined
          : withTrace(timing, 'projectionMs', () => options.enricher?.project(hydrated.value, hydrated.ref));
        if (withTrace(timing, 'projectionMs', () =>
          this.matches(hydrated, options.predicate, options.enricher, profile))) {
          matchedRecords += 1n;
          if (matchedRecords > offset && selected.length < limit) {
            if (
              selected.length > 0
              && retainedBytes + internal.contentByteLength > returnedByteLimit
            ) {
              hydrationTruncated = true;
              truncatedReason = 'hydration_limit';
              break;
            }
            selected.push(profile === undefined ? { hydrated } : { hydrated, profile });
            retainedBytes += internal.contentByteLength;
          }
          if (matchedRecords >= targetEnd + 1n) {
            scanCursor = ordinal;
            examinedRecords += 1n;
            examinedBytes += internal.contentByteLength;
            break;
          }
        }
        examinedRecords += 1n;
        examinedBytes += internal.contentByteLength;
        scanCursor = ordinal;
        ordinal += direction === 'forward' ? 1n : -1n;
      }
      if (truncatedReason === undefined && sawUninspectableRecord) {
        truncatedReason = 'uninspectable_record';
      }
    }

    // Hydration observes schema fields needed by a cold page's default columns.
    const columns = materializeRows
      ? options.columns === undefined
        ? this.defaultColumns(options.enricher?.columns)
        : options.columns.slice(0, MAX_TABLE_COLUMNS)
      : [];
    const rows = materializeRows
      ? withTrace(timing, 'projectionMs', () => selected.map(({ hydrated, profile }) =>
        this.projectRow(hydrated, columns, profile, options.enricher?.profileId, projection)))
      : [];
    const firstOrdinal = selected[0]?.hydrated.internal.ordinal;
    const lastOrdinal = selected.at(-1)?.hydrated.internal.ordinal;
    const hasMoreMatches = options.predicate === undefined
      ? offset + BigInt(selected.length) < total
      : matchedRecords > offset + BigInt(selected.length);
    // A scan limit establishes an incomplete result, not another logical page.
    // Restarting a rank-based request cannot continue beyond that same budget.
    const hasAfter = hydrationTruncated || hasMoreMatches;
    await withAsyncTrace(timing, 'snapshotCheckMs', () => this.assertSnapshotUnchanged(guard, onReadWait));

    return {
      rows,
      columns,
      ...(options.projection === undefined ? {} : { projection }),
      anchorOrdinal: (lastOrdinal ?? firstOrdinal ?? 0n).toString(),
      hasBefore: offset > 0n,
      hasAfter,
      indexedRecords: this.index.indexedRecords.toString(),
      totalRecords: total.toString(),
      sort,
      sortOffset: offset.toString(),
      ...(hydrationTruncated && selected.length < limit
        ? { sortNextOffset: (offset + BigInt(selected.length)).toString() }
        : {}),
      matchedRecords: matchedRecords.toString(),
      scan: {
        examinedRecords: examinedRecords.toString(),
        examinedBytes: examinedBytes.toString(),
        ...(scanCursor === undefined ? {} : { cursorOrdinal: scanCursor.toString() }),
        ...(truncatedReason === undefined ? {} : { truncatedReason, direction }),
      },
    };
  }

  /**
   * Execute a globally ordered page without sorting only the already visible
   * rows. Every matching record in the bounded scan contributes a lightweight
   * key/reference candidate; only the best window is retained, and selected
   * records are hydrated after ordering. `scan` makes an incomplete result
   * explicit so the UI can distinguish an exact page from a budget-limited one.
   */
  private async getSortedRows(
    options: GetRowsOptions,
    guard: () => void,
    limit: number,
    sort: RowSort,
    materializeRows: boolean,
    projection: RowProjectionPlan,
    timing: QueryTimingContext,
    onReadWait: ReadWaitObserver | undefined,
  ): Promise<RowPage> {
    const offset = parseNonNegativeBigInt(options.sortOffset ?? '0', 'sortOffset');
    const windowEnd = offset + BigInt(limit);
    if (windowEnd > BigInt(MAX_SORT_WINDOW)) {
      throw new JsonlEngineError(
        'INVALID_ARGUMENT',
        `sortOffset plus limit must not exceed ${String(MAX_SORT_WINDOW)}.`,
      );
    }
    const scanBudget = normalizeSortScanBudget(options.scanBudget);
    const returnedByteLimit = normalizeReturnedByteLimit(options.maxReturnedBytes, this.options.pageHydrationMaxBytes);
    let columns = options.columns === undefined
      ? this.defaultColumns(options.enricher?.columns)
      : options.columns.slice(0, MAX_TABLE_COLUMNS);
    const sortColumn = columns.find((column) => column.id === sort.columnId)
      ?? (sort.columnId === '__ordinal'
        ? { id: '__ordinal', label: '#', source: 'system' as const }
        : sort.columnId === '$ordinal'
          ? { id: '$ordinal', label: '#', source: 'system' as const }
          : sortColumnFromId(sort.columnId));
    if (sortColumn === undefined) {
      throw new JsonlEngineError('INVALID_ARGUMENT', `Unknown sort column: ${sort.columnId}.`);
    }
    if (!columns.some((column) => column.id === sortColumn.id)) {
      columns = [sortColumn, ...columns].slice(0, MAX_TABLE_COLUMNS);
    }

    const candidates: SortCandidate[] = [];
    let matchedRecords = 0n;
    let examinedRecords = 0n;
    let examinedBytes = 0n;
    let scanCursor: bigint | undefined;
    let truncatedReason: ScanTruncationReason | undefined;
    let sawUninspectableRecord = false;
    const retainLimit = Number(windowEnd + 1n);
    let ordinal = 0n;

    while (true) {
      guard();
      if (scanBudget.deadlineEpochMs !== undefined && Date.now() >= scanBudget.deadlineEpochMs) {
        truncatedReason = 'time_limit';
        break;
      }
      const internal = await withAsyncTrace(timing, 'indexWorkMs', () => this.index.getRecord(ordinal, guard, onReadWait));
      if (internal === undefined) break;
      truncatedReason = scanLimitBeforeNextRecord(scanBudget, examinedRecords, examinedBytes);
      if (truncatedReason !== undefined) break;
      if (
        scanBudget.maxExaminedBytes !== undefined
        && examinedBytes + internal.contentByteLength > scanBudget.maxExaminedBytes
      ) {
        truncatedReason = 'byte_limit';
        break;
      }
      const hydrated = await this.hydrate(internal, guard, false, undefined, timing, onReadWait);
      options.onHydrated?.({ value: hydrated.value, ref: hydrated.ref, parseState: hydrated.state });
      if (options.predicate !== undefined && hydrated.value === undefined) {
        sawUninspectableRecord = true;
      }
      const profile = hydrated.value === undefined
        ? undefined
        : withTrace(timing, 'projectionMs', () => options.enricher?.project(hydrated.value, hydrated.ref));
      if (withTrace(timing, 'projectionMs', () =>
        this.matches(hydrated, options.predicate, options.enricher, profile))) {
        matchedRecords += 1n;
        const candidate: SortCandidate = {
          internal,
          key: sortValueForColumn(hydrated, sortColumn, profile),
        };
        insertSortCandidate(candidates, candidate, sort.direction, retainLimit);
      }
      examinedRecords += 1n;
      examinedBytes += internal.contentByteLength;
      scanCursor = ordinal;
      ordinal += 1n;
    }

    const ordered = candidates;
    const selectedCandidates = ordered.slice(Number(offset), Number(windowEnd));
    const selected: Array<{ hydrated: HydratedRecord; profile?: AgentRowProjection }> = [];
    let retainedBytes = 0n;
    let hydrationTruncated = false;
    for (const candidate of selectedCandidates) {
      guard();
      if (
        selected.length > 0
        && retainedBytes + candidate.internal.contentByteLength > returnedByteLimit
      ) {
        hydrationTruncated = true;
        break;
      }
      const hydrated = await this.hydrate(candidate.internal, guard, false, undefined, timing, onReadWait);
      const profile = hydrated.value === undefined
        ? undefined
        : withTrace(timing, 'projectionMs', () => options.enricher?.project(hydrated.value, hydrated.ref));
      selected.push(profile === undefined ? { hydrated } : { hydrated, profile });
      retainedBytes += candidate.internal.contentByteLength;
    }
    const rows = materializeRows
      ? withTrace(timing, 'projectionMs', () => selected.map(({ hydrated, profile }) =>
        this.projectRow(hydrated, columns, profile, options.enricher?.profileId, projection)))
      : [];
    const hasMoreRetainedMatches = candidates.length > Number(windowEnd);
    const hasAfter = hydrationTruncated || hasMoreRetainedMatches;
    const firstOrdinal = selected[0]?.hydrated.internal.ordinal;
    const lastOrdinal = selected.at(-1)?.hydrated.internal.ordinal;
    const effectiveTruncatedReason = truncatedReason
      ?? (hydrationTruncated ? 'hydration_limit' : undefined)
      ?? (sawUninspectableRecord ? 'uninspectable_record' : undefined);
    const sortNextOffset = selected.length < selectedCandidates.length
      ? offset + BigInt(selected.length)
      : undefined;
    await withAsyncTrace(timing, 'snapshotCheckMs', () => this.assertSnapshotUnchanged(guard, onReadWait));

    return {
      rows,
      columns,
      ...(options.projection === undefined ? {} : { projection }),
      // Keep a physical anchor for detail/rebuild diagnostics. Sorted paging
      // itself uses sortOffset and never interprets this as a logical rank.
      anchorOrdinal: (lastOrdinal ?? firstOrdinal ?? 0n).toString(),
      hasBefore: offset > 0n,
      hasAfter,
      indexedRecords: this.index.indexedRecords.toString(),
      ...(this.index.totalRecords === undefined ? {} : { totalRecords: this.index.totalRecords.toString() }),
      sort,
      sortOffset: offset.toString(),
      ...(sortNextOffset === undefined ? {} : { sortNextOffset: sortNextOffset.toString() }),
      matchedRecords: matchedRecords.toString(),
      scan: {
        examinedRecords: examinedRecords.toString(),
        examinedBytes: examinedBytes.toString(),
        ...(scanCursor === undefined ? {} : { cursorOrdinal: scanCursor.toString() }),
        ...(effectiveTruncatedReason === undefined ? {} : { truncatedReason: effectiveTruncatedReason }),
      },
    };
  }

  /**
   * Scan problem entries independently from the visible row page. The scan is
   * cursor-based and budgeted; callers must not interpret an incomplete page
   * as a complete-file problem index.
   */
  getProblems(options: GetProblemsOptions = {}): Promise<ProblemPage> {
    return this.enqueue('get_problems', async () => {
      const guard = this.makeGuard(options);
      guard();
      await this.assertSnapshotUnchanged(guard);
      const limit = boundedInteger(options.limit ?? 100, 1, 200, 'limit');
      const direction = options.direction ?? 'forward';
      const scanBudget = normalizeProblemScanBudget(options.scanBudget, direction);
      const anchor = options.anchorOrdinal === undefined
        ? undefined
        : parseNonNegativeBigInt(options.anchorOrdinal, 'anchorOrdinal');

      if (direction === 'backward') await this.index.finish(guard);
      let ordinal = direction === 'backward'
        ? (anchor === undefined ? (this.index.totalRecords ?? 0n) - 1n : anchor - 1n)
        : (anchor === undefined ? 0n : anchor + 1n);
      const items: ProblemRef[] = [];
      let examinedRecords = 0n;
      let examinedBytes = 0n;
      let lastExamined: bigint | undefined;
      let firstExamined: bigint | undefined;
      let truncatedReason: ScanTruncationReason | undefined;
      let stoppedByPageLimit = false;
      let reachedBoundary = false;

      while (ordinal >= 0n) {
        guard();
        truncatedReason = scanLimitBeforeNextRecord(scanBudget, examinedRecords, examinedBytes);
        if (truncatedReason !== undefined) break;
        const internal = await this.index.getRecord(ordinal, guard);
        if (internal === undefined) {
          reachedBoundary = true;
          break;
        }
        if (
          scanBudget?.maxExaminedBytes !== undefined
          && examinedBytes + internal.contentByteLength > scanBudget.maxExaminedBytes
        ) {
          truncatedReason = 'byte_limit';
          break;
        }

        let problems = this.problemCache.get(ordinal);
        if (problems === undefined) {
          const hydrated = await this.hydrate(internal, guard);
          problems = hydrated.problems;
          this.problemCache.set(ordinal, problems);
        }
        examinedRecords += 1n;
        examinedBytes += internal.contentByteLength;
        firstExamined ??= ordinal;
        lastExamined = ordinal;
        if (problems.length > 0) {
          // Keep a physical record's entries together. This may return more
          // than `limit` when one record has multiple diagnostics, avoiding a
          // continuation cursor that would duplicate or drop an entry.
          items.push(...problems);
          if (items.length >= limit) {
            stoppedByPageLimit = true;
            break;
          }
        }
        ordinal += direction === 'forward' ? 1n : -1n;
      }

      const nextOrdinal = lastExamined === undefined
        ? ordinal
        : lastExamined + (direction === 'forward' ? 1n : -1n);
      // Do not probe the next record here: doing so would perform work after a
      // caller's scan budget was exhausted. Index state is enough to describe
      // whether continuation may have more physical records.
      const hasMoreRecords = direction === 'backward'
        ? nextOrdinal >= 0n && nextOrdinal < (this.index.totalRecords ?? 0n)
        : nextOrdinal >= 0n && (nextOrdinal < this.index.indexedRecords || !this.index.indexingComplete);
      const complete = truncatedReason === undefined
        && (!stoppedByPageLimit || !hasMoreRecords)
        && anchor === undefined
        && (reachedBoundary || (!hasMoreRecords && lastExamined !== undefined));
      const total = this.index.totalRecords;
      const startOrdinal = direction === 'forward'
        ? (anchor ?? 0n)
        : (anchor === undefined ? (total ?? 0n) : anchor);
      const hasBefore = direction === 'backward'
        ? hasMoreRecords
        : (firstExamined ?? startOrdinal) > 0n;
      const hasAfter = direction === 'backward'
        ? total !== undefined && startOrdinal < total - 1n
        : hasMoreRecords;

      await this.assertSnapshotUnchanged(guard);
      return {
        items,
        anchorOrdinal: (lastExamined ?? anchor ?? 0n).toString(),
        hasBefore,
        hasAfter,
        indexedRecords: this.index.indexedRecords.toString(),
        observedProblemRecords: this.schema.problemRecordCount.toString(),
        complete,
        scan: {
          examinedRecords: examinedRecords.toString(),
          examinedBytes: examinedBytes.toString(),
          ...(lastExamined === undefined ? {} : { cursorOrdinal: lastExamined.toString() }),
          direction,
          ...(truncatedReason === undefined ? {} : { truncatedReason }),
        },
      };
    });
  }

  getDetail(ref: RecordRef, options: GetDetailOptions = {}): Promise<RecordDetail> {
    return this.enqueue('get_detail', async () => {
      const guard = this.makeGuard({
        generation: options.generation ?? ref.generation,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      guard();
      const ordinal = parseNonNegativeBigInt(ref.ordinal, 'ref.ordinal');
      const internal = await this.index.getRecord(ordinal, guard);
      if (internal === undefined || !sameCoordinates(internal, ref, this.snapshot.generation)) {
        throw new JsonlEngineError('INVALID_RECORD_REF', 'Record coordinates do not match the current snapshot index.');
      }
      const hydrated = await this.hydrate(internal, guard, options.full === true);
      const profile = hydrated.value === undefined
        ? undefined
        : options.enricher?.project(hydrated.value, hydrated.ref);
      await this.assertSnapshotUnchanged(guard);
      return {
        ref: hydrated.ref,
        rawPreview: hydrated.rawPreview,
        rawComplete: hydrated.rawComplete,
        ...(hydrated.value === undefined ? {} : { value: hydrated.value }),
        ...(profile === undefined ? {} : { profile }),
        problems: hydrated.problems,
      };
    });
  }

  /** Exact record content for the host-only read-only text adapter; no JSON hydration. */
  getRecordText(ref: RecordRef, maxBytes: number): Promise<{ sourceGeneration: string; text: string; complete: boolean }> {
    return this.enqueue('get_detail', async () => {
      const limit = boundedInteger(maxBytes, 1, 1_048_576, 'maxBytes');
      const guard = this.makeGuard({ generation: ref.generation });
      guard();
      if (!await this.validateObservedSource({ generation: ref.generation })) {
        throw new JsonlEngineError('SOURCE_CHANGED', 'The source changed before the bounded text read.');
      }
      const ordinal = parseNonNegativeBigInt(ref.ordinal, 'ref.ordinal');
      if (ordinal >= this.index.indexedRecords) {
        throw new JsonlEngineError('INVALID_RECORD_REF', 'The record is outside the current indexed snapshot.');
      }
      const internal = await this.index.getRecord(ordinal, guard);
      if (internal === undefined || !sameCoordinates(internal, ref, this.snapshot.generation)) {
        throw new JsonlEngineError('INVALID_RECORD_REF', 'Record coordinates do not match the current snapshot index.');
      }
      if (internal.contentByteLength > BigInt(limit)) {
        return { sourceGeneration: this.snapshot.generation, text: '', complete: false };
      }
      await assertBoundaryFingerprints(this.handle, this.fileSize, this.prefixFingerprint, this.tailFingerprint, guard);
      const bytes = await this.readExactly(internal.byteStart, Number(internal.contentByteLength), guard);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new JsonlEngineError('INVALID_ARGUMENT', 'Read-only record text requires valid UTF-8.');
      }
      await assertBoundaryFingerprints(this.handle, this.fileSize, this.prefixFingerprint, this.tailFingerprint, guard);
      if (!await this.validateObservedSource({ generation: ref.generation })) {
        throw new JsonlEngineError('SOURCE_CHANGED', 'The source changed during the bounded text read.');
      }
      return { sourceGeneration: this.snapshot.generation, text, complete: true };
    });
  }

  getSchema(
    offset = 0,
    limit = 100,
    context: JsonlOperationContext = {},
  ): Promise<{ fields: FieldStats[]; totalFields: number; complete: boolean }> {
    return this.enqueue('get_schema', async () => {
      const guard = this.makeGuard(context);
      guard();
      const safeOffset = boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
      const safeLimit = boundedInteger(limit, 1, 500, 'limit');
      const page = this.schema.page(safeOffset, safeLimit, this.index.indexingComplete, this.index.totalRecords);
      guard();
      return page;
    });
  }

  /**
   * Bounded metadata observation for presentation handoffs. This does not prove
   * content equality or classify append recovery, and never hashes source bytes.
   * No queue mutation is involved, so callers may use it inside an engine task.
   */
  async validateObservedSource(context: JsonlOperationContext = {}): Promise<boolean> {
    return validateSourceObservation({
      filePath: this.filePath, handle: this.handle, isInvalidated: () => this.invalidated,
      device: this.sourceDevice, inode: this.sourceInode, size: this.fileSize,
      mtimeNs: this.sourceMtimeNs, ctimeNs: this.sourceCtimeNs,
    }, this.makeGuard(context));
  }

  classifyRefresh(context: JsonlOperationContext = {}): Promise<SourceRefreshResult> {
    return this.enqueue('classify_refresh', async () => {
      const guard = this.makeGuard(context);
      guard();
      const observedAt = new Date().toISOString();
      let currentStat: BigIntStats;
      try {
        currentStat = await stat(this.filePath, { bigint: true });
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return { kind: 'delete', previousSizeBytes: this.fileSize.toString(), observedAt };
        }
        throw error;
      }
      guard();
      const currentSize = currentStat.size;
      const base = {
        previousSizeBytes: this.fileSize.toString(),
        currentSizeBytes: currentSize.toString(),
        observedAt,
      };

      if (!currentStat.isFile()) {
        return { kind: 'replace', ...base };
      }
      const sourceIdentityAvailable = this.sourceDevice !== 0n
        && this.sourceInode !== 0n
        && currentStat.dev !== 0n
        && currentStat.ino !== 0n;
      if (!sourceIdentityAvailable) {
        return { kind: 'unknown', ...base };
      }
      if (currentStat.dev !== this.sourceDevice || currentStat.ino !== this.sourceInode) {
        return { kind: 'replace', ...base };
      }
      if (currentSize < this.fileSize) {
        return { kind: 'truncate', ...base };
      }

      let currentHandle: FileHandle;
      try {
        currentHandle = await open(this.filePath, 'r');
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return { kind: 'delete', ...base };
        }
        // The path changed between stat and open. Do not turn a transient
        // writer/replace race into an unstructured reconcile error.
        return { kind: 'unknown', ...base };
      }
      try {
        const prefix = await fingerprintRange(currentHandle, 0n, this.prefixFingerprint.length);
        guard();
        if (prefix.hash !== this.prefixFingerprint.hash || prefix.length !== this.prefixFingerprint.length) {
          return { kind: 'replace', ...base };
        }

        const oldTailStart = this.fileSize - BigInt(this.tailFingerprint.length);
        const oldTail = await fingerprintRange(currentHandle, oldTailStart, this.tailFingerprint.length);
        guard();
        if (oldTail.hash !== this.tailFingerprint.hash || oldTail.length !== this.tailFingerprint.length) {
          return { kind: 'replace', ...base };
        }

        const original = await this.getFullFingerprint();
        if (original === undefined) return { kind: 'unknown', ...base };
        const currentOldRange = await fingerprintWholeRange(currentHandle, this.fileSize, undefined, guard);
        if (currentOldRange.hash !== original.hash || currentOldRange.length !== original.length) {
          return { kind: 'replace', ...base };
        }

        // A writer can advance the file after the range hash was read. Do not
        // publish an append/unchanged classification for that moving target;
        // the next debounced probe will observe a stable generation.
        let latestStat: BigIntStats;
        try {
          latestStat = await stat(this.filePath, { bigint: true });
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') {
            return { kind: 'delete', ...base };
          }
          throw error;
        }
        if (!latestStat.isFile()) {
          return { kind: 'replace', ...base };
        }
        if (
          latestStat.dev !== this.sourceDevice
          || latestStat.ino !== this.sourceInode
            || latestStat.size !== currentSize
            || latestStat.mtimeNs !== currentStat.mtimeNs
            || latestStat.ctimeNs !== currentStat.ctimeNs
        ) {
          return { kind: 'unknown', ...base };
        }
      } finally {
        await currentHandle.close();
      }

      if (currentSize > this.fileSize) return { kind: 'append', ...base };
      return { kind: 'unchanged', ...base };
    });
  }

  /**
   * Whether this generation has an exact original-range fingerprint that can
   * be used to prove an append. Large files intentionally defer that O(n)
   * baseline until a refresh needs it; stable follow recovery can instead
   * validate a newly opened candidate as a full resync.
   */
  get canValidateOriginalSnapshot(): boolean {
    return this.fullFingerprintKnown;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = true;
      this.lifecycleAbort.abort();
      this.fingerprintAbort.abort();
      for (const controller of this.backgroundControllers) controller.abort();
      this.backgroundControllers.clear();
    }
    await this.executor.idle();
    if (!this.closed) {
      this.closed = true;
      await this.handle.close();
    }
  }

  private enqueue<T>(
    name: JsonlEngineQueueOperation,
    operation: () => Promise<T>,
    onTiming?: (queueWaitMs: number, engineExecMs: number, blockedBy: JsonlEngineQueueOperation) => void,
    priority?: QueuePriority,
  ): Promise<T> {
    this.assertAccepting();
    return this.executor.run(name, operation, onTiming, priority);
  }

  private assertAccepting(): void {
    if (this.closing || this.closed) {
      throw new JsonlEngineError('DISPOSED', 'The JSONL engine has been disposed.');
    }
  }

  private makeGuard(context: JsonlOperationContext): () => void {
    return () => {
      if (this.lifecycleAbort.signal.aborted || this.closing || this.closed) {
        throw new JsonlEngineError('ABORTED', 'JSONL operation was cancelled because the engine is closing.');
      }
      if (context.signal?.aborted === true) {
        throw new JsonlEngineError('ABORTED', 'JSONL operation was cancelled.');
      }
      if (context.generation !== undefined && context.generation !== this.snapshot.generation) {
        throw new JsonlEngineError('STALE_GENERATION', 'Request generation does not match the source snapshot.');
      }
    };
  }

  private async assertSnapshotUnchanged(
    guard?: () => void,
    onReadWait?: ReadWaitObserver,
  ): Promise<void> {
    guard?.();
    if (this.invalidated) {
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source no longer matches this snapshot.');
    }
    let pathState: BigIntStats;
    try {
      pathState = await stat(this.filePath, { bigint: true });
    } catch {
      this.invalidateSnapshot();
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source path no longer identifies this snapshot.');
    }
    if (
      this.sourceDevice !== 0n
      && this.sourceInode !== 0n
      && (pathState.dev !== this.sourceDevice || pathState.ino !== this.sourceInode)
    ) {
      this.invalidateSnapshot();
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source path now identifies a different file.');
    }
    const current = await this.handle.stat({ bigint: true });
    guard?.();
    if (
      current.size === this.fileSize
      && current.mtimeNs === this.sourceMtimeNs
      && current.ctimeNs === this.sourceCtimeNs
    ) return;
    if (current.size < this.fileSize) {
      this.invalidateSnapshot();
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source was truncated after this snapshot opened.');
    }
    if (current.size > this.fileSize) {
      const prefix = await fingerprintRange(this.handle, 0n, this.prefixFingerprint.length, onReadWait);
      guard?.();
      const oldTail = await fingerprintRange(
        this.handle,
        this.fileSize - BigInt(this.tailFingerprint.length),
        this.tailFingerprint.length,
        onReadWait,
      );
      guard?.();
      if (
        prefix.hash === this.prefixFingerprint.hash
        && prefix.length === this.prefixFingerprint.length
        && oldTail.hash === this.tailFingerprint.hash
        && oldTail.length === this.tailFingerprint.length
      ) {
        const original = await this.getFullFingerprint(onReadWait);
        if (original === undefined) {
          // Keep the already-open generation readable while a large writer is
          // still moving. The recovery coordinator will establish a stable
          // baseline and atomically publish a replacement generation; bytes
          // beyond this snapshot are never admitted by this engine.
          return;
        }
        const currentOldRange = await fingerprintWholeRange(this.handle, this.fileSize, undefined, guard, onReadWait);
        if (currentOldRange.hash !== original.hash || currentOldRange.length !== original.length) {
          this.invalidateSnapshot();
          throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed inside the open snapshot range.');
        }
        const latest = await this.handle.stat({ bigint: true });
        guard?.();
        if (
          latest.size === current.size
          && latest.mtimeNs === current.mtimeNs
          && latest.ctimeNs === current.ctimeNs
          && latest.dev === current.dev
          && latest.ino === current.ino
        ) return;
        throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed while the snapshot was being checked.');
      }
      this.invalidateSnapshot();
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed at the beginning of the snapshot range.');
    }
    if (
      current.size === this.fileSize
      && (current.mtimeNs !== this.sourceMtimeNs || current.ctimeNs !== this.sourceCtimeNs)
    ) {
      const original = await this.getFullFingerprint(onReadWait);
      if (original === undefined) {
        throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source has no stable baseline; rebuild after the writer settles.');
      }
      const currentRange = await fingerprintWholeRange(this.handle, this.fileSize, undefined, guard, onReadWait);
      if (currentRange.hash !== original.hash || currentRange.length !== original.length) {
        this.invalidateSnapshot();
        throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed inside the open snapshot range.');
      }
      const latest = await this.handle.stat({ bigint: true });
      guard?.();
      if (
        latest.size === current.size
        && latest.mtimeNs === current.mtimeNs
        && latest.ctimeNs === current.ctimeNs
        && latest.dev === current.dev
        && latest.ino === current.ino
      ) return;
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed while the snapshot was being checked.');
    }
    this.invalidateSnapshot();
    throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed after this snapshot opened.');
  }

  private async assertSnapshotMetadataUnchanged(): Promise<void> {
    let pathState: BigIntStats;
    try {
      pathState = await stat(this.filePath, { bigint: true });
    } catch {
      this.invalidateSnapshot();
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source path no longer identifies this snapshot.');
    }
    const handleState = await this.handle.stat({ bigint: true });
    const sameIdentity = pathState.dev === this.sourceDevice && pathState.ino === this.sourceInode;
    const sameOpenFile = pathState.dev === handleState.dev && pathState.ino === handleState.ino;
    const truncated = pathState.size < this.fileSize || handleState.size < this.fileSize;
    const divergentSize = pathState.size !== handleState.size;
    const equalLengthRewrite = handleState.size === this.fileSize
      && (handleState.mtimeNs !== this.sourceMtimeNs || handleState.ctimeNs !== this.sourceCtimeNs);
    if (!sameIdentity || !sameOpenFile || truncated || divergentSize || equalLengthRewrite) {
      if (sameIdentity && sameOpenFile && !truncated && divergentSize && handleState.size > this.fileSize) {
        // Appenders may advance the physical file while this generation is
        // still serving cached/indexed rows. Keep the old boundary readable;
        // stable recovery owns admission of the appended range.
        return;
      }
      this.invalidateSnapshot();
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed before staged index data could commit.');
    }
  }

  private getFullFingerprint(onReadWait?: ReadWaitObserver): Promise<FullSourceFingerprint | undefined> {
    if (this.fullFingerprint === undefined) {
      // Large files do not pay this O(n) read during open/first-page work. The
      // first refresh or snapshot guard that needs an exact baseline starts it
      // once and shares the result with concurrent callers.
      this.fullFingerprint = Promise.resolve()
        .then(() => fingerprintStableRange(
          this.handle,
          this.fileSize,
          this.sourceMtimeNs,
          this.sourceCtimeNs,
          this.fingerprintAbort.signal,
          onReadWait,
        ))
        .then((result) => {
          this.fullFingerprintKnown = result !== undefined;
          return result;
        });
    }
    return this.fullFingerprint;
  }

  private invalidateSnapshot(): void {
    this.invalidated = true;
    this.problemCache.clear();
  }

  private async hydrate(
    internal: InternalRecordRef,
    guard: () => void,
    full = false,
    readWindow?: ForwardPageReadWindow,
    timing?: QueryTimingContext,
    onReadWait?: ReadWaitObserver,
  ): Promise<HydratedRecord> {
    guard();
    const hydrationLimit = full ? this.options.fullRecordMaxBytes : this.options.maxRecordBytes;
    if (internal.contentByteLength > BigInt(hydrationLimit)) {
      internal.parseState = 'oversized';
      const previewLength = Number(internal.contentByteLength < BigInt(this.options.previewBytes)
        ? internal.contentByteLength
        : BigInt(this.options.previewBytes));
      const previewBytes = await this.readExactly(internal.byteStart, previewLength, guard, undefined, previewLength, onReadWait);
      const rawPreview = decodePreview(stripInitialBom(previewBytes, internal.ordinal));
      const ref = this.index.toPublic(internal, this.snapshot.generation);
      const problems: ProblemRef[] = [{
        code: 'OVERSIZED_RECORD',
        message: full
          ? `Record is ${internal.contentByteLength.toString()} bytes; explicit detail hydration is capped at ${String(hydrationLimit)} bytes.`
          : `Record is ${internal.contentByteLength.toString()} bytes; automatic hydration is capped at ${String(hydrationLimit)} bytes.`,
        severity: 'warning',
        ref,
      }];
      if (hasInitialBom(previewBytes, internal.ordinal)) {
        problems.push(nonStandardBomProblem(ref));
      }
      this.observe(internal, 'problem');
      return { internal, ref, state: 'oversized', rawPreview, rawComplete: false, problems };
    }

    const length = Number(internal.contentByteLength);
    const bytes = await this.readExactly(
      internal.byteStart,
      length,
      guard,
      readWindow,
      length + internal.delimiterByteLength,
      onReadWait,
    );
    const hasBom = hasInitialBom(bytes, internal.ordinal);
    const content = stripInitialBom(bytes, internal.ordinal);
    let text: string;
    try {
      text = withTrace(timing, 'parseMs', () => new TextDecoder('utf-8', { fatal: true }).decode(content));
    } catch (error) {
      internal.parseState = 'encoding_error';
      const ref = this.index.toPublic(internal, this.snapshot.generation);
      const problems: ProblemRef[] = [{
        code: 'INVALID_UTF8',
        message: 'Record is not valid UTF-8.',
        severity: 'error',
        ref,
      }];
      this.observe(internal, 'problem');
      return {
        internal,
        ref,
        state: 'encoding_error',
        rawPreview: decodePreview(content),
        rawComplete: true,
        problems,
      };
    }

    if (text.trim().length === 0) {
      internal.parseState = 'blank';
      const ref = this.index.toPublic(internal, this.snapshot.generation);
      const problems: ProblemRef[] = [{
        code: 'BLANK_RECORD',
        message: 'Physical JSONL record is blank.',
        severity: 'warning',
        ref,
      }];
      this.observe(internal, 'problem');
      return { internal, ref, state: 'blank', rawPreview: text, rawComplete: true, problems };
    }

    let value: unknown;
    try {
      value = withTrace(timing, 'parseMs', () => JSON.parse(text) as unknown);
    } catch (error) {
      internal.parseState = 'invalid_json';
      const ref = this.index.toPublic(internal, this.snapshot.generation);
      const details = error instanceof Error ? error.message : 'JSON parsing failed.';
      const problems: ProblemRef[] = [{
        code: 'INVALID_JSON',
        message: truncateCharacters(details, this.options.rowPreviewCharacters),
        severity: 'error',
        ref,
      }];
      this.observe(internal, 'problem');
      return {
        internal,
        ref,
        state: 'invalid_json',
        rawPreview: text,
        rawComplete: true,
        problems,
      };
    }

    internal.parseState = 'valid';
    const ref = this.index.toPublic(internal, this.snapshot.generation);
    this.observe(internal, 'valid', value);
    return {
      internal,
      ref,
      state: 'valid',
      rawPreview: text,
      rawComplete: true,
      value,
      problems: hasBom ? [nonStandardBomProblem(ref)] : [],
    };
  }

  private observe(internal: InternalRecordRef, state: 'valid' | 'problem', value?: unknown): void {
    const location = this.index.locate(internal.ordinal);
    if (location === undefined) return;
    this.schema.observe(
      location.segmentId,
      location.localIndex,
      location.segmentCapacity,
      internal.ordinal,
      state,
      value,
    );
  }

  private async readExactly(
    start: bigint,
    length: number,
    guard: () => void,
    readWindow?: ForwardPageReadWindow,
    recordSpan = length,
    onReadWait?: ReadWaitObserver,
  ): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const cached = await readWindow?.read(start, length, recordSpan, guard, onReadWait);
    if (cached !== undefined) return cached;
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      guard();
      const readLength = Math.min(this.options.readChunkBytes, length - offset);
      const bytesRead = await readFileHandle(
        this.handle,
        result,
        offset,
        readLength,
        start + BigInt(offset),
        onReadWait,
      );
      guard();
      if (bytesRead <= 0) {
        throw new JsonlEngineError('UNEXPECTED_EOF', 'The JSONL record ended before its indexed byte boundary.');
      }
      offset += bytesRead;
    }
    return result;
  }

  private matches(
    hydrated: HydratedRecord,
    predicate: Predicate | undefined,
    enricher: RowEnricher | undefined,
    profile: AgentRowProjection | undefined,
  ): boolean {
    if (predicate === undefined) return true;
    if (hydrated.value === undefined) return false;
    const profileFields = enricher?.predicateFields?.(profile, hydrated.value, hydrated.ref);
    return evaluatePredicate(
      predicate,
      hydrated.value,
      profileFields === undefined ? {} : { profileFields },
    );
  }

  private defaultColumns(profileColumns: readonly ColumnSpec[] | undefined): ColumnSpec[] {
    const columns = profileColumns?.slice(0, this.options.defaultColumnLimit) ?? [];
    if (columns.length > 0) return columns;
    const remaining = Math.max(0, this.options.defaultColumnLimit - columns.length);
    for (const path of this.schema.suggestedPaths(remaining)) {
      const label = path.tokens.length === 0
        ? 'Value'
        : String(path.tokens[path.tokens.length - 1]?.value ?? 'Value');
      columns.push({ id: JSON.stringify(path.tokens), label, path, source: 'record' });
    }
    return columns;
  }

  private projectRow(
    hydrated: HydratedRecord,
    columns: ColumnSpec[],
    profile?: AgentRowProjection,
    selectedProfileId?: string,
    projection: RowProjectionPlan = resolveRowProjectionPlan(undefined, selectedProfileId),
  ): RowProjection {
    const genericSummary = summaryForRecord(hydrated, this.options.rowPreviewCharacters);
    const cells = columns.flatMap((column): CellProjection[] => {
      if (column.source === 'system' && column.id === '$ordinal') {
        const ordinal = hydrated.internal.ordinal;
        return [ordinal <= BigInt(Number.MAX_SAFE_INTEGER)
          ? { columnId: column.id, kind: 'integer', value: Number(ordinal) }
          : { columnId: column.id, kind: 'integer', preview: ordinal.toString() }];
      }
      if (column.source === 'profile') {
        if (profile === undefined) {
          if (column.id === 'summary' || column.id === 'message') {
            return [cellForValue(column.id, genericSummary, this.options.rowPreviewCharacters)];
          }
          return [{ columnId: column.id }];
        }
        const value = Object.hasOwn(profile, column.id)
          ? (profile as AgentRowProjection & Record<string, unknown>)[column.id]
          : profile.derivedFields?.[column.id];
        if (value === undefined) return [{ columnId: column.id }];
        return [cellForValue(
          column.id,
          value,
          this.options.rowPreviewCharacters,
        )];
      }
      if (column.source !== 'record' || column.path === undefined || hydrated.value === undefined) return [];
      const resolved = resolveFieldPath(hydrated.value, column.path);
      if (!resolved.exists) return [{ columnId: column.id }];
      return [cellForValue(column.id, resolved.value, this.options.rowPreviewCharacters)];
    });

    const bfclV3 = projection.dataset && hydrated.value !== undefined && isBfclV3Candidate(hydrated.value)
      ? summarizeBfclV3Record(hydrated.value)
      : undefined;
    const opentelemetry = selectedProfileId === 'opentelemetry' && hydrated.value !== undefined
      ? summarizeOpenTelemetryRecord(hydrated.value)
      : undefined;
    const datasetInsights = bfclV3 !== undefined
      ? { bfclV3 }
      : (opentelemetry?.recognized === true ? { opentelemetry } : undefined);
    return {
      ref: hydrated.ref,
      ...(hydrated.value === undefined ? {} : { kind: jsonKindOf(hydrated.value) }),
      cells,
      genericSummary,
      ...(projection.conversation ? { conversation: projectConversation(hydrated.value, profile) } : {}),
      ...(projection.dataset
        ? { dataset: summarizeDatasetRecord(hydrated.value, hydrated.ref.parseState) } : {}),
      ...(datasetInsights === undefined ? {} : { datasetInsights }),
      ...(profile === undefined ? {} : { profile }),
      ...(hydrated.problems.length === 0 ? {} : { problems: hydrated.problems }),
    };
  }
}

function normalizeOptions(options: JsonlEngineOptions): NormalizedOptions {
  const readChunkBytes = boundedInteger(options.readChunkBytes ?? 256 * 1024, 4, 16 * 1024 * 1024, 'readChunkBytes');
  return {
    readChunkBytes,
    segmentTargetBytes: boundedInteger(options.segmentTargetBytes ?? 4 * 1024 * 1024, 16, 64 * 1024 * 1024, 'segmentTargetBytes'),
    segmentTargetRecords: boundedInteger(options.segmentTargetRecords ?? 4096, 1, 65_536, 'segmentTargetRecords'),
    exactCacheSegments: boundedInteger(options.exactCacheSegments ?? 4, 1, 64, 'exactCacheSegments'),
    maxQueuedOperations: boundedInteger(options.maxQueuedOperations ?? 64, 1, 4096, 'maxQueuedOperations'),
    maxRecordBytes: boundedInteger(options.maxRecordBytes ?? 1024 * 1024, 1, 64 * 1024 * 1024, 'maxRecordBytes'),
    fullRecordMaxBytes: boundedInteger(
      options.fullRecordMaxBytes ?? 16 * 1024 * 1024,
      1,
      256 * 1024 * 1024,
      'fullRecordMaxBytes',
    ),
    pageHydrationMaxBytes: boundedInteger(options.pageHydrationMaxBytes ?? 8 * 1024 * 1024, 1, 256 * 1024 * 1024, 'pageHydrationMaxBytes'),
    previewBytes: boundedInteger(options.previewBytes ?? 16 * 1024, 1, 1024 * 1024, 'previewBytes'),
    rowPreviewCharacters: boundedInteger(options.rowPreviewCharacters ?? 240, 16, 4096, 'rowPreviewCharacters'),
    defaultColumnLimit: boundedInteger(options.defaultColumnLimit ?? 12, 1, 64, 'defaultColumnLimit'),
    schemaMaxFields: boundedInteger(options.schemaMaxFields ?? 2048, 1, 65_536, 'schemaMaxFields'),
    schemaMaxDepth: boundedInteger(options.schemaMaxDepth ?? 4, 0, 16, 'schemaMaxDepth'),
    schemaMaxArrayEntries: boundedInteger(options.schemaMaxArrayEntries ?? 3, 0, 32, 'schemaMaxArrayEntries'),
    schemaMaxExamples: boundedInteger(options.schemaMaxExamples ?? 3, 0, 16, 'schemaMaxExamples'),
    newlineScanner: normalizeScannerSetting(options.newlineScanner),
  };
}

function normalizeScannerSetting(value: NativeNewlineScannerSetting | undefined): NativeNewlineScannerSetting {
  if (value === 'off' || value === 'auto' || value === 'on') return value;
  const environment = process.env.JSONLVIEW_NEWLINE_SCANNER?.trim().toLowerCase();
  if (environment === 'node') return 'off';
  if (environment === 'auto') return 'auto';
  if (environment === 'native') return 'on';
  return 'off';
}

function scannerMode(value: NativeNewlineScannerSetting): 'node' | 'auto' | 'native' {
  if (value === 'on') return 'native';
  return value === 'auto' ? 'auto' : 'node';
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new JsonlEngineError(
      'INVALID_ARGUMENT',
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`,
    );
  }
  return value;
}

function normalizeRowScanBudget(
  value: RowScanBudget | undefined,
  direction: 'forward' | 'backward',
): NormalizedRowScanBudget | undefined {
  if (value === undefined) return undefined;
  const maxExaminedRecords = value.maxExaminedRecords === undefined
    ? undefined
    : BigInt(boundedInteger(
      value.maxExaminedRecords,
      1,
      Number.MAX_SAFE_INTEGER,
      'scanBudget.maxExaminedRecords',
    ));
  const maxExaminedBytes = value.maxExaminedBytes === undefined
    ? undefined
    : parseNonNegativeBigInt(value.maxExaminedBytes, 'scanBudget.maxExaminedBytes');
  if (maxExaminedBytes === 0n) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'scanBudget.maxExaminedBytes must be greater than zero.');
  }
  const deadlineEpochMs = value.deadlineEpochMs === undefined
    ? undefined
    : boundedInteger(
      value.deadlineEpochMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'scanBudget.deadlineEpochMs',
    );
  if (
    maxExaminedRecords === undefined
    && maxExaminedBytes === undefined
    && deadlineEpochMs === undefined
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'scanBudget must define at least one limit.');
  }
  return {
    ...(maxExaminedRecords === undefined ? {} : { maxExaminedRecords }),
    ...(maxExaminedBytes === undefined ? {} : { maxExaminedBytes }),
    ...(deadlineEpochMs === undefined ? {} : { deadlineEpochMs }),
  };
}

function normalizeReturnedByteLimit(value: string | bigint | undefined, engineLimit: number): bigint {
  if (value === undefined) return BigInt(engineLimit);
  const parsed = typeof value === 'bigint' ? value : parseNonNegativeBigInt(value, 'maxReturnedBytes');
  if (parsed < 1n) throw new JsonlEngineError('INVALID_ARGUMENT', 'maxReturnedBytes must be greater than zero.');
  return parsed < BigInt(engineLimit) ? parsed : BigInt(engineLimit);
}

function normalizeProblemScanBudget(
  value: RowScanBudget | undefined,
  direction: 'forward' | 'backward',
): NormalizedRowScanBudget {
  const normalized = normalizeRowScanBudget(value ?? {
    maxExaminedRecords: DEFAULT_PROBLEM_MAX_EXAMINED_RECORDS,
    maxExaminedBytes: BigInt(DEFAULT_PROBLEM_MAX_EXAMINED_BYTES),
    deadlineEpochMs: Date.now() + DEFAULT_PROBLEM_MAX_MILLISECONDS,
  }, direction);
  if (normalized === undefined) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'A problem scan requires a bounded scan budget.');
  }
  if (
    normalized.maxExaminedRecords !== undefined
    && normalized.maxExaminedRecords > BigInt(HARD_PROBLEM_MAX_EXAMINED_RECORDS)
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', `problem scan record budget must not exceed ${String(HARD_PROBLEM_MAX_EXAMINED_RECORDS)}.`);
  }
  if (
    normalized.maxExaminedBytes !== undefined
    && normalized.maxExaminedBytes > BigInt(HARD_PROBLEM_MAX_EXAMINED_BYTES)
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', `problem scan byte budget must not exceed ${String(HARD_PROBLEM_MAX_EXAMINED_BYTES)}.`);
  }
  if (
    normalized.deadlineEpochMs !== undefined
    && normalized.deadlineEpochMs > Date.now() + HARD_PROBLEM_MAX_MILLISECONDS
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', `problem scan deadline must be within ${String(HARD_PROBLEM_MAX_MILLISECONDS)}ms.`);
  }
  return normalized;
}

function normalizeSortScanBudget(value: RowScanBudget | undefined): NormalizedRowScanBudget {
  const normalized = normalizeRowScanBudget(value ?? {
    maxExaminedRecords: DEFAULT_SORT_MAX_EXAMINED_RECORDS,
    maxExaminedBytes: BigInt(DEFAULT_SORT_MAX_EXAMINED_BYTES),
    deadlineEpochMs: Date.now() + DEFAULT_SORT_MAX_MILLISECONDS,
  }, 'forward');
  if (normalized === undefined) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'A sorted query requires a bounded scan budget.');
  }
  if (
    normalized.maxExaminedRecords !== undefined
    && normalized.maxExaminedRecords > BigInt(HARD_SORT_MAX_EXAMINED_RECORDS)
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', `sort scan record budget must not exceed ${String(HARD_SORT_MAX_EXAMINED_RECORDS)}.`);
  }
  if (
    normalized.maxExaminedBytes !== undefined
    && normalized.maxExaminedBytes > BigInt(HARD_SORT_MAX_EXAMINED_BYTES)
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', `sort scan byte budget must not exceed ${String(HARD_SORT_MAX_EXAMINED_BYTES)}.`);
  }
  if (
    normalized.deadlineEpochMs !== undefined
    && normalized.deadlineEpochMs > Date.now() + HARD_SORT_MAX_MILLISECONDS
  ) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'sort scan deadline must be within 60 seconds.');
  }
  return normalized;
}

function scanLimitBeforeNextRecord(
  budget: NormalizedRowScanBudget | undefined,
  examinedRecords: bigint,
  examinedBytes: bigint,
): ScanTruncationReason | undefined {
  if (budget === undefined) return undefined;
  if (budget.deadlineEpochMs !== undefined && Date.now() >= budget.deadlineEpochMs) {
    return 'time_limit';
  }
  if (budget.maxExaminedRecords !== undefined && examinedRecords >= budget.maxExaminedRecords) {
    return 'record_limit';
  }
  if (budget.maxExaminedBytes !== undefined && examinedBytes >= budget.maxExaminedBytes) {
    return 'byte_limit';
  }
  return undefined;
}

function parseNonNegativeBigInt(value: string | bigint, name: string): bigint {
  if (typeof value === 'bigint') {
    if (value >= 0n) return value;
  } else if (/^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value);
  }
  throw new JsonlEngineError('INVALID_ARGUMENT', `${name} must be a non-negative decimal integer.`);
}

function safeScheme(uri: string): string {
  try {
    return new URL(uri).protocol.replace(/:$/, '');
  } catch {
    return 'file';
  }
}

function hasInitialBom(buffer: Buffer, ordinal: bigint): boolean {
  return ordinal === 0n
    && buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf;
}

function stripInitialBom(buffer: Buffer, ordinal: bigint): Buffer {
  return hasInitialBom(buffer, ordinal)
    ? buffer.subarray(3)
    : buffer;
}

function nonStandardBomProblem(ref: RecordRef): ProblemRef {
  return {
    code: 'NON_STANDARD_BOM',
    message: 'A UTF-8 BOM was tolerated for recovery, but JSON Lines producers should not emit one.',
    severity: 'warning',
    ref,
  };
}

function decodePreview(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
}

function truncateCharacters(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 3))}...`;
}

function cellForValue(columnId: string, value: unknown, maximum: number): CellProjection {
  const kind = jsonKindOf(value);
  if (typeof value === 'string') {
    return value.length <= maximum
      ? { columnId, kind, value }
      : { columnId, kind, preview: truncateCharacters(value, maximum), truncated: true };
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { columnId, kind, value };
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return {
    columnId,
    kind,
    preview: truncateCharacters(rendered, maximum),
    ...(rendered.length <= maximum ? {} : { truncated: true }),
  };
}

function summaryForRecord(hydrated: HydratedRecord, maximum: number): string {
  switch (hydrated.state) {
    case 'blank': return '[blank record]';
    case 'encoding_error': return `[invalid UTF-8] ${truncateCharacters(hydrated.rawPreview, maximum)}`;
    case 'invalid_json': return `[invalid JSON] ${truncateCharacters(hydrated.rawPreview, maximum)}`;
    case 'oversized': return `[oversized ${hydrated.internal.contentByteLength.toString()} bytes] ${truncateCharacters(hydrated.rawPreview, maximum)}`;
    case 'valid': {
      try {
        return truncateCharacters(JSON.stringify(hydrated.value), maximum);
      } catch {
        return truncateCharacters(String(hydrated.value), maximum);
      }
    }
    case 'unknown': return '[unparsed record]';
  }
}

function sameCoordinates(internal: InternalRecordRef, ref: RecordRef, generation: string): boolean {
  if (ref.generation !== generation) return false;
  try {
    return internal.ordinal === BigInt(ref.ordinal)
      && internal.byteStart === BigInt(ref.byteStart)
      && internal.byteEndExclusive === BigInt(ref.byteEndExclusive)
      && internal.contentByteLength === BigInt(ref.contentByteLength)
      && internal.delimiterByteLength === ref.delimiterByteLength;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
