import type {
  DocumentSummary,
  ColumnSpec,
  FieldStats,
  InsightDimension,
  InsightSummary,
  JsonScalar,
  ProfileSuggestion,
  RecordDetail,
  RecordRef,
  RowPage,
  ScanTruncationReason,
} from '../shared/types';
import { CategoricalAggregator, TimeBucketAggregator } from '../aggregation';
import {
  JsonlFileEngine,
  type BackgroundIndexHandle,
  type NativeNewlineScannerSetting,
  type RowEnricher,
  type SourceRefreshResult,
} from '../engine';
import { createProfileRegistry, type AgentProfileRegistry } from '../profiles';
import type { JsonlSessionPort, RowsRequest } from './document-controller';

const DETECTION_SAMPLE_LIMIT = 64;
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
  newlineScanner?: NativeNewlineScannerSetting;
  backgroundIndexing?: boolean;
  insightsMaxExaminedRecords?: number;
  insightsMaxExaminedBytes?: number;
  insightsMaxMilliseconds?: number;
}

export type SummaryListener = (summary: DocumentSummary) => void;

interface DetectedProfileState {
  profileId: string;
  suggestions: ProfileSuggestion[];
}

export class IntegratedJsonlSession implements JsonlSessionPort {
  private readonly registry: AgentProfileRegistry;
  private readonly listeners = new Set<SummaryListener>();
  private engine: JsonlFileEngine;
  private profileId = 'generic';
  private suggestions: ProfileSuggestion[] = [];
  private profileExplicitlySelected = false;
  private background: BackgroundIndexHandle | undefined;
  private rebuildInFlight: Promise<DocumentSummary> | undefined;
  private rebuildAbort: AbortController | undefined;
  private profileDetectionAbort: AbortController | undefined;
  private profileDetectionInFlight: Promise<void> | undefined;
  private profileDetectionScheduled = false;
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
      uri: options.uri,
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      ...(options.newlineScanner === undefined ? {} : { newlineScanner: options.newlineScanner }),
    });
    const session = new IntegratedJsonlSession(filePath, options, engine);
    try {
      if (options.deferProfileDetection === true && options.autoDetectProfiles !== false) {
        session.suggestions = session.zeroScoreSuggestions();
        return session;
      }
      const detected = await session.detectProfile(engine, signal);
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
      enricher: this.createEnricher(),
      generation: this.engine.snapshot.generation,
      signal,
    });
    this.scheduleDeferredProfileDetection();
    return page;
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
    const result = await this.engine.getSchema(offset, limit);
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
    this.followEnabled = enabled;
    return this.getSummary();
  }

  public rebuild(signal: AbortSignal): Promise<DocumentSummary> {
    if (signal.aborted) return Promise.reject(new Error('Operation cancelled.'));
    if (this.rebuildInFlight === undefined) {
      const controller = new AbortController();
      this.rebuildAbort = controller;
      const operation = this.performRebuild(controller.signal).finally(() => {
        if (this.rebuildInFlight === operation) {
          this.rebuildInFlight = undefined;
          this.rebuildAbort = undefined;
        }
      });
      this.rebuildInFlight = operation;
    }
    return waitForOperation(this.rebuildInFlight, signal);
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
    await this.engine.dispose();
  }

  private async performRebuild(signal: AbortSignal): Promise<DocumentSummary> {
    throwIfAborted(signal);
    this.profileDetectionAbort?.abort();
    const previous = this.engine;
    const next = await JsonlFileEngine.open(this.filePath, {
      documentId: previous.snapshot.documentId,
      uri: this.options.uri,
      ...(this.options.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.options.maxRecordBytes }),
      ...(this.options.newlineScanner === undefined ? {} : { newlineScanner: this.options.newlineScanner }),
    });
    let adopted = false;
    try {
      const previousProfile = this.profileId;
      const detected = await this.detectProfile(next, signal);
      const nextProfileId = (
        this.profileExplicitlySelected
        && this.registry.list().some((profile) => profile.id === previousProfile)
      ) ? previousProfile : detected.profileId;
      throwIfAborted(signal);
      this.background?.cancel();
      this.engine = next;
      this.profileId = nextProfileId;
      this.suggestions = detected.suggestions;
      adopted = true;
      this.startBackgroundIndexing();
      void previous.dispose().catch(() => undefined);
      return this.getSummary();
    } catch (error) {
      if (!adopted) await next.dispose();
      throw error;
    }
  }

  private async detectProfile(engine: JsonlFileEngine, signal?: AbortSignal): Promise<DetectedProfileState> {
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
    const samples: Array<{ value: unknown; ordinal: string }> = [];
    await engine.getRows({
      limit: DETECTION_SAMPLE_LIMIT,
      columns: [],
      generation: engine.snapshot.generation,
      onHydrated: (record) => {
        if (record.parseState === 'valid' && record.value !== undefined && samples.length < DETECTION_SAMPLE_LIMIT) {
          samples.push({ value: record.value, ordinal: record.ref.ordinal });
        }
      },
      ...(signal === undefined ? {} : { signal }),
    });
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
      this.options.deferProfileDetection !== true
      || this.options.autoDetectProfiles === false
      || this.profileDetectionInFlight !== undefined
      || this.disposed
    ) return;
    const engine = this.engine;
    const generation = engine.snapshot.generation;
    const controller = new AbortController();
    this.profileDetectionAbort = controller;
    const operation = this.detectProfile(engine, controller.signal)
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
    }, { generation: engine.snapshot.generation });
    void this.background.done.catch(() => undefined);
  }
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
