import { createHash, randomUUID } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  RecordDetail,
  RecordRef,
  RowPage,
  RowProjection,
  ScanTruncationReason,
  SnapshotIdentity,
} from '../shared/types';
import { JsonlEngineError, isAbortError } from './errors';
import { createNewlineScanner } from './newline-scanner';
import { evaluatePredicate, jsonKindOf, resolveFieldPath } from './predicate';
import { ProgressiveSchemaTracker } from './schema';
import {
  AdaptiveSegmentIndex,
  type InternalRecordRef,
  type SegmentIndexDiagnostics,
} from './segment-index';

const DEFAULT_FINGERPRINT_BYTES = 64 * 1024;

export interface JsonlEngineOptions {
  documentId?: string;
  generation?: string;
  uri?: string;
  readChunkBytes?: number;
  segmentTargetBytes?: number;
  segmentTargetRecords?: number;
  exactCacheSegments?: number;
  maxQueuedOperations?: number;
  maxRecordBytes?: number;
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

export interface GetRowsOptions extends JsonlOperationContext {
  anchorOrdinal?: string | bigint;
  direction?: 'forward' | 'backward';
  limit?: number;
  predicate?: Predicate;
  columns?: ColumnSpec[];
  enricher?: RowEnricher;
  /** Receives each hydrated record without retaining it in the returned page. */
  onHydrated?: (record: { value?: unknown; ref: RecordRef; parseState: ParseState }) => void;
  scanBudget?: RowScanBudget;
}

export interface RowScanBudget {
  maxExaminedRecords?: number;
  maxExaminedBytes?: string | bigint;
  deadlineEpochMs?: number;
}

export interface GetDetailOptions extends JsonlOperationContext {
  enricher?: RowEnricher;
  /** Requests the complete record only when it remains within maxRecordBytes. */
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

interface NormalizedOptions {
  readChunkBytes: number;
  segmentTargetBytes: number;
  segmentTargetRecords: number;
  exactCacheSegments: number;
  maxQueuedOperations: number;
  maxRecordBytes: number;
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

interface SourceFingerprint {
  length: number;
  hash: string;
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

class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly maximumPending: number) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maximumPending) {
      return Promise.reject(new JsonlEngineError(
        'QUEUE_FULL',
        `The JSONL engine already has ${String(this.pending)} pending operations.`,
      ));
    }
    this.pending += 1;
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => { this.pending -= 1; },
      () => { this.pending -= 1; },
    );
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * Read-only, snapshot-bound JSONL engine. The source file is never written and
 * no API returns the complete source. Anchors are exclusive physical cursors.
 */
export class JsonlFileEngine {
  readonly filePath: string;
  readonly snapshot: SnapshotIdentity;

  private readonly executor: SerialExecutor;
  private readonly lifecycleAbort = new AbortController();
  private readonly backgroundControllers = new Set<AbortController>();
  private readonly index: AdaptiveSegmentIndex;
  private readonly schema: ProgressiveSchemaTracker;
  private closing = false;
  private closed = false;

  private constructor(
    filePath: string,
    private readonly handle: FileHandle,
    private readonly fileSize: bigint,
    snapshot: SnapshotIdentity,
    private readonly options: NormalizedOptions,
    private readonly sourceDevice: bigint,
    private readonly sourceInode: bigint,
    private readonly sourceMtimeMs: number,
    private readonly sourceMtimeNs: bigint,
    private readonly prefixFingerprint: SourceFingerprint,
    private readonly tailFingerprint: SourceFingerprint,
  ) {
    this.filePath = filePath;
    this.snapshot = snapshot;
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
    try {
      const sourceStat = await handle.stat({ bigint: true });
      if (!sourceStat.isFile()) {
        throw new JsonlEngineError('NOT_A_FILE', `JSONL source is not a regular file: ${absolutePath}`);
      }

      const prefixLength = Number(sourceStat.size < BigInt(DEFAULT_FINGERPRINT_BYTES)
        ? sourceStat.size
        : BigInt(DEFAULT_FINGERPRINT_BYTES));
      const tailLength = prefixLength;
      const prefixFingerprint = await fingerprintRange(handle, 0n, prefixLength);
      const tailFingerprint = await fingerprintRange(handle, sourceStat.size - BigInt(tailLength), tailLength);
      const generation = options.generation ?? randomUUID();
      const documentId = options.documentId ?? randomUUID();
      const mtimeMs = Number(sourceStat.mtimeMs);
      const snapshot: SnapshotIdentity = {
        documentId,
        generation,
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
        prefixFingerprint,
        tailFingerprint,
      );
    } catch (error) {
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
    return this.enqueue(async () => {
      const guard = this.makeGuard(options);
      guard();
      await this.assertSnapshotUnchanged();
      await this.index.indexMore(options.maxBytes ?? this.options.readChunkBytes, guard);
      await this.assertSnapshotUnchanged();
      return this.getSummary();
    });
  }

  finishIndexing(context: JsonlOperationContext = {}): Promise<DocumentSummary> {
    return this.enqueue(async () => {
      const guard = this.makeGuard(context);
      guard();
      await this.assertSnapshotUnchanged();
      await this.index.finish(guard);
      await this.assertSnapshotUnchanged();
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
        onProgress?.(summary);
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
    return this.enqueue(async () => {
      const guard = this.makeGuard(options);
      guard();
      await this.assertSnapshotUnchanged();
      const limit = boundedInteger(options.limit ?? 100, 1, 500, 'limit');
      const direction = options.direction ?? 'forward';
      const scanBudget = normalizeRowScanBudget(options.scanBudget, direction);
      const anchor = options.anchorOrdinal === undefined
        ? undefined
        : parseNonNegativeBigInt(options.anchorOrdinal, 'anchorOrdinal');
      const collected: Array<{ hydrated: HydratedRecord; profile?: AgentRowProjection }> = [];
      let retainedBytes = 0n;
      let stoppedByBudget = false;
      let stoppedByPageLimit = false;
      let examinedRecords = 0n;
      let examinedBytes = 0n;
      let scanCursor: bigint | undefined;
      let scanTruncatedReason: ScanTruncationReason | undefined;

      if (direction === 'forward') {
        let ordinal = anchor === undefined ? 0n : anchor + 1n;
        const collectionTarget = scanBudget === undefined ? limit + 1 : limit;
        while (collected.length < collectionTarget) {
          guard();
          scanTruncatedReason = scanLimitBeforeNextRecord(
            scanBudget,
            examinedRecords,
            examinedBytes,
          );
          if (scanTruncatedReason !== undefined) break;
          const internal = await this.index.getRecord(ordinal, guard);
          if (internal === undefined) break;
          if (
            scanBudget?.maxExaminedBytes !== undefined
            && examinedBytes + internal.contentByteLength > scanBudget.maxExaminedBytes
          ) {
            scanTruncatedReason = 'byte_limit';
            break;
          }
          const candidate = await this.hydrate(internal, guard);
          options.onHydrated?.({ value: candidate.value, ref: candidate.ref, parseState: candidate.state });
          const profile = candidate.value === undefined
            ? undefined
            : options.enricher?.project(candidate.value, candidate.ref);
          const matches = this.matches(candidate, options.predicate, options.enricher, profile);
          if (matches) {
            if (
              collected.length > 0
              && retainedBytes + candidate.internal.contentByteLength > BigInt(this.options.pageHydrationMaxBytes)
            ) {
              stoppedByBudget = true;
              break;
            }
            collected.push(profile === undefined ? { hydrated: candidate } : { hydrated: candidate, profile });
            retainedBytes += candidate.internal.contentByteLength;
          }
          examinedRecords += 1n;
          examinedBytes += internal.contentByteLength;
          scanCursor = ordinal;
          ordinal += 1n;
        }
        stoppedByPageLimit = scanBudget !== undefined && collected.length >= limit;
      } else {
        let ordinal: bigint;
        if (anchor === undefined) {
          await this.index.finish(guard);
          ordinal = this.index.indexedRecords - 1n;
        } else if (await this.index.ensureOrdinal(anchor, guard)) {
          ordinal = anchor - 1n;
        } else {
          ordinal = this.index.indexedRecords - 1n;
        }

        while (ordinal >= 0n && collected.length <= limit) {
          guard();
          const internal = await this.index.getRecord(ordinal, guard);
          if (internal === undefined) break;
          const candidate = await this.hydrate(internal, guard);
          options.onHydrated?.({ value: candidate.value, ref: candidate.ref, parseState: candidate.state });
          const profile = candidate.value === undefined
            ? undefined
            : options.enricher?.project(candidate.value, candidate.ref);
          if (this.matches(candidate, options.predicate, options.enricher, profile)) {
            if (
              collected.length > 0
              && retainedBytes + candidate.internal.contentByteLength > BigInt(this.options.pageHydrationMaxBytes)
            ) {
              stoppedByBudget = true;
              break;
            }
            collected.push(profile === undefined ? { hydrated: candidate } : { hydrated: candidate, profile });
            retainedBytes += candidate.internal.contentByteLength;
          }
          ordinal -= 1n;
        }
      }

      const hasExtra = collected.length > limit
        || stoppedByBudget
        || stoppedByPageLimit
        || scanTruncatedReason !== undefined;
      let selected = collected.slice(0, limit);
      if (direction === 'backward') selected = selected.reverse();
      const columns = options.columns === undefined
        ? this.defaultColumns(options.enricher?.columns)
        : options.columns.slice(0, this.options.defaultColumnLimit + 1);
      const rows = selected.map(({ hydrated, profile }) => this.projectRow(hydrated, columns, profile));
      const firstOrdinal = selected[0]?.hydrated.internal.ordinal;
      const lastOrdinal = selected[selected.length - 1]?.hydrated.internal.ordinal;
      const total = this.index.totalRecords;

      await this.assertSnapshotUnchanged();

      return {
        rows,
        columns,
        anchorOrdinal: direction === 'forward'
          ? (lastOrdinal ?? anchor ?? 0n).toString()
          : (firstOrdinal ?? anchor ?? 0n).toString(),
        hasBefore: direction === 'backward'
          ? hasExtra
          : firstOrdinal !== undefined && firstOrdinal > 0n,
        hasAfter: direction === 'forward'
          ? hasExtra
          : lastOrdinal !== undefined && (total === undefined || lastOrdinal + 1n < total),
        indexedRecords: this.index.indexedRecords.toString(),
        ...(total === undefined ? {} : { totalRecords: total.toString() }),
        ...(scanBudget === undefined ? {} : {
          scan: {
            examinedRecords: examinedRecords.toString(),
            examinedBytes: examinedBytes.toString(),
            ...(scanCursor === undefined ? {} : { cursorOrdinal: scanCursor.toString() }),
            ...(scanTruncatedReason === undefined ? {} : { truncatedReason: scanTruncatedReason }),
          },
        }),
      };
    });
  }

  getDetail(ref: RecordRef, options: GetDetailOptions = {}): Promise<RecordDetail> {
    return this.enqueue(async () => {
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
      const hydrated = await this.hydrate(internal, guard);
      const profile = hydrated.value === undefined
        ? undefined
        : options.enricher?.project(hydrated.value, hydrated.ref);
      await this.assertSnapshotUnchanged();
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

  getSchema(offset = 0, limit = 100): Promise<{ fields: FieldStats[]; totalFields: number; complete: boolean }> {
    return this.enqueue(async () => {
      this.makeGuard({})();
      const safeOffset = boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
      const safeLimit = boundedInteger(limit, 1, 500, 'limit');
      return this.schema.page(safeOffset, safeLimit, this.index.indexingComplete, this.index.totalRecords);
    });
  }

  classifyRefresh(context: JsonlOperationContext = {}): Promise<SourceRefreshResult> {
    return this.enqueue(async () => {
      const guard = this.makeGuard(context);
      guard();
      const observedAt = new Date().toISOString();
      let currentStat;
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

      if (!currentStat.isFile()) return { kind: 'replace', ...base };
      if (
        this.sourceDevice !== 0n
        && this.sourceInode !== 0n
        && (currentStat.dev !== this.sourceDevice || currentStat.ino !== this.sourceInode)
      ) {
        return { kind: 'replace', ...base };
      }
      if (currentSize < this.fileSize) return { kind: 'truncate', ...base };

      const currentHandle = await open(this.filePath, 'r');
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
      } finally {
        await currentHandle.close();
      }

      if (currentSize > this.fileSize) return { kind: 'append', ...base };
      if (Number(currentStat.mtimeMs) === this.sourceMtimeMs) return { kind: 'unchanged', ...base };
      return { kind: 'unknown', ...base };
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = true;
      this.lifecycleAbort.abort();
      for (const controller of this.backgroundControllers) controller.abort();
      this.backgroundControllers.clear();
    }
    await this.executor.idle();
    if (!this.closed) {
      this.closed = true;
      await this.handle.close();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAccepting();
    return this.executor.run(operation);
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

  private async assertSnapshotUnchanged(): Promise<void> {
    const current = await this.handle.stat({ bigint: true });
    if (current.size === this.fileSize && current.mtimeNs === this.sourceMtimeNs) return;
    if (current.size > this.fileSize) {
      const prefix = await fingerprintRange(this.handle, 0n, this.prefixFingerprint.length);
      const oldTail = await fingerprintRange(
        this.handle,
        this.fileSize - BigInt(this.tailFingerprint.length),
        this.tailFingerprint.length,
      );
      if (
        prefix.hash === this.prefixFingerprint.hash
        && prefix.length === this.prefixFingerprint.length
        && oldTail.hash === this.tailFingerprint.hash
        && oldTail.length === this.tailFingerprint.length
      ) {
        return;
      }
    }
    if (current.size !== this.fileSize || current.mtimeNs !== this.sourceMtimeNs) {
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed after this snapshot opened.');
    }
  }

  private async assertSnapshotMetadataUnchanged(): Promise<void> {
    let pathState;
    try {
      pathState = await stat(this.filePath, { bigint: true });
    } catch {
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source path no longer identifies this snapshot.');
    }
    const handleState = await this.handle.stat({ bigint: true });
    const sameIdentity = pathState.dev === this.sourceDevice && pathState.ino === this.sourceInode;
    const sameOpenFile = pathState.dev === handleState.dev && pathState.ino === handleState.ino;
    const truncated = pathState.size < this.fileSize || handleState.size < this.fileSize;
    const divergentSize = pathState.size !== handleState.size;
    const equalLengthRewrite = handleState.size === this.fileSize && handleState.mtimeNs !== this.sourceMtimeNs;
    if (!sameIdentity || !sameOpenFile || truncated || divergentSize || equalLengthRewrite) {
      throw new JsonlEngineError('SOURCE_CHANGED', 'The JSONL source changed before staged index data could commit.');
    }
  }

  private async hydrate(internal: InternalRecordRef, guard: () => void): Promise<HydratedRecord> {
    guard();
    if (internal.contentByteLength > BigInt(this.options.maxRecordBytes)) {
      internal.parseState = 'oversized';
      const previewLength = Number(internal.contentByteLength < BigInt(this.options.previewBytes)
        ? internal.contentByteLength
        : BigInt(this.options.previewBytes));
      const previewBytes = await this.readExactly(internal.byteStart, previewLength, guard);
      const rawPreview = decodePreview(stripInitialBom(previewBytes, internal.ordinal));
      const ref = this.index.toPublic(internal, this.snapshot.generation);
      const problems: ProblemRef[] = [{
        code: 'OVERSIZED_RECORD',
        message: `Record is ${internal.contentByteLength.toString()} bytes; automatic hydration is capped at ${String(this.options.maxRecordBytes)} bytes.`,
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
    const bytes = await this.readExactly(internal.byteStart, length, guard);
    const hasBom = hasInitialBom(bytes, internal.ordinal);
    const content = stripInitialBom(bytes, internal.ordinal);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
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
      value = JSON.parse(text) as unknown;
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

  private async readExactly(start: bigint, length: number, guard: () => void): Promise<Buffer> {
    if (length === 0) return Buffer.alloc(0);
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      guard();
      const readLength = Math.min(this.options.readChunkBytes, length - offset);
      const { bytesRead } = await this.handle.read(result, offset, readLength, start + BigInt(offset));
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
  ): RowProjection {
    const cells = columns.flatMap((column): CellProjection[] => {
      if (column.source === 'system' && column.id === '$ordinal') {
        const ordinal = hydrated.internal.ordinal;
        return [ordinal <= BigInt(Number.MAX_SAFE_INTEGER)
          ? { columnId: column.id, kind: 'integer', value: Number(ordinal) }
          : { columnId: column.id, kind: 'integer', preview: ordinal.toString() }];
      }
      if (column.source === 'profile') {
        if (profile === undefined) {
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
    const genericSummary = summaryForRecord(hydrated, this.options.rowPreviewCharacters);

    return {
      ref: hydrated.ref,
      ...(hydrated.value === undefined ? {} : { kind: jsonKindOf(hydrated.value) }),
      cells,
      genericSummary,
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
  if (direction !== 'forward') {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'scanBudget is supported only for forward scans.');
  }
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

async function fingerprintRange(handle: FileHandle, start: bigint, length: number): Promise<SourceFingerprint> {
  if (length === 0) return { length: 0, hash: createHash('sha256').digest('hex') };
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + BigInt(offset));
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  return {
    length: offset,
    hash: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex'),
  };
}

function formatFingerprint(fingerprint: SourceFingerprint): string {
  return `sha256:${fingerprint.hash}:${String(fingerprint.length)}`;
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
