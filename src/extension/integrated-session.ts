import type {
  DocumentSummary,
  ColumnSpec,
  FieldStats,
  InsightDimension,
  InsightSummary,
  JsonScalar,
  ProfileSuggestion,
  ProblemPage,
  RecordDetail,
  RecordRef,
  RowPage,
  RowScanBudget,
  ScanTruncationReason,
} from '../shared/types';
import { CategoricalAggregator, TimeBucketAggregator } from '../aggregation';
import {
  JsonlEngineError,
  JsonlFileEngine,
  type BackgroundIndexHandle,
  type NativeNewlineScannerSetting,
  type RowEnricher,
  type SourceRefreshResult,
} from '../engine';
import { createProfileRegistry, type AgentProfileRegistry, type GenericRecordSample } from '../profiles';
import type { JsonlSessionPort, ProblemsRequest, RowsRequest } from './document-controller';
import {
  FollowRecoveryTerminalError,
  FollowRecoveryTransientError,
  type FollowRecoveryIdentity,
} from './follow-recovery';

const DETECTION_HEAD_SAMPLE_LIMIT = 32;
const DETECTION_TAIL_SAMPLE_LIMIT = 32;
const DETECTION_STRATUM_SAMPLE_LIMIT = 8;
const DETECTION_STRATUM_PERCENTAGES = [25n, 50n, 75n] as const;
const PROGRESS_THROTTLE_MS = 100;
const INSIGHT_PAGE_SIZE = 500;
const INSIGHT_BUCKET_WIDTH_MS = 5 * 60 * 1_000;
const DEFAULT_INSIGHT_MAX_EXAMINED_RECORDS = 100_000;
const DEFAULT_INSIGHT_MAX_EXAMINED_BYTES = 64 * 1024 * 1024;
const DEFAULT_INSIGHT_MAX_MILLISECONDS = 5_000;
const HARD_INSIGHT_MAX_EXAMINED_RECORDS = 1_000_000;
const HARD_INSIGHT_MAX_EXAMINED_BYTES = 512 * 1024 * 1024;
const HARD_INSIGHT_MAX_MILLISECONDS = 60_000;

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
  insightsMaxExaminedRecords?: number;
  insightsMaxExaminedBytes?: number;
  insightsMaxMilliseconds?: number;
}

export type SummaryListener = (summary: DocumentSummary) => void;
export type FollowModeListener = (enabled: boolean) => void;

interface DetectedProfileState {
  profileId: string;
  suggestions: ProfileSuggestion[];
}

export class IntegratedJsonlSession implements JsonlSessionPort {
  private readonly registry: AgentProfileRegistry;
  private readonly listeners = new Set<SummaryListener>();
  private readonly followListeners = new Set<FollowModeListener>();
  private engine: JsonlFileEngine;
  private profileId = 'generic';
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
  private tailDetectionGeneration: string | undefined;
  private tailDetectionRequested = false;
  private lastProgressAt = 0;
  private disposed = false;
  private followEnabled = false;

  private constructor(
    private readonly filePath: string,
    private readonly options: IntegratedSessionOptions,
    engine: JsonlFileEngine,
  ) {
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
        session.suggestions = session.zeroScoreSuggestions();
        return session;
      }
      const detected = await session.detectProfile(engine, signal, {
        includeTail: engine.getSummary().indexingComplete,
      });
      session.profileId = detected.profileId;
      session.suggestions = detected.suggestions;
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

  public async getRows(request: RowsRequest, signal: AbortSignal): Promise<RowPage> {
    const page = await this.engine.getRows({
      ...(request.anchorOrdinal === undefined ? {} : { anchorOrdinal: request.anchorOrdinal }),
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      limit: request.limit,
      ...(request.predicate === undefined ? {} : { predicate: request.predicate }),
      ...(request.sort === undefined ? {} : { sort: request.sort }),
      ...(request.sortOffset === undefined ? {} : { sortOffset: request.sortOffset }),
      ...(request.scanBudget === undefined ? {} : { scanBudget: request.scanBudget }),
      enricher: this.createEnricher(),
      generation: this.engine.snapshot.generation,
      signal,
    });
    this.scheduleDeferredProfileDetection();
    return page;
  }

  public async getProblems(request: ProblemsRequest, signal: AbortSignal): Promise<ProblemPage> {
    return this.engine.getProblems({
      ...(request.anchorOrdinal === undefined ? {} : { anchorOrdinal: request.anchorOrdinal }),
      ...(request.direction === undefined ? {} : { direction: request.direction }),
      limit: request.limit,
      ...(request.scanBudget === undefined ? {} : { scanBudget: request.scanBudget }),
      generation: this.engine.snapshot.generation,
      signal,
    });
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

  public async getInsights(
    dimension: InsightDimension,
    predicate: import('../shared/types').Predicate | undefined,
    signal: AbortSignal,
  ): Promise<InsightSummary> {
    throwIfAborted(signal);
    const engine = this.engine;
    const generation = engine.snapshot.generation;
    const enricher = this.createEnricher();
    const categories = new CategoricalAggregator({
      selector: { kind: 'common', dimension },
      signal,
    });
    const time = new TimeBucketAggregator({
      bucketWidthMs: INSIGHT_BUCKET_WIDTH_MS,
      maxBuckets: 64,
      signal,
    });
    let anchorOrdinal: string | undefined;
    let examinedRecords = 0n;
    let examinedBytes = 0n;
    let truncatedReason: ScanTruncationReason | undefined;
    const maxExaminedRecords = boundedInsightLimit(
      this.options.insightsMaxExaminedRecords,
      DEFAULT_INSIGHT_MAX_EXAMINED_RECORDS,
      HARD_INSIGHT_MAX_EXAMINED_RECORDS,
      'insightsMaxExaminedRecords',
    );
    const maxExaminedBytes = boundedInsightLimit(
      this.options.insightsMaxExaminedBytes,
      DEFAULT_INSIGHT_MAX_EXAMINED_BYTES,
      HARD_INSIGHT_MAX_EXAMINED_BYTES,
      'insightsMaxExaminedBytes',
    );
    const maxMilliseconds = boundedInsightLimit(
      this.options.insightsMaxMilliseconds,
      DEFAULT_INSIGHT_MAX_MILLISECONDS,
      HARD_INSIGHT_MAX_MILLISECONDS,
      'insightsMaxMilliseconds',
    );
    const deadlineEpochMs = Date.now() + maxMilliseconds;

    while (true) {
      throwIfAborted(signal);
      const remainingRecords = BigInt(maxExaminedRecords) - examinedRecords;
      const remainingBytes = BigInt(maxExaminedBytes) - examinedBytes;
      if (remainingRecords <= 0n) {
        truncatedReason = 'record_limit';
        break;
      }
      if (remainingBytes <= 0n) {
        truncatedReason = 'byte_limit';
        break;
      }
      const page = await engine.getRows({
        ...(anchorOrdinal === undefined ? {} : { anchorOrdinal }),
        limit: INSIGHT_PAGE_SIZE,
        ...(predicate === undefined ? {} : { predicate }),
        enricher,
        generation,
        signal,
        scanBudget: {
          maxExaminedRecords: Number(remainingRecords),
          maxExaminedBytes: remainingBytes,
          deadlineEpochMs,
        },
      });
      const scan = page.scan;
      if (scan === undefined) {
        throw new Error('The JSONL engine did not return scan accounting for an Insights request.');
      }
      examinedRecords += BigInt(scan.examinedRecords);
      examinedBytes += BigInt(scan.examinedBytes);
      let continueScanning = true;
      for (const row of page.rows) {
        if (!categories.add(row) || !time.add(row)) {
          continueScanning = false;
          truncatedReason = 'record_limit';
          break;
        }
      }
      if (!continueScanning) break;
      if (scan.truncatedReason !== undefined) {
        truncatedReason = scan.truncatedReason;
        break;
      }
      if (!page.hasAfter) break;
      if (scan.cursorOrdinal === undefined || scan.examinedRecords === '0') {
        throw new Error('The JSONL engine returned a non-progressing Insights cursor.');
      }
      anchorOrdinal = scan.cursorOrdinal;
    }

    const categoryResult = categories.finish();
    const timeResult = time.finish();
    return {
      dimension,
      categories: categoryResult.groups.map((group) => ({
        label: group.label,
        count: group.count,
      })),
      timeBuckets: timeResult.buckets.map((bucket) => ({
        start: bucket.label,
        count: bucket.count,
      })),
      processedRecords: String(Math.min(
        categoryResult.meta.processedRecords,
        timeResult.meta.processedRecords,
      )),
      examinedRecords: examinedRecords.toString(),
      examinedBytes: examinedBytes.toString(),
      truncated: truncatedReason !== undefined
        || categoryResult.meta.truncatedByRecordLimit
        || timeResult.meta.truncatedByRecordLimit,
      ...(truncatedReason === undefined ? {} : { truncatedReason }),
      capacityReached: categoryResult.meta.capacityReached || timeResult.meta.capacityReached,
      bucketWidthMs: INSIGHT_BUCKET_WIDTH_MS,
    };
  }

  public async setProfile(profileId: string, signal: AbortSignal): Promise<DocumentSummary> {
    throwIfAborted(signal);
    if (!this.registry.list().some((profile) => profile.id === profileId)) {
      throw new Error(`Unknown Agent profile: ${profileId}`);
    }
    this.profileId = profileId;
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
      const previousProfile = this.profileId;
      const detected = await this.detectProfile(next, signal, {
        includeTail: next.getSummary().indexingComplete,
      });
      const nextProfileId = (
        this.profileExplicitlySelected
        && this.registry.list().some((profile) => profile.id === previousProfile)
      ) ? previousProfile : detected.profileId;
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
      this.engine = next;
      this.profileId = nextProfileId;
      this.suggestions = detected.suggestions;
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
    if (this.options.autoDetectProfiles === false) {
      return {
        profileId: 'generic',
        suggestions: this.registry.list()
        .filter((profile) => profile.id !== 'generic')
        .map((profile) => ({
          id: profile.id,
          displayName: profile.displayName,
          score: 0,
          reasons: [],
        })),
      };
    }
    const samples: GenericRecordSample[] = [];
    const sampledOrdinals = new Set<string>();
    await engine.getRows({
      limit: DETECTION_HEAD_SAMPLE_LIMIT,
      columns: [],
      generation: engine.snapshot.generation,
      onHydrated: (record) => {
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
    // Once the physical index is complete, add a bounded newest suffix. This
    // catches files whose producer changes shape over time without forcing an
    // O(n) tail scan on the first paint. The registry still applies its own
    // sample cap and confidence rules.
    if (options.includeTail === true && engine.getSummary().indexingComplete) {
      await engine.getRows({
        direction: 'backward',
        limit: DETECTION_TAIL_SAMPLE_LIMIT,
        scanBudget: {
          maxExaminedRecords: DETECTION_TAIL_SAMPLE_LIMIT,
          maxExaminedBytes: String(8 * 1024 * 1024),
          deadlineEpochMs: Date.now() + 2_000,
        },
        columns: [],
        generation: engine.snapshot.generation,
        onHydrated: (record) => {
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
      // A head/tail-only probe can miss a producer schema transition in the
      // middle of a long file. Three small ordinal windows add coverage while
      // keeping random reads and hydration strictly bounded.
      const totalRecords = BigInt(engine.getSummary().indexedRecords);
      for (const percentage of DETECTION_STRATUM_PERCENTAGES) {
        if (totalRecords < 2n) break;
        const center = (totalRecords * percentage) / 100n;
        const anchor = center > 0n ? center - 1n : undefined;
        await engine.getRows({
          ...(anchor === undefined ? {} : { anchorOrdinal: anchor.toString() }),
          direction: 'forward',
          limit: DETECTION_STRATUM_SAMPLE_LIMIT,
          scanBudget: {
            maxExaminedRecords: DETECTION_STRATUM_SAMPLE_LIMIT,
            maxExaminedBytes: String(2 * 1024 * 1024),
            deadlineEpochMs: Date.now() + 500,
          },
          columns: [],
          generation: engine.snapshot.generation,
          onHydrated: (record) => {
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
      }
    }
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
    return { profileId: decision.selectedProfileId, suggestions };
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

  private startDeferredProfileDetection(): void {
    if (
      this.options.autoDetectProfiles === false
      || this.disposed
    ) return;
    if (this.profileDetectionInFlight !== undefined) {
      if (
        this.engine.getSummary().indexingComplete
        && this.tailDetectionGeneration !== this.engine.snapshot.generation
      ) this.tailDetectionRequested = true;
      return;
    }
    const engine = this.engine;
    const generation = engine.snapshot.generation;
    const complete = engine.getSummary().indexingComplete;
    const includeTail = complete && this.tailDetectionGeneration !== generation;
    if (!includeTail && this.tailDetectionGeneration === generation && !this.tailDetectionRequested) return;
    if (!includeTail && this.options.deferProfileDetection !== true) return;
    if (includeTail) {
      this.tailDetectionGeneration = generation;
      this.tailDetectionRequested = false;
    }
    const controller = new AbortController();
    this.profileDetectionAbort = controller;
    const operation = this.detectProfile(engine, controller.signal, { includeTail })
      .then((detected) => {
        if (
          controller.signal.aborted
          || this.disposed
          || this.engine !== engine
          || this.engine.snapshot.generation !== generation
        ) return;
        if (!this.profileExplicitlySelected) this.profileId = detected.profileId;
        this.suggestions = detected.suggestions;
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
            setImmediate(() => this.startDeferredProfileDetection());
          }
        }
      });
    this.profileDetectionInFlight = operation;
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
      const now = Date.now();
      if (!summary.indexingComplete && now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return;
      this.lastProgressAt = now;
      const current = this.getSummary();
      for (const listener of this.listeners) listener(current);
      if (summary.indexingComplete) this.startDeferredProfileDetection();
    }, { generation: engine.snapshot.generation });
    void this.background.done.catch(() => undefined);
  }
}

function appendDetectionSample(
  samples: GenericRecordSample[],
  sampledOrdinals: Set<string>,
  record: { value?: unknown; ref: { ordinal: string }; parseState: import('../shared/types').ParseState },
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

function profileColumns(profileId: string): readonly ColumnSpec[] {
  const column = (id: string, label: string, width: number): ColumnSpec => ({
    id,
    label,
    source: 'profile',
    width,
  });
  if (profileId === 'generic') return [];
  if (profileId === 'opentelemetry') {
    return [
      column('eventKind', 'Signal', 88),
      column('timestamp', 'Timestamp', 190),
      column('severity', 'Severity', 86),
      column('summary', 'Summary', 320),
      column('service', 'Service', 140),
    ];
  }
  if (profileId === 'structured-application-log') {
    return [
      column('timestamp', 'Timestamp', 190),
      column('severity', 'Level', 78),
      column('summary', 'Message', 340),
      column('service', 'Service', 140),
      column('logger', 'Logger', 150),
    ];
  }
  if (profileId === 'software-engineering-agent') {
    return [
      column('eventKind', 'Event', 100),
      column('summary', 'Summary', 320),
      column('task', 'Task', 150),
      column('step', 'Step', 86),
      column('tool', 'Tool', 120),
      column('status', 'Status', 100),
    ];
  }
  if (profileId === 'codex-history') {
    return [
      column('eventKind', 'Event', 104),
      column('timestamp', 'Timestamp', 190),
      column('actor', 'Actor', 88),
      column('summary', 'Message', 360),
      column('sessionId', 'Session', 180),
      column('sourceKind', 'Source', 110),
    ];
  }
  if (profileId === 'codex-session-index') {
    return [
      column('eventKind', 'Event', 104),
      column('timestamp', 'Updated', 190),
      column('summary', 'Thread', 320),
      column('sessionId', 'Session', 180),
      column('threadName', 'Thread name', 220),
      column('sourceKind', 'Source', 120),
    ];
  }
  if (profileId === 'codex-exec-jsonl') {
    return [
      column('eventKind', 'Event', 120),
      column('summary', 'Summary', 360),
      column('actor', 'Actor', 92),
      column('status', 'Status', 110),
      column('sessionId', 'Thread', 180),
      column('model', 'Model', 130),
    ];
  }
  if (profileId === 'codex-trace') {
    return [
      column('eventKind', 'Event', 120),
      column('timestamp', 'Timestamp', 190),
      column('summary', 'Summary', 360),
      column('actor', 'Actor', 92),
      column('status', 'Status', 110),
      column('sessionId', 'Thread', 180),
      column('turnId', 'Turn', 170),
    ];
  }
  return [
    column('eventKind', 'Event', 104),
    column('timestamp', 'Timestamp', 190),
    column('actor', 'Actor', 88),
    column('summary', 'Summary', 340),
    column('status', 'Status', 100),
    column('model', 'Model', 130),
  ];
}

function profilePredicateFields(
  projection: ReturnType<AgentProfileRegistry['project']>,
): Record<string, JsonScalar | undefined> {
  return {
    ...projection.derivedFields,
    profileId: projection.profileId,
    eventKind: projection.eventKind,
    timestamp: projection.timestamp,
    actor: projection.actor,
    sessionId: projection.sessionId,
    turnId: projection.turnId,
    parentId: projection.parentId,
    messageId: projection.messageId,
    toolCallId: projection.toolCallId,
    subagentId: projection.subagentId,
    model: projection.model,
    status: projection.status,
    severity: projection.severity,
    summary: projection.summary,
    confidence: projection.confidence,
    usageInput: projection.usage?.input,
    usageOutput: projection.usage?.output,
    usageCached: projection.usage?.cached,
    usageTotal: projection.usage?.total,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error('Operation cancelled.');
  }
}

function identityKey(identity: FollowRecoveryIdentity): string {
  return [identity.documentId, identity.uri, identity.generation, identity.sizeBytes, identity.device ?? '', identity.inode ?? ''].join('|');
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
  return snapshot.generation === expected.generation && sameFileIdentity(snapshot, expected);
}

function boundedInsightLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${String(maximum)}.`);
  }
  return candidate;
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
