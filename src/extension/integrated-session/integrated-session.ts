import type {
  DocumentSummary,
  ColumnSpec,
  FieldStats,
  AnalysisIntentV1,
  InsightSummary,
  ProfileSuggestion,
  ProblemPage,
  RecordDetail,
  RecordRef,
  Predicate,
  RowPage,
  RowProjection,
  DatasetRuntimeProvenanceV1,
  DatasetDetectionStageV1,
  DatasetDetectionTerminalStatusV1,
  DatasetDetectionTerminalV1,
} from '@shared/types';
import {
  JsonlEngineError,
  JsonlFileEngine,
  type BackgroundIndexHandle,
  type NativeNewlineScannerSetting,
  type RowEnricher,
  type SourceRefreshResult,
} from '../../engine';
import { createProfileRegistry, type AgentProfileRegistry, type GenericRecordSample } from '../../profiles';
import type { IJsonlSessionPort, ProblemPageRequest, RecordPageRequest } from '../../application';
import { runInsightQuery } from '../insight-query';
import {
  FollowRecoveryTerminalError,
  FollowRecoveryTransientError,
  type FollowRecoveryIdentity,
} from '../follow/recovery';
import {
  mergeRequestedColumns,
  profileColumns,
  profilePredicateFields,
} from './profile';
import { DatasetHeadInspection, pendingDatasetProvenance, terminalDatasetProvenance } from '@profiles/dataset-runtime';
import { DOCUMENT_GRAPH_LIMIT, DOCUMENT_GRAPH_MAX_BYTES, DOCUMENT_GRAPH_DEADLINE_MS } from '@shared/document-graph';
import { evaluatePredicate } from '@engine/predicate';
import { lookupLineageRecord } from '@application/use-cases/lookup-lineage-record';
import type { LineageLookupRelation, LineageLookupReply } from '@shared/contracts/lineage';
import { LINEAGE_LOOKUP_MAX_BYTES } from '@shared/contracts/lineage';

const DETECTION_HEAD_SAMPLE_LIMIT = 32;
const DETECTION_TAIL_SAMPLE_LIMIT = 32;
const DETECTION_STRATUM_SAMPLE_LIMIT = 8;
const DETECTION_STRATUM_PERCENTAGES = [25n, 50n, 75n] as const;
const DETECTION_MAX_MILLISECONDS = 5_000;

/** Local metadata only; never carries values, paths, fingerprints or free-form errors. */
export interface DatasetDetectionReceipt {
  operationId: number;
  generation: string;
  sourceEpoch: number;
  profileEpoch: number;
  stage: DatasetDetectionStageV1;
  status: Exclude<DatasetRuntimeProvenanceV1['status'], 'pending'>;
  elapsedMs: number;
  code?: DatasetDetectionTerminalV1['code'];
}

export interface IntegratedSessionOptions {
  documentId?: string;
  uri: string;
  autoDetectProfiles?: boolean;
  /** Return a generic shell first and detect the semantic profile after the first page. */
  deferProfileDetection?: boolean;
  maxRecordBytes?: number;
  fullRecordMaxBytes?: number;
  /** Soft aggregate hydration cap for one visible page. */
  pageHydrationMaxBytes?: number;
  newlineScanner?: NativeNewlineScannerSetting;
  backgroundIndexing?: boolean;
  /** Report a non-cancellation background indexing failure without source data. */
  onBackgroundIndexError?: (error: unknown) => void;
  /** Internal operation deadline, clamped to 1..30,000 ms; does not preempt synchronous CPU. */
  profileDetectionMaxMilliseconds?: number;
  onDatasetDetection?: (receipt: DatasetDetectionReceipt) => void;
  insightsMaxExaminedRecords?: number;
  insightsMaxExaminedBytes?: number;
  insightsMaxMilliseconds?: number;
}

export type SummaryListener = (summary: DocumentSummary) => void;
export type FollowModeListener = (enabled: boolean) => void;

interface DetectedProfileState {
  profileId: string;
  suggestions: ProfileSuggestion[];
  datasetProvenance: DatasetRuntimeProvenanceV1;
}

export class IntegratedJsonlSession implements IJsonlSessionPort {
  private readonly filePath: string;
  private readonly options: IntegratedSessionOptions;
  private readonly registry: AgentProfileRegistry;
  private readonly listeners = new Set<SummaryListener>();
  private readonly followListeners = new Set<FollowModeListener>();
  private engine: JsonlFileEngine;
  private profileId = 'generic';
  private profileEpoch = 0;
  private datasetProvenance: DatasetRuntimeProvenanceV1 = pendingDatasetProvenance();
  private suggestions: ProfileSuggestion[] = [];
  private profileExplicitlySelected = false;
  private background: BackgroundIndexHandle | undefined;
  private rebuildInFlight: Promise<DocumentSummary> | undefined;
  private rebuildAbort: AbortController | undefined;
  private rebuildInFlightRequiresStable = false;
  private rebuildExpectedIdentityKey: string | undefined;
  private profileDetectionAbort: AbortController | undefined;
  private profileDetectionInFlight: Promise<void> | undefined;
  private profileDetectionScheduled = false;
  private nextDetectionOperationId = 0;
  private headDetectionGeneration: string | undefined;
  private tailDetectionGeneration: string | undefined;
  private tailDetectionRequested = false;
  private disposed = false;
  private followEnabled = false;

  private constructor(
    filePath: string,
    options: IntegratedSessionOptions,
    engine: JsonlFileEngine,
  ) {
    this.filePath = filePath;
    this.options = options;
    this.engine = engine;
    this.registry = createProfileRegistry();
  }

  public static async open(
    filePath: string,
    options: IntegratedSessionOptions,
    signal?: AbortSignal,
  ): Promise<IntegratedJsonlSession> {
    throwIfAborted(signal);
    const engine = await JsonlFileEngine.open(filePath, {
      ...(options.documentId === undefined ? {} : { documentId: options.documentId }),
      epoch: 0,
      uri: options.uri,
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      ...(options.fullRecordMaxBytes === undefined ? {} : { fullRecordMaxBytes: options.fullRecordMaxBytes }),
      ...(options.pageHydrationMaxBytes === undefined ? {} : { pageHydrationMaxBytes: options.pageHydrationMaxBytes }),
      ...(options.newlineScanner === undefined ? {} : { newlineScanner: options.newlineScanner }),
    });
    const session = new IntegratedJsonlSession(filePath, options, engine);
    try {
      if (options.deferProfileDetection === true && options.autoDetectProfiles !== false) {
        session.publishProfileState({
          profileId: 'generic', suggestions: session.zeroScoreSuggestions(),
          datasetProvenance: pendingDatasetProvenance(),
        });
        return session;
      }
      const detected = await session.detectProfile(engine, signal, {
        includeTail: engine.getSummary().indexingComplete,
      });
      throwIfAborted(signal);
      session.publishProfileState(detected);
      session.headDetectionGeneration = engine.snapshot.generation;
      session.startBackgroundIndexing();
      return session;
    } catch (error) {
      await engine.dispose();
      throw error;
    }
  }

  public get followMode(): boolean {
    return this.followEnabled;
  }

  public getSummary(): DocumentSummary {
    const summary = this.engine.getSummary(this.profileId);
    return {
      ...summary,
      profileVersion: this.registry.version(this.profileId),
      profileEpoch: this.profileEpoch,
      datasetProvenance: this.datasetProvenance,
      profileSuggestions: this.suggestions.map((suggestion) => ({
        ...suggestion,
        reasons: [...suggestion.reasons],
      })),
    };
  }

  /** Columns for the currently selected semantic profile, used for async profile updates. */
  public getProfileColumns(): readonly ColumnSpec[] {
    return profileColumns(this.profileId);
  }

  public async getRows(request: RecordPageRequest, signal: AbortSignal): Promise<RowPage> {
    const enricher = this.createEnricher();
    const page = await this.engine.getRows({
      ...(request.anchorOrdinal === undefined ? {} : { anchorOrdinal: request.anchorOrdinal }),
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      limit: request.limit,
      ...(request.predicate === undefined ? {} : { predicate: request.predicate }),
      ...(request.sort === undefined ? {} : { sort: request.sort }),
      ...(request.sortOffset === undefined ? {} : { sortOffset: request.sortOffset }),
      ...(request.scanBudget === undefined ? {} : { scanBudget: request.scanBudget }),
      ...(request.columns === undefined ? {} : {
        columns: mergeRequestedColumns(enricher.columns ?? [], request.columns),
      }),
      ...(request.projection === undefined ? {} : { projection: request.projection }),
      ...(request.onTiming === undefined ? {} : {
        onTiming: (timing) => request.onTiming?.({
          queueWaitMs: timing.queueWaitMs,
          engineExecMs: timing.engineExecMs,
          queueBlockedBy: timing.queueBlockedBy,
          indexWorkMs: timing.indexWorkMs,
          readWaitMs: timing.readWaitMs,
          readCalls: timing.readCalls,
          readBytes: timing.readBytes,
          readMaxWaitMs: timing.readMaxWaitMs,
          parseMs: timing.parseMs,
          projectionMs: timing.projectionMs,
          snapshotCheckMs: timing.snapshotCheckMs,
        }),
      }),
      enricher,
      generation: this.engine.snapshot.generation,
      signal,
    });
    this.scheduleDeferredProfileDetection();
    return page;
  }

  public async getProblems(request: ProblemPageRequest, signal: AbortSignal): Promise<ProblemPage> {
    return this.engine.getProblems({
      ...(request.anchorOrdinal === undefined ? {} : { anchorOrdinal: request.anchorOrdinal }),
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      limit: request.limit,
      ...(request.scanBudget === undefined ? {} : { scanBudget: request.scanBudget }),
      generation: this.engine.snapshot.generation,
      signal,
    });
  }

  /** Fixed physical ascending prefix; background scheduling never borrows table filters. */
  public getGraphRows(signal: AbortSignal): Promise<RowPage> {
    return this.engine.getObservedBackgroundRows({ limit: DOCUMENT_GRAPH_LIMIT, direction: 'forward', maxReturnedBytes: String(DOCUMENT_GRAPH_MAX_BYTES),
      sort: { columnId: '__ordinal', direction: 'asc' },
      scanBudget: { maxExaminedRecords: DOCUMENT_GRAPH_LIMIT, maxExaminedBytes: String(DOCUMENT_GRAPH_MAX_BYTES),
        deadlineEpochMs: Date.now() + DOCUMENT_GRAPH_DEADLINE_MS },
      projection: { conversation: false, dataset: false }, enricher: this.createEnricher(),
      generation: this.engine.snapshot.generation, signal });
  }

  public lookupLineage(source: RowProjection, relation: LineageLookupRelation, signal: AbortSignal): Promise<LineageLookupReply> {
    const engine = this.engine;
    const enricher = this.createEnricher();
    return lookupLineageRecord(this.getSummary(), source, relation, {
      read: async (startOrdinal, records, deadlineEpochMs, readSignal, progress) => {
        let uninspectable = false;
        const page = await engine.getObservedBackgroundRows({
          ...(startOrdinal === '0' ? {} : { anchorOrdinal: String(BigInt(startOrdinal) - 1n) }),
          direction: 'forward', limit: records, columns: [], projection: { conversation: false, dataset: false },
          maxReturnedBytes: String(LINEAGE_LOOKUP_MAX_BYTES),
          scanBudget: { maxExaminedRecords: records, maxExaminedBytes: String(LINEAGE_LOOKUP_MAX_BYTES), deadlineEpochMs },
          onObservedReadRequest: (bytes) => { progress.requestedBytes += bytes; },
          onHydrated: ({ ref, value, parseState }) => {
            progress.examinedRecords += 1;
            progress.examinedBytes = String(BigInt(progress.examinedBytes) + BigInt(ref.contentByteLength));
            if (value === undefined && parseState !== 'blank') uninspectable = true;
          },
          enricher, generation: source.ref.generation, signal: readSignal,
        });
        return uninspectable ? { ...page, scan: { examinedRecords: String(progress.examinedRecords), examinedBytes: progress.examinedBytes,
          ...page.scan, truncatedReason: 'uninspectable_record' } } : page;
      },
    }, signal);
  }

  public async getDetail(
    ref: RecordRef,
    full: boolean,
    signal: AbortSignal,
  ): Promise<RecordDetail> {
    return this.engine.getDetail(ref, {
      full,
      enricher: this.createEnricher(),
      generation: this.engine.snapshot.generation,
      signal,
    });
  }

  public async getSchema(
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<{ fields: FieldStats[]; totalFields: number; complete: boolean }> {
    throwIfAborted(signal);
    const engine = this.engine;
    const result = await engine.getSchema(offset, limit, {
      generation: engine.snapshot.generation,
      signal,
    });
    throwIfAborted(signal);
    return result;
  }

  /** Host-only complete text read; never transported into the Webview. */
  public getRecordText(ref: RecordRef, maxBytes: number): Promise<{ sourceGeneration: string; text: string; complete: boolean }> {
    return this.engine.getRecordText(ref, maxBytes);
  }

  public async getInsights(
    intent: AnalysisIntentV1,
    signal: AbortSignal,
  ): Promise<InsightSummary> {
    throwIfAborted(signal);
    const engine = this.engine;
    const generation = engine.snapshot.generation;
    const enricher = this.createEnricher();
    return runInsightQuery({
      source: { getRows: (options) => engine.getBackgroundRows(options) },
      generation,
      enricher,
      intent,
      signal,
      limits: {
        maxExaminedRecords: this.options.insightsMaxExaminedRecords,
        maxExaminedBytes: this.options.insightsMaxExaminedBytes,
        maxMilliseconds: this.options.insightsMaxMilliseconds,
      },
    });
  }

  public async setProfile(profileId: string, signal: AbortSignal): Promise<DocumentSummary> {
    throwIfAborted(signal);
    if (!this.registry.list().some((profile) => profile.id === profileId)) {
      throw new Error(`Unknown Agent profile: ${profileId}`);
    }
    if (!this.publishProfileState({
      profileId, suggestions: this.suggestions, datasetProvenance: this.datasetProvenance,
    })) {
      throw new Error('Profile publication epoch limit reached; rebuild the document before changing its profile.');
    }
    this.profileExplicitlySelected = true;
    return this.getSummary();
  }

  public async setFollowMode(enabled: boolean): Promise<DocumentSummary> {
    if (this.followEnabled === enabled) return this.getSummary();
    this.followEnabled = enabled;
    for (const listener of this.followListeners) listener(enabled);
    return this.getSummary();
  }

  public onFollowMode(listener: FollowModeListener): () => void {
    this.followListeners.add(listener);
    return () => this.followListeners.delete(listener);
  }

  public rebuild(signal: AbortSignal): Promise<DocumentSummary> {
    return this.startRebuild(signal);
  }

  /**
   * Reopen only when the path still identifies the same file and the newly
   * opened engine observes no further change. A rejected candidate is
   * disposed by performRebuild; the current generation remains untouched.
   */
  public rebuildStable(
    expected: FollowRecoveryIdentity,
    signal: AbortSignal,
  ): Promise<DocumentSummary> {
    return this.startRebuild(signal, { expected, requireStable: true });
  }

  public validateObservedSource(signal?: AbortSignal): Promise<boolean> {
    return this.engine.validateObservedSource({
      generation: this.engine.snapshot.generation,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public classifyRefresh(signal?: AbortSignal): Promise<SourceRefreshResult> {
    return this.engine.classifyRefresh({
      generation: this.engine.snapshot.generation,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public onProgress(listener: SummaryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rebuildAbort?.abort();
    this.profileDetectionAbort?.abort();
    this.background?.cancel();
    this.background = undefined;
    this.listeners.clear();
    this.followListeners.clear();
    await this.engine.dispose();
  }

  private startRebuild(
    signal: AbortSignal,
    options: { expected?: FollowRecoveryIdentity; requireStable?: boolean } = {},
  ): Promise<DocumentSummary> {
    if (signal.aborted) return Promise.reject(new Error('Operation cancelled.'));
    const requireStable = options.requireStable === true;
    const expectedKey = options.expected === undefined ? undefined : identityKey(options.expected);
    const waitForExisting = this.rebuildInFlight !== undefined
      && (
        (requireStable && (
          !this.rebuildInFlightRequiresStable
          || this.rebuildExpectedIdentityKey !== expectedKey
        ))
        || (!requireStable && this.rebuildInFlightRequiresStable)
      );
    if (waitForExisting) {
      // A stable recovery must never share a normal rebuild (and vice versa),
      // because the caller's cancellation/identity proof belongs to one
      // operation. Continue after either outcome; the next invocation will
      // re-check the source identity before adoption.
      return waitForOperation(this.rebuildInFlight!, signal)
        .catch(() => undefined)
        .then(() => this.startRebuild(signal, options));
    }
    if (this.rebuildInFlight === undefined) {
      const controller = new AbortController();
      this.rebuildAbort = controller;
      this.rebuildInFlightRequiresStable = requireStable;
      this.rebuildExpectedIdentityKey = expectedKey;
      const unlinkCallerAbort = requireStable
        ? linkAbort(signal, controller)
        : undefined;
      const operation = this.performRebuild(controller.signal, options).finally(() => {
        unlinkCallerAbort?.();
        if (this.rebuildInFlight === operation) {
          this.rebuildInFlight = undefined;
          this.rebuildAbort = undefined;
          this.rebuildInFlightRequiresStable = false;
          this.rebuildExpectedIdentityKey = undefined;
        }
      });
      this.rebuildInFlight = operation;
    }
    return waitForOperation(this.rebuildInFlight, signal);
  }

  private async performRebuild(
    signal: AbortSignal,
    options: { expected?: FollowRecoveryIdentity; requireStable?: boolean } = {},
  ): Promise<DocumentSummary> {
    throwIfAborted(signal);
    this.profileDetectionAbort?.abort();
    const previous = this.engine;
    if (options.expected !== undefined) {
      if (!sameExpectedSnapshot(previous.getSummary().snapshot, options.expected)) {
        throw new FollowRecoveryTerminalError('replace');
      }
      // A large generation may have deferred its O(n) original-range
      // fingerprint. In that case asking it to prove append-only growth can
      // never succeed after the first write: the old baseline is unknowable.
      // The follow coordinator has already required same-file, growing,
      // quiet probes; the newly opened candidate below performs an
      // independent stable full-resync check. Use the old proof when it is
      // available, but do not turn a deferred baseline into a retry deadlock.
      if (previous.canValidateOriginalSnapshot) {
        const before = await previous.classifyRefresh({
          generation: options.expected.generation,
          signal,
        });
        throwIfAborted(signal);
        switch (before.kind) {
          case 'truncate':
            throw new FollowRecoveryTerminalError('truncate');
          case 'replace':
          case 'delete':
            throw new FollowRecoveryTerminalError(before.kind);
          case 'unknown':
            throw new FollowRecoveryTransientError('The source is still moving; stable baseline is not available yet.');
          case 'append':
          case 'unchanged':
            break;
        }
      }
    }
    let next: JsonlFileEngine;
    try {
      next = await JsonlFileEngine.open(this.filePath, {
        documentId: previous.snapshot.documentId,
        epoch: (previous.snapshot.epoch ?? 0) + 1,
        uri: this.options.uri,
        ...(this.options.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.options.maxRecordBytes }),
        ...(this.options.fullRecordMaxBytes === undefined ? {} : { fullRecordMaxBytes: this.options.fullRecordMaxBytes }),
        ...(this.options.pageHydrationMaxBytes === undefined ? {} : { pageHydrationMaxBytes: this.options.pageHydrationMaxBytes }),
        ...(this.options.newlineScanner === undefined ? {} : { newlineScanner: this.options.newlineScanner }),
      });
    } catch (error) {
      if (options.requireStable === true) throw normalizeStableRebuildError(error);
      throw error;
    }
    let adopted = false;
    try {
      if (options.expected !== undefined && !sameFileIdentity(next.getSummary().snapshot, options.expected)) {
        throw new FollowRecoveryTerminalError('replace');
      }
      if (options.expected !== undefined) {
        const expectedSize = parseSize(options.expected.sizeBytes);
        if (BigInt(next.snapshot.sizeBytes) < expectedSize) {
          throw new FollowRecoveryTerminalError('truncate');
        }
      }
      const detected = await this.detectProfile(next, signal, {
        includeTail: next.getSummary().indexingComplete,
      });
      throwIfAborted(signal);
      if (options.requireStable === true) {
        if (options.expected !== undefined && previous.canValidateOriginalSnapshot) {
          const oldRefresh = await previous.classifyRefresh({
            generation: options.expected.generation,
            signal,
          });
          throwIfAborted(signal);
          if (oldRefresh.kind === 'truncate') throw new FollowRecoveryTerminalError('truncate');
          if (oldRefresh.kind === 'replace' || oldRefresh.kind === 'delete') {
            throw new FollowRecoveryTerminalError(oldRefresh.kind);
          }
          if (oldRefresh.kind === 'unknown') {
            throw new FollowRecoveryTransientError('The source moved while the candidate was opening.');
          }
        }
        const refresh = await next.classifyRefresh({
          generation: next.snapshot.generation,
          signal,
        });
        if (refresh.kind !== 'unchanged') {
          if (refresh.kind === 'delete' || refresh.kind === 'replace' || refresh.kind === 'truncate') {
            throw new FollowRecoveryTerminalError(refresh.kind);
          }
          throw new FollowRecoveryTransientError(`Candidate source is still moving (${refresh.kind}).`);
        }
      }
      this.background?.cancel();
      this.background = undefined;
      throwIfAborted(signal);
      if (options.expected !== undefined && !sameExpectedSnapshot(this.engine.getSummary().snapshot, options.expected)) {
        throw new FollowRecoveryTerminalError('replace');
      }
      const nextProfileId = this.profileExplicitlySelected ? this.profileId : detected.profileId;
      this.engine = next;
      this.publishProfileState({ ...detected, profileId: nextProfileId }, true);
      this.headDetectionGeneration = next.snapshot.generation;
      adopted = true;
      this.startBackgroundIndexing();
      void previous.dispose().catch(() => undefined);
      return this.getSummary();
    } catch (error) {
      if (!adopted) await next.dispose();
      throw options.requireStable === true ? normalizeStableRebuildError(error) : error;
    }
  }

  private async detectProfile(
    engine: JsonlFileEngine,
    signal?: AbortSignal,
    options: { includeTail?: boolean } = {},
  ): Promise<DetectedProfileState> {
    const startedAt = performance.now();
    const operationId = Math.min(Number.MAX_SAFE_INTEGER, this.nextDetectionOperationId + 1);
    this.nextDetectionOperationId = operationId;
    const profileEpoch = this.profileEpoch;
    let stage: DatasetDetectionStageV1 = 'not-started';
    const terminalState = (status: DatasetDetectionTerminalStatusV1): DetectedProfileState => ({
      profileId: 'generic', suggestions: this.zeroScoreSuggestions(),
      datasetProvenance: terminalDatasetProvenance(status, stage),
    });
    let result: DetectedProfileState;
    if (this.options.autoDetectProfiles === false) {
      result = terminalState('disabled');
    } else {
      const requested = this.options.profileDetectionMaxMilliseconds ?? DETECTION_MAX_MILLISECONDS;
      const maxMilliseconds = Number.isFinite(requested)
        ? Math.max(1, Math.min(30_000, Math.floor(requested))) : DETECTION_MAX_MILLISECONDS;
      const controller = new AbortController();
      let interruptedState: DetectedProfileState | undefined;
      let interrupt!: (state: DetectedProfileState) => void;
      const interrupted = new Promise<DetectedProfileState>((resolve) => { interrupt = resolve; });
      const stop = (status: 'timeout' | 'cancelled'): void => {
        if (interruptedState !== undefined) return;
        interruptedState = terminalState(status);
        interrupt(interruptedState);
        controller.abort();
      };
      const cancel = (): void => stop('cancelled');
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => stop('timeout'), maxMilliseconds);
      timer.unref();
      try {
        if (signal?.aborted) cancel();
        result = controller.signal.aborted ? interruptedState! : await Promise.race([
          this.inspectProfile(engine, controller.signal, options, (next) => { stage = next; }),
          interrupted,
        ]);
        if (interruptedState !== undefined) result = interruptedState;
        else if (performance.now() - startedAt >= maxMilliseconds) {
          stop('timeout');
          result = interruptedState!;
        }
      } catch {
        result = interruptedState ?? terminalState('failed');
        controller.abort();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    }
    const provenance = result.datasetProvenance;
    if (provenance.status !== 'pending') {
      try {
        this.options.onDatasetDetection?.({
          operationId, generation: engine.snapshot.generation, sourceEpoch: engine.snapshot.epoch ?? 0,
          profileEpoch, stage, status: provenance.status,
          elapsedMs: Math.min(2_147_483_647, Math.max(0, Math.round(performance.now() - startedAt))),
          ...('terminal' in provenance ? { code: provenance.terminal.code } : {}),
        });
      } catch {
        // Observability cannot turn optional detection into a document failure.
      }
    }
    return result;
  }

  private async inspectProfile(
    engine: JsonlFileEngine, signal: AbortSignal, options: { includeTail?: boolean },
    setStage: (stage: DatasetDetectionStageV1) => void,
  ): Promise<DetectedProfileState> {
    setStage('head-hydration');
    const samples: GenericRecordSample[] = [];
    const datasetHead = new DatasetHeadInspection();
    const sampledOrdinals = new Set<string>();
    const headPage = await engine.inspectBackgroundRows({
      limit: DETECTION_HEAD_SAMPLE_LIMIT,
      generation: engine.snapshot.generation,
      onHydrated: (record) => {
        if (signal.aborted) return;
        datasetHead.accept(record);
        appendDetectionSample(
          samples,
          sampledOrdinals,
          record,
          this.filePath,
          DETECTION_HEAD_SAMPLE_LIMIT,
        );
      },
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    setStage('head-inspection');
    const datasetProvenance = datasetHead.finish(headPage, engine.getSummary().indexingComplete);
    // Once the physical index is complete, add a bounded newest suffix. This
    // catches files whose producer changes shape over time without forcing an
    // O(n) tail scan on the first paint. The registry still applies its own
    // sample cap and confidence rules.
    if (options.includeTail === true && engine.getSummary().indexingComplete) {
      setStage('profile-sampling');
      await engine.inspectBackgroundRows({
        direction: 'backward',
        limit: DETECTION_TAIL_SAMPLE_LIMIT,
        scanBudget: {
          maxExaminedRecords: DETECTION_TAIL_SAMPLE_LIMIT,
          maxExaminedBytes: String(8 * 1024 * 1024),
          deadlineEpochMs: Date.now() + 2_000,
        },
        generation: engine.snapshot.generation,
        onHydrated: (record) => {
          if (signal.aborted) return;
          appendDetectionSample(
            samples,
            sampledOrdinals,
            record,
            this.filePath,
            DETECTION_HEAD_SAMPLE_LIMIT + DETECTION_TAIL_SAMPLE_LIMIT,
          );
        },
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      // A head/tail-only probe can miss a producer schema transition in the
      // middle of a long file. Three small ordinal windows add coverage while
      // keeping random reads and hydration strictly bounded.
      const totalRecords = BigInt(engine.getSummary().indexedRecords);
      for (const percentage of DETECTION_STRATUM_PERCENTAGES) {
        if (totalRecords < 2n) break;
        const center = (totalRecords * percentage) / 100n;
        const anchor = center > 0n ? center - 1n : undefined;
        await engine.inspectBackgroundRows({
          ...(anchor === undefined ? {} : { anchorOrdinal: anchor.toString() }),
          direction: 'forward',
          limit: DETECTION_STRATUM_SAMPLE_LIMIT,
          scanBudget: {
            maxExaminedRecords: DETECTION_STRATUM_SAMPLE_LIMIT,
            maxExaminedBytes: String(2 * 1024 * 1024),
            deadlineEpochMs: Date.now() + 500,
          },
          generation: engine.snapshot.generation,
          onHydrated: (record) => {
            if (signal.aborted) return;
            appendDetectionSample(
              samples,
              sampledOrdinals,
              record,
              this.filePath,
              DETECTION_HEAD_SAMPLE_LIMIT + DETECTION_TAIL_SAMPLE_LIMIT + DETECTION_STRATUM_PERCENTAGES.length * DETECTION_STRATUM_SAMPLE_LIMIT,
            );
          },
          ...(signal === undefined ? {} : { signal }),
        });
        throwIfAborted(signal);
      }
    }
    throwIfAborted(signal);
    setStage('profile-classification');
    const decision = this.registry.detect(samples);
    const suggested = new Map(decision.suggestions.map((item) => [item.id, item]));
    const detected = new Map(decision.detections.map((item) => [item.profileId, item]));
    const suggestions = this.registry.list()
      .filter((profile) => profile.id !== 'generic')
      .map((profile) => {
        const direct = suggested.get(profile.id);
        const detection = detected.get(profile.id);
        return {
          id: profile.id,
          displayName: profile.displayName,
          score: direct?.score ?? detection?.score ?? 0,
          reasons: direct?.reasons ?? detection?.reasons.map((reason) => reason.observation) ?? [],
        };
      })
      .sort((left, right) => right.score - left.score || left.displayName.localeCompare(right.displayName));
    return { profileId: decision.selectedProfileId, suggestions, datasetProvenance };
  }

  private zeroScoreSuggestions(): ProfileSuggestion[] {
    return this.registry.list()
      .filter((profile) => profile.id !== 'generic')
      .map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        score: 0,
        reasons: [],
      }));
  }

  /** One publication path binds selection, metadata and its ordering epoch. */
  private publishProfileState(state: DetectedProfileState, newSnapshot = false): boolean {
    if (this.profileEpoch >= Number.MAX_SAFE_INTEGER && !newSnapshot) return false;
    this.profileId = state.profileId;
    this.suggestions = state.suggestions;
    this.datasetProvenance = state.datasetProvenance;
    this.profileEpoch = newSnapshot && this.profileEpoch >= Number.MAX_SAFE_INTEGER
      ? 1 : nextProfileEpoch(this.profileEpoch);
    return true;
  }

  private scheduleDeferredProfileDetection(): void {
    if (
      this.options.deferProfileDetection !== true
      || this.options.autoDetectProfiles === false
      || this.profileDetectionScheduled
      || this.profileDetectionInFlight !== undefined
      || this.disposed
    ) return;
    this.profileDetectionScheduled = true;
    setImmediate(() => {
      this.profileDetectionScheduled = false;
      this.startDeferredProfileDetection();
      this.startBackgroundIndexing();
    });
  }

  private startDeferredProfileDetection(forceRetry = false): void {
    if (
      this.options.autoDetectProfiles === false
      || this.disposed
      || this.profileEpoch >= Number.MAX_SAFE_INTEGER
    ) return;
    if (this.profileDetectionInFlight !== undefined) {
      if (
        this.engine.getSummary().indexingComplete
        && this.tailDetectionGeneration !== this.engine.snapshot.generation
      ) this.tailDetectionRequested = true;
      return;
    }
    const engine = this.engine;
    const capturedDocumentId = engine.snapshot.documentId;
    const generation = engine.snapshot.generation;
    const capturedSnapshotEpoch = engine.snapshot.epoch;
    const capturedProfileId = this.profileId;
    const capturedProfileVersion = this.registry.version(capturedProfileId);
    const capturedProfileEpoch = this.profileEpoch;
    const capturedFingerprint = engine.snapshot.prefixFingerprint;
    const complete = engine.getSummary().indexingComplete;
    const includeTail = complete && this.tailDetectionGeneration !== generation;
    if (!forceRetry && !includeTail && this.headDetectionGeneration === generation && !this.tailDetectionRequested) return;
    if (!includeTail && this.options.deferProfileDetection !== true) return;
    if (includeTail) {
      this.tailDetectionGeneration = generation;
      this.tailDetectionRequested = false;
    }
    const controller = new AbortController();
    this.profileDetectionAbort = controller;
    const operation = this.detectProfile(engine, controller.signal, { includeTail })
      .then((detected) => {
        if (this.profileEpoch >= Number.MAX_SAFE_INTEGER) return;
        if (
          controller.signal.aborted
          || this.disposed
          || this.engine !== engine
          || this.engine.snapshot.documentId !== capturedDocumentId
          || this.engine.snapshot.generation !== generation
          || this.engine.snapshot.epoch !== capturedSnapshotEpoch
          || this.engine.snapshot.prefixFingerprint !== capturedFingerprint
          || this.profileId !== capturedProfileId
          || this.registry.version(this.profileId) !== capturedProfileVersion
          || this.profileEpoch !== capturedProfileEpoch
        ) {
          this.tailDetectionRequested = true;
          return;
        }
        const nextProfileId = this.profileExplicitlySelected ? this.profileId : detected.profileId;
        if ('terminal' in detected.datasetProvenance) {
          // A failed optional detector must not restart on every visible page.
          this.tailDetectionGeneration = generation;
          this.tailDetectionRequested = false;
        }
        if (!this.publishProfileState({ ...detected, profileId: nextProfileId })) return;
        this.headDetectionGeneration = generation;
        const summary = this.getSummary();
        for (const listener of this.listeners) listener(summary);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.profileDetectionInFlight === operation) {
          this.profileDetectionInFlight = undefined;
          this.profileDetectionAbort = undefined;
          if (this.tailDetectionRequested && !this.disposed) {
            this.tailDetectionRequested = false;
            setImmediate(() => this.startDeferredProfileDetection(true));
          }
        }
      });
    this.profileDetectionInFlight = operation;
  }

  /** Capture the same profile projection and predicate semantics used by GET_ROWS. */
  public captureRawExportMatcher(predicate: Predicate): (value: unknown, ref: RecordRef) => boolean {
    const enricher = this.createEnricher();
    return (value, ref) => {
      const profile = enricher.project(value, ref);
      const profileFields = enricher.predicateFields?.(profile, value, ref);
      return evaluatePredicate(predicate, value, profileFields === undefined ? {} : { profileFields });
    };
  }

  private createEnricher(): RowEnricher {
    const profileId = this.profileId;
    const generation = this.engine.snapshot.generation;
    return {
      profileId,
      columns: profileColumns(profileId),
      project: (value, ref) => this.registry.project(profileId, { value, ref }, { generation }),
      predicateFields: (projection) => projection === undefined ? {} : profilePredicateFields(projection),
    };
  }

  private startBackgroundIndexing(): void {
    if (this.options.backgroundIndexing === false || this.disposed || this.background !== undefined) return;
    const engine = this.engine;
    this.background = engine.startBackgroundIndexing((summary) => {
      if (this.engine !== engine || this.disposed) return;
      const current = this.getSummary();
      for (const listener of this.listeners) listener(current);
      if (summary.indexingComplete) this.startDeferredProfileDetection();
    }, { generation: engine.snapshot.generation });
    void this.background.done.catch((error: unknown) => {
      try {
        this.options.onBackgroundIndexError?.(error);
      } catch {
        // Diagnostic callbacks cannot make the indexing failure unhandled.
      }
    });
  }
}

function appendDetectionSample(
  samples: GenericRecordSample[],
  sampledOrdinals: Set<string>,
  record: { value?: unknown; ref: { ordinal: string }; parseState: import('@shared/types').ParseState },
  sourcePathHint: string,
  limit: number,
): void {
  if (samples.length >= limit || sampledOrdinals.has(record.ref.ordinal)) return;
  sampledOrdinals.add(record.ref.ordinal);
  // Keep invalid physical rows in the denominator. Specialized profiles can
  // reject them while still seeing the producer path and corpus integrity.
  samples.push({
    value: record.value,
    ordinal: record.ref.ordinal,
    parseState: record.parseState,
    sourcePathHint,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error('Operation cancelled.');
  }
}

export function nextProfileEpoch(current: number): number {
  return current >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : current + 1;
}

function identityKey(identity: FollowRecoveryIdentity): string {
  return [identity.documentId, identity.uri, identity.generation, identity.epoch ?? '', identity.sizeBytes, identity.device ?? '', identity.inode ?? ''].join('|');
}

function parseSize(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new FollowRecoveryTerminalError('replace');
  }
  return BigInt(value);
}

function linkAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = (): void => target.abort();
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function normalizeStableRebuildError(error: unknown): Error {
  if (error instanceof FollowRecoveryTerminalError || error instanceof FollowRecoveryTransientError) {
    return error;
  }
  if (error instanceof JsonlEngineError) {
    if (error.code === 'ABORTED' || error.code === 'DISPOSED') return error;
    if (error.code === 'NOT_A_FILE') return new FollowRecoveryTerminalError('replace');
    if (error.code === 'SOURCE_CHANGED' || error.code === 'UNEXPECTED_EOF') {
      return new FollowRecoveryTransientError(error.message);
    }
    return error;
  }
  if (isNodeErrorLike(error)) {
    if (error.code === 'ENOENT') return new FollowRecoveryTerminalError('delete');
    if (
      error.code === 'EBUSY'
      || error.code === 'EAGAIN'
      || error.code === 'ETXTBSY'
      || error.code === 'EACCES'
      || error.code === 'EPERM'
    ) {
      return new FollowRecoveryTransientError(error.message);
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeErrorLike(error: unknown): error is { code: string; message: string } {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string';
}

function sameFileIdentity(
  snapshot: DocumentSummary['snapshot'],
  expected: FollowRecoveryIdentity,
): boolean {
  if (snapshot.documentId !== expected.documentId || snapshot.uri !== expected.uri) return false;
  // A stable follow run must be able to prove identity. Falling back to a
  // path-only comparison would allow a delete/recreate race to be followed.
  if (
    expected.device === undefined
    || expected.inode === undefined
    || snapshot.device === undefined
    || snapshot.inode === undefined
  ) return false;
  return snapshot.device === expected.device && snapshot.inode === expected.inode;
}

function sameExpectedSnapshot(
  snapshot: DocumentSummary['snapshot'],
  expected: FollowRecoveryIdentity,
): boolean {
  return snapshot.generation === expected.generation && snapshot.epoch === expected.epoch && sameFileIdentity(snapshot, expected);
}

function waitForOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Operation cancelled.'));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const onAbort = (): void => rejectOperation(new Error('Operation cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(resolveOperation, rejectOperation).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
