import type {
  DocumentSummary,
  ExtensionMessage,
  HostExtensionMessage,
  HostDeliveryFor,
  AnalysisIntentV1,
  RowSort,
  SnapshotIdentity,
  TemporaryPreviewStatus,
  WebviewRequest,
  Predicate,
  RecordRef,
} from '@shared/types';
import { randomUUID } from 'node:crypto';
import { isRevealOrdinal, type RevealResultOutcome } from '@shared/contracts/reveal';
import type { RevealResult, RevealRowTarget } from '@shared/protocol/reveal';
import {
  createQueryExecutionRequestV1,
  LoadProblemPage,
  QueryExecutionPort,
  type ProblemPageRequest,
  type RecordPageExecutionTiming,
  type RecordPageRequest,
  type IJsonlSessionPort,
} from '../application';
import { createProtocolEnvelope, readProtocolIdentity } from '@shared/transport';
import { isNavigatorBridgeResult } from '@shared/protocol/navigator-bridge';
import { validateWebviewRequest } from './message-validation';
import { RequestRegistry } from './request-registry';
import { DocumentLineageAuthority } from './document-lineage';
import type { DocumentGraphController } from './document-graph';
import { summaryIdentityMatches } from './summary-identity';
import { classifyErrorMetadata } from './observability/error-metadata';
import { createObservabilityEvent, type ObservabilityEvent, type ObservabilityScalar,
  type QueryOperationOutcome, type QueryOperationDelivery, type QueryStaleReason } from './observability/observability-contract';

type ExtensionMessageByType = {
  [TType in ExtensionMessage['type']]: Extract<ExtensionMessage, { type: TType }>;
};

type ExtensionPayload<TType extends ExtensionMessage['type']> = ExtensionMessageByType[TType]['payload'];
type RequestAddress = Pick<WebviewRequest, 'requestId'>;
type AcceptedRequestIdentity = Readonly<Pick<SnapshotIdentity, 'documentId' | 'generation' | 'epoch'>>;

function sameRawExportProfile(left: DocumentSummary, right: DocumentSummary): boolean {
  return left.profileId === right.profileId && left.profileVersion === right.profileVersion && left.profileEpoch === right.profileEpoch;
}

interface QueryObservation {
  readonly sequence: number;
  readonly startedAt: number;
  outcome: QueryOperationOutcome;
  delivery: QueryOperationDelivery;
  rows?: number;
  staleReason?: QueryStaleReason;
  errorName?: string;
  timing?: RecordPageExecutionTiming;
}

/** @deprecated Import IJsonlSessionPort from application ports for new code. */
export type JsonlSessionPort = IJsonlSessionPort;

/** @deprecated Import RecordPageRequest from application ports for new code. */
export type RowsRequest = RecordPageRequest;

/** @deprecated Import ProblemPageRequest from application ports for new code. */
export type ProblemsRequest = ProblemPageRequest;

export interface MessageChannel {
  postMessage(message: HostExtensionMessage): PromiseLike<boolean>;
}

export interface DocumentControllerHooks {
  graph?: DocumentGraphController;
  /** Host export authority only after successful, current, non-superseded delivery. */
  onAcceptedRawQuery?: (summary: DocumentSummary, predicate: Predicate | undefined) => void;
  onAcceptedRawSelection?: (summary: DocumentSummary, ref: RecordRef) => void;
  /** Cancel document-owned recovery before a user-triggered rebuild starts. */
  beforeRebuild?: () => void;
  onRowOrderChanged?: (direction: RowSort['direction']) => Promise<void>;
  /** Deliver host-owned positioning intents only after the Webview handshake. */
  onReady?: () => Promise<void> | void;
  /** Read the host TreeView state for an editor that missed earlier visibility events. */
  getNavigatorVisibility?: () => boolean;
  onReadyReceived?: () => void;
  /** Observe whether the Webview host accepted the initial summary post. */
  onOpenedDelivery?: (delivered: boolean) => void;
  onFirstRowsRequest?: () => void;
  onFirstRowsResult?: (result: { status: 'posted' | 'rejected' | 'stale' | 'failed' | 'cancelled'; rows?: number; indexedRecords?: string }) => void;
  /** Local metadata only; observer failures cannot change request behavior. */
  onQueryOperation?: (event: ObservabilityEvent) => void;
  /**
   * Run the Host-owned Navigator bridge without changing the document. The
   * result is intentionally opaque at this layer; the shared protocol adapter
   * owns its versioned status payload and may post a correlated receipt.
   */
  onOpenSessionNavigator?: () => Promise<unknown> | unknown;
  getPreviewStatus?: () => TemporaryPreviewStatus | undefined;
  /** Native Save As uses the current document, never a Webview-supplied path. */
  onSavePreviewAs?: (isCurrent: () => boolean) => Promise<unknown>;
  /** Hand off a bounded Webview error to the host-owned diagnostic flow. */
  onDiagnosticError?: (diagnostic: { code: string; message: string; action?: 'explain' | 'copy' }) => Promise<void> | void;
  /** Schedule bounded source recovery without replacing the current snapshot. */
  onTransientSourceChange?: () => Promise<boolean> | boolean;
  /** Current host source grant, separate from the Webview's claimed source ID. */
  isRevealAuthorized?: (sourceId: string) => boolean;
  /** Observe the real source again before a rendered target is accepted. */
  validateRevealSource?: () => Promise<boolean>;
  /** Native read-only text action; the Webview supplies no path or contents. */
  onOpenRecordText?: (ref: import('@shared/types').RecordRef, isCurrent: () => boolean) => Promise<unknown> | unknown;
}

export class DocumentController {
  private readonly session: JsonlSessionPort;
  private readonly channel: MessageChannel;
  private readonly hooks: DocumentControllerHooks;
  private readonly requests = new RequestRegistry();
  private readonly queryExecution: QueryExecutionPort;
  private readonly loadProblemPage: LoadProblemPage;
  private readonly lineage: DocumentLineageAuthority;
  private lineageRequestId: string | undefined;
  private disposed = false;
  private rebuildRequestSequence = 0;
  private firstRowsRequested = false;
  private firstRowsPosted = false;
  private queryRequestSequence = 0;
  private pendingReveal: { result: Omit<RevealResult, 'outcome'>; sourceId: string; guard?: () => boolean;
    resolve: (result: RevealResult) => void; timer: ReturnType<typeof setTimeout> } | undefined;

  public constructor(
    session: JsonlSessionPort,
    channel: MessageChannel,
    hooks: DocumentControllerHooks = {},
  ) {
    this.session = session;
    this.channel = channel;
    this.hooks = hooks;
    this.queryExecution = new QueryExecutionPort((identity) => {
      const currentIdentity = querySourceIdentity(this.session.getSummary().snapshot);
      if (!sameQuerySourceIdentity(currentIdentity, identity)) return undefined;
      return { identity: currentIdentity, recordPage: this.session };
    });
    this.loadProblemPage = new LoadProblemPage(session);
    this.lineage = new DocumentLineageAuthority(session);
  }

  /** Host-only entry point. A delivered scroll is pending until the view confirms it. */
  public revealRow(target: RevealRowTarget, guard?: () => boolean): Promise<RevealResult> {
    this.settleReveal('superseded');
    const summary = this.session.getSummary();
    const identity = captureSnapshotIdentity(summary.snapshot);
    const result = { ...identity, requestId: `reveal-${randomUUID()}`, anchorOrdinal: target.anchorOrdinal };
    if (this.disposed) return Promise.resolve({ ...result, outcome: 'no-view' });
    if (!isRevealOrdinal(target.anchorOrdinal)
      || (summary.indexingComplete && BigInt(target.anchorOrdinal) >= BigInt(summary.indexedRecords))) {
      return Promise.resolve({ ...result, outcome: 'out-of-range' });
    }
    if (target.sourceId.length === 0 || target.sourceId.length > 256 || target.nativeId.length === 0
      || target.nativeId.length > 512 || guard?.() === false || this.hooks.isRevealAuthorized?.(target.sourceId) === false) {
      return Promise.resolve({ ...result, outcome: 'unauthorized' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingReveal?.result.requestId !== result.requestId) return;
        this.settleReveal(this.isCurrentIdentity(identity) ? 'timeout' : 'stale');
      }, 5000);
      this.pendingReveal = { result, sourceId: target.sourceId, ...(guard === undefined ? {} : { guard }), resolve, timer };
      void this.post({ requestId: result.requestId }, identity, 'REVEAL', {
        ...target, generation: identity.generation,
      }, 'request')
        .then((delivered) => {
          if (!delivered && this.pendingReveal?.result.requestId === result.requestId) this.settleReveal('no-view');
        }, () => {
          if (this.pendingReveal?.result.requestId === result.requestId) this.settleReveal('no-view');
        });
    });
  }

  private settleReveal(outcome: RevealResultOutcome): void {
    const pending = this.pendingReveal;
    if (pending === undefined) return;
    this.pendingReveal = undefined;
    clearTimeout(pending.timer);
    pending.resolve({ ...pending.result, outcome });
  }

  public async handleMessage(value: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    const validation = validateWebviewRequest(value);
    if (!validation.ok || validation.request === undefined) {
      await this.postError(
        readProtocolIdentity(value),
        captureSnapshotIdentity(this.session.getSummary().snapshot),
        'INVALID_REQUEST',
        validation.error ?? 'Invalid request.',
        false,
      );
      return;
    }
    const request = validation.request;
    if (request.type === 'REVEAL_ACK') {
      const pending = this.pendingReveal;
      if (pending === undefined || pending.result.requestId !== request.requestId) return;
      if (!this.isCurrentIdentity(pending.result)) { this.settleReveal('stale'); return; }
      if (request.documentId !== pending.result.documentId || request.generation !== pending.result.generation
        || request.epoch !== pending.result.epoch || request.payload.anchorOrdinal !== pending.result.anchorOrdinal) return;
      if (pending.guard?.() === false || this.hooks.isRevealAuthorized?.(pending.sourceId) === false) { this.settleReveal('unauthorized'); return; }
      if (request.payload.outcome === 'shown' && this.hooks.validateRevealSource !== undefined) {
        let valid = false;
        try { valid = await this.hooks.validateRevealSource(); } catch { /* Unobservable source is stale. */ }
        if (this.pendingReveal !== pending) return;
        if (!valid || !this.isCurrentIdentity(pending.result)) { this.settleReveal('stale'); return; }
        if (pending.guard?.() === false || this.hooks.isRevealAuthorized?.(pending.sourceId) === false) { this.settleReveal('unauthorized'); return; }
      }
      this.settleReveal(request.payload.outcome);
      return;
    }
    const liveSummary = this.session.getSummary();
    const summary = { ...liveSummary, snapshot: { ...liveSummary.snapshot } };
    const acceptedIdentity = captureSnapshotIdentity(summary.snapshot);
    if (request.documentId !== summary.snapshot.documentId) {
      await this.postError(request, acceptedIdentity, 'WRONG_DOCUMENT', 'The request belongs to a different document.', false);
      return;
    }
    // Cancellation is a control message for a request that may belong to the
    // previous generation. Keep the document boundary above, but handle it
    // before the generation gate so a rebuild can still stop old work.
    if (request.type === 'CANCEL') {
      this.requests.cancel(request.payload.targetRequestId);
      return;
    }
    // An error banner may outlive the generation that produced it. Keep
    // the bounded handoff available so the user can still ask the host to
    // explain or copy the last visible error after a source refresh.
    if (request.type === 'DIAGNOSE_ERROR') {
      await this.hooks.onDiagnosticError?.(request.payload);
      return;
    }
    if (request.type !== 'READY' && request.generation !== summary.snapshot.generation) {
      await this.postError(request, acceptedIdentity, 'STALE_GENERATION', 'The source file changed. Refreshing the current view is required.', true);
      return;
    }
    if (
      request.type !== 'READY'
      && request.epoch !== undefined
      && summary.snapshot.epoch !== undefined
      && request.epoch !== summary.snapshot.epoch
    ) {
      await this.postError(request, acceptedIdentity, 'STALE_EPOCH', 'The source lifecycle advanced. Refreshing the current view is required.', true);
      return;
    }

    let signal: AbortSignal | undefined;
    let firstRowsRequest = false;
    let queryObservation: QueryObservation | undefined;
    try {
      switch (request.type) {
        case 'LOOKUP_LINEAGE_RECORD': {
          signal = this.requests.startLatest('lineage-lookup', request.requestId);
          this.lineageRequestId = request.requestId;
          const result = await this.lineage.lookup(request.payload, signal);
          if (!result.isCurrent() || this.lineageRequestId !== request.requestId) return;
          if (await this.postIfCurrent(request, acceptedIdentity, 'LINEAGE_LOOKUP_RESULT', result.reply)
            && result.isCurrent()) result.publish();
          return;
        }
        case 'GET_GRAPH': {
          if (this.hooks.graph === undefined) throw new Error('Current-document Graph is unavailable.');
          signal = this.requests.startLatest('graph', request.requestId);
          const reply = await this.hooks.graph.load(request.requestId, signal);
          if (signal.aborted) return;
          if (await this.postIfCurrent(request, acceptedIdentity, 'GRAPH', reply)) this.hooks.graph.publish(request.requestId, reply);
          return;
        }
        case 'REVEAL_GRAPH_RECORD': {
          signal = this.requests.startLatest('graph-reveal', request.requestId);
          const resolved = await this.hooks.graph?.resolve(request.payload);
          if (signal.aborted) return;
          let outcome: RevealResultOutcome = 'stale';
          if (resolved !== undefined) {
            const reveal = this.revealRow(resolved.target, () => !signal?.aborted && resolved.isCurrent());
            const pending = this.pendingReveal;
            const cancel = (): void => { if (this.pendingReveal === pending) this.settleReveal('cancelled'); };
            signal.addEventListener('abort', cancel, { once: true });
            try { outcome = (await reveal).outcome; }
            finally { signal.removeEventListener('abort', cancel); }
          }
          if (signal.aborted) return;
          await this.postIfCurrent(request, acceptedIdentity, 'GRAPH_REVEAL_RESULT', { ...request.payload, outcome });
          return;
        }
        case 'READY':
          this.hooks.onReadyReceived?.();
          if (await this.postIfCurrent(request, acceptedIdentity, 'OPENED', summary)) {
            this.hooks.onOpenedDelivery?.(true);
            await this.publishPreviewStatus();
            const visible = this.hooks.getNavigatorVisibility?.();
            if (visible !== undefined) {
              await this.postIfCurrent({ requestId: '' }, acceptedIdentity, 'NAVIGATOR_VISIBILITY', { visible }, 'broadcast');
            }
            await this.hooks.onReady?.();
          } else {
            this.hooks.onOpenedDelivery?.(false);
          }
          return;
        case 'OPEN_SESSION_NAVIGATOR':
          {
            const result = await this.hooks.onOpenSessionNavigator?.();
            if (result === undefined) return;
            if (!isNavigatorBridgeResult(result)) {
              await this.postError(request, acceptedIdentity, 'NAVIGATOR_RESULT_INVALID', 'The Navigator handoff returned an invalid Host result.', true);
              return;
            }
            await this.postIfCurrent(request, acceptedIdentity, 'NAVIGATOR_STATUS', result);
          }
          return;
        case 'SAVE_PREVIEW_AS':
          await this.hooks.onSavePreviewAs?.(() => !this.disposed && this.isCurrentIdentity(acceptedIdentity));
          return;
        case 'GET_ROWS': {
          signal = this.requests.startLatest('viewport', request.requestId);
          this.invalidateLineage();
          queryObservation = this.beginQueryObservation();
          firstRowsRequest = !this.firstRowsPosted;
          if (firstRowsRequest) {
            if (!this.firstRowsRequested) {
              this.firstRowsRequested = true;
              this.hooks.onFirstRowsRequest?.();
            }
          }
          const query = createQueryExecutionRequestV1(
            querySourceIdentity(summary.snapshot),
            request.requestId,
            request.payload,
          );
          const observedQuery = queryObservation;
          const onTiming = observedQuery === undefined ? undefined : (timing: RecordPageExecutionTiming): void => {
            observedQuery.timing = timing;
          };
          const execution = await this.queryExecution.execute(query, signal, onTiming);
          if (execution.target !== 'record-page') throw new Error('GET_ROWS resolved to a non-page query target.');
          const page = execution.page;
          if (queryObservation !== undefined) queryObservation.rows = page.rows.length;
          const current = this.isCurrentIdentity(acceptedIdentity, queryObservation);
          const posted = current && await this.postIfCurrent(
            request,
            acceptedIdentity,
            'ROWS',
            page,
            'reply',
            queryObservation,
          );
          if (posted && !signal.aborted && this.isCurrentIdentity(acceptedIdentity) && sameRawExportProfile(summary, this.session.getSummary())) {
            this.lineage.acceptPage(summary, page.rows);
            try { this.hooks.onAcceptedRawQuery?.(summary, request.payload.predicate); } catch { /* Export observers cannot change delivery. */ }
          }
          if (queryObservation !== undefined && queryObservation.outcome !== 'stale') {
            queryObservation.outcome = 'completed';
            queryObservation.delivery = posted ? 'accepted' : 'rejected';
          }
          if (firstRowsRequest) this.hooks.onFirstRowsResult?.({
            status: !current ? 'stale' : posted ? 'posted' : 'rejected',
            rows: page.rows.length,
            indexedRecords: page.indexedRecords,
          });
          if (firstRowsRequest && posted) this.firstRowsPosted = true;
          return;
        }
        case 'GET_PROBLEMS':
          signal = this.requests.startLatest('problems', request.requestId);
          await this.postIfCurrent(
            request,
            acceptedIdentity,
            'PROBLEMS',
            await this.loadProblemPage.execute(request.payload, signal),
          );
          return;
        case 'OPEN_RECORD_TEXT':
          await this.hooks.onOpenRecordText?.(request.payload.ref, () => !this.disposed && this.isCurrentIdentity(acceptedIdentity));
          return;
        case 'GET_DETAIL': {
          signal = this.requests.startLatest('detail', request.requestId);
          const detail = await this.session.getDetail(request.payload.ref, request.payload.full ?? false, signal);
          const posted = await this.postIfCurrent(
            request,
            acceptedIdentity,
            'DETAIL',
            detail,
          );
          if (posted && !signal.aborted && this.isCurrentIdentity(acceptedIdentity) && sameRawExportProfile(summary, this.session.getSummary())) {
            try { this.hooks.onAcceptedRawSelection?.(summary, detail.ref); } catch { /* Export observers cannot change delivery. */ }
          }
          return;
        }
        case 'GET_SCHEMA':
          signal = this.requests.startLatest('schema', request.requestId);
          await this.postIfCurrent(
            request,
            acceptedIdentity,
            'SCHEMA',
            await this.session.getSchema(request.payload.offset, request.payload.limit, signal),
          );
          return;
        case 'GET_INSIGHTS': {
          if (!this.matchesAnalysisIntent(request.payload.intent)) {
            await this.postError(request, acceptedIdentity, 'STALE_ANALYSIS_INTENT', 'Insights intent no longer matches the open document.', true);
            return;
          }
          signal = this.requests.startLatest('insights', request.requestId);
          const insights = await this.session.getInsights(request.payload.intent, signal);
          if (signal.aborted || !this.matchesAnalysisIntent(request.payload.intent)) return;
          await this.postIfCurrent(
            request,
            acceptedIdentity,
            'INSIGHTS',
            insights,
          );
          return;
        }
        case 'SET_PROFILE': {
          signal = this.requests.startLatest('profile', request.requestId);
          this.invalidateLineage();
          this.hooks.graph?.invalidate();
          const updated = await this.session.setProfile(request.payload.profileId, signal);
          if (signal.aborted || !this.isCurrentIdentity(acceptedIdentity)
            || updated.snapshot.documentId !== request.documentId
            || !summaryIdentityMatches(updated, this.session.getSummary())) return;
          if (updated.profileVersion === undefined) {
            await this.postError(request, acceptedIdentity, 'PROFILE_REVISION_UNAVAILABLE',
              'The selected profile did not provide a stable revision.', false);
            return;
          }
          await this.postIfCurrent(request, acceptedIdentity, 'PROFILE_CHANGED', {
            profileId: updated.profileId,
            profileVersion: updated.profileVersion,
            ...(updated.profileEpoch === undefined ? {} : { profileEpoch: updated.profileEpoch }),
            columns: [...this.session.getProfileColumns()],
          });
          if (signal.aborted || !summaryIdentityMatches(updated, this.session.getSummary())) return;
          // PROFILE_CHANGED completes the correlated request on the webview
          // side. Publish the follow-up summary as unsolicited progress so it
          // is accepted after that completion and cannot leave counts stale.
          await this.postIfCurrent({ requestId: '' }, acceptedIdentity, 'INDEX_PROGRESS', updated, 'broadcast');
          return;
        }
        case 'SET_FOLLOW_MODE':
          await this.postIfCurrent(
            request,
            acceptedIdentity,
            'INDEX_PROGRESS',
            await this.session.setFollowMode(request.payload.enabled),
          );
          return;
        case 'SET_ROW_ORDER':
          await this.hooks.onRowOrderChanged?.(request.payload.direction);
          await this.postIfCurrent(request, acceptedIdentity, 'ROW_ORDER_CHANGED', request.payload);
          return;
        case 'REBUILD_INDEX': {
          signal = this.requests.startLatest('rebuild', request.requestId);
          this.invalidateLineage();
          const rebuildRequestSequence = ++this.rebuildRequestSequence;
          this.hooks.beforeRebuild?.();
          const rebuilt = await this.session.rebuild(signal);
          // A cancelled caller may still observe a shared rebuild result. Only
          // the latest live caller may publish it, and only when the session
          // still owns the returned generation.
          if (
            rebuilt.snapshot.documentId !== request.documentId
            || !this.canPublishRebuild(rebuildRequestSequence, signal, rebuilt)
          ) return;
          await this.post(request, captureSnapshotIdentity(rebuilt.snapshot), 'OPENED', rebuilt, 'reply');
          return;
        }
        default:
          await this.postError(request, acceptedIdentity, 'UNSUPPORTED_MESSAGE', 'Unsupported request.', false);
      }
    } catch (error) {
      if (queryObservation !== undefined && queryObservation.outcome !== 'completed') {
        queryObservation.outcome = signal?.aborted ? 'cancelled' : 'failed';
        if (queryObservation.outcome === 'failed') queryObservation.errorName = classifyErrorMetadata(error).errorName;
      }
      if (firstRowsRequest) this.hooks.onFirstRowsResult?.({ status: signal?.aborted ? 'cancelled' : 'failed' });
      if (signal?.aborted) {
        return;
      }
      if (!this.isCurrentIdentity(acceptedIdentity, queryObservation)) return;
      if (isTransientSourceChange(error)) {
        const handled = await this.hooks.onTransientSourceChange?.();
        if (!this.isCurrentIdentity(acceptedIdentity, queryObservation)) return;
        if (handled === true) {
          await this.postError(
            request,
            acceptedIdentity,
            'SOURCE_UPDATING',
            'The source is still changing; the previous snapshot remains visible while it settles.',
            true,
          );
          return;
        }
      }
      if (!this.isCurrentIdentity(acceptedIdentity, queryObservation)) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.postError(request, acceptedIdentity, 'REQUEST_FAILED', message, true);
    } finally {
      if (signal !== undefined) this.requests.finish(request.requestId, signal);
      if (queryObservation !== undefined) this.finishQueryObservation(queryObservation, signal);
    }
  }

  public async publishPreviewStatus(): Promise<void> {
    if (this.disposed) return;
    const status = this.hooks.getPreviewStatus?.();
    if (status === undefined) return;
    const identity = captureSnapshotIdentity(this.session.getSummary().snapshot);
    await this.postIfCurrent({ requestId: '' }, identity, 'PREVIEW_STATUS', status, 'broadcast');
  }

  public dispose(): void {
    this.invalidateLineage();
    this.hooks.graph?.invalidate();
    this.settleReveal('cancelled');
    this.disposed = true;
    this.requests.cancelAll();
  }

  public cancelActive(): void {
    this.invalidateLineage();
    this.hooks.graph?.invalidate();
    this.settleReveal('cancelled');
    this.requests.cancelAll();
  }

  private invalidateLineage(): void {
    this.lineage.invalidate();
    if (this.lineageRequestId !== undefined) this.requests.cancel(this.lineageRequestId);
    this.lineageRequestId = undefined;
  }

  private async post<TType extends ExtensionMessage['type']>(
    request: RequestAddress,
    identity: AcceptedRequestIdentity,
    type: TType,
    payload: ExtensionPayload<TType>,
    delivery: HostDeliveryFor<TType>,
  ): Promise<boolean> {
    return this.postEnvelope<TType>(request, identity, type, payload, delivery);
  }

  private async postEnvelope<TType extends ExtensionMessage['type']>(
    request: RequestAddress,
    identity: AcceptedRequestIdentity,
    type: TType,
    payload: ExtensionPayload<TType>,
    delivery: HostDeliveryFor<TType>,
  ): Promise<boolean> {
    const message = createProtocolEnvelope({
      type,
      documentId: identity.documentId,
      generation: identity.generation,
      ...(identity.epoch === undefined ? {} : { epoch: identity.epoch }),
      delivery,
      requestId: request.requestId,
      payload,
    }) as unknown as HostExtensionMessage & ExtensionMessageByType[TType];
    return this.channel.postMessage(message);
  }

  private async postIfCurrent<TType extends ExtensionMessage['type']>(
    request: RequestAddress,
    expectedIdentity: AcceptedRequestIdentity,
    type: TType,
    payload: ExtensionPayload<TType>,
    delivery: HostDeliveryFor<TType> = 'reply' as HostDeliveryFor<TType>,
    queryObservation?: QueryObservation,
  ): Promise<boolean> {
    if (!this.isCurrentIdentity(expectedIdentity, queryObservation)) return false;
    // This remains failed only if the existing ROWS post throws/rejects.
    if (queryObservation !== undefined) queryObservation.delivery = 'failed';
    return this.postEnvelope<TType>(request, expectedIdentity, type, payload, delivery);
  }

  private isCurrentIdentity(expectedIdentity: AcceptedRequestIdentity, queryObservation?: QueryObservation): boolean {
    const current = this.session.getSummary().snapshot;
    const mismatch: QueryStaleReason | undefined = current.documentId !== expectedIdentity.documentId ? 'document'
      : current.generation !== expectedIdentity.generation ? 'generation'
        : current.epoch !== expectedIdentity.epoch ? 'epoch' : undefined;
    if (mismatch !== undefined && queryObservation !== undefined && queryObservation.outcome !== 'completed') {
      queryObservation.outcome = 'stale';
      queryObservation.staleReason = mismatch;
    }
    return mismatch === undefined;
  }

  private beginQueryObservation(): QueryObservation | undefined {
    if (this.hooks.onQueryOperation === undefined || this.queryRequestSequence === Number.MAX_SAFE_INTEGER) return undefined;
    const observation: QueryObservation = {
      sequence: ++this.queryRequestSequence, startedAt: performance.now(), outcome: 'failed', delivery: 'skipped',
    };
    this.recordQueryObservation('jsonlview.query.started', { stage: 'get_rows', request_seq: observation.sequence });
    return observation;
  }

  private finishQueryObservation(observation: QueryObservation, signal: AbortSignal | undefined): void {
    this.recordQueryObservation('jsonlview.query.settled', {
      stage: 'get_rows',
      request_seq: observation.sequence,
      outcome: observation.outcome,
      delivery: observation.delivery,
      abort_observed: signal?.aborted ?? false,
      duration_ms: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - observation.startedAt))),
      ...(observation.rows === undefined ? {} : { rows: observation.rows }),
      ...(observation.outcome === 'stale' ? { stale_reason: observation.staleReason! } : {}),
      ...(observation.outcome === 'failed' ? { error_name: observation.errorName ?? 'UnknownError' } : {}),
      ...(observation.timing === undefined ? {} : {
        queue_wait_ms: observation.timing.queueWaitMs,
        engine_exec_ms: observation.timing.engineExecMs,
        queue_blocked_by: observation.timing.queueBlockedBy,
        index_work_ms: observation.timing.indexWorkMs,
        read_wait_ms: observation.timing.readWaitMs,
        ...(observation.timing.readCalls === undefined ? {} : { read_calls: observation.timing.readCalls }),
        ...(observation.timing.readBytes === undefined ? {} : { read_bytes: observation.timing.readBytes }),
        ...(observation.timing.readMaxWaitMs === undefined ? {} : { read_max_wait_ms: observation.timing.readMaxWaitMs }),
        parse_ms: observation.timing.parseMs,
        projection_ms: observation.timing.projectionMs,
        snapshot_check_ms: observation.timing.snapshotCheckMs,
      }),
    });
  }

  private recordQueryObservation(
    name: 'jsonlview.query.started' | 'jsonlview.query.settled',
    attributes: Readonly<Record<string, ObservabilityScalar>>,
  ): void {
    try {
      const event = createObservabilityEvent(name, attributes);
      if (event !== undefined) this.hooks.onQueryOperation?.(event);
    } catch {
      // Logging is synchronous, bounded and best-effort; never affect a request.
    }
  }

  private matchesAnalysisIntent(intent: AnalysisIntentV1): boolean {
    const summary = this.session.getSummary();
    return intent.document.documentId === summary.snapshot.documentId
      && intent.document.generation === summary.snapshot.generation
      && intent.document.sourceEpoch === summary.snapshot.epoch
      && intent.profile.id === summary.profileId
      && intent.profile.version === summary.profileVersion
      && (intent.scope === 'current-view' || intent.predicate === undefined);
  }

  private canPublishRebuild(
    requestSequence: number,
    signal: AbortSignal,
    summary: DocumentSummary,
  ): boolean {
    if (this.disposed || signal.aborted || requestSequence !== this.rebuildRequestSequence) return false;
    const current = this.session.getSummary().snapshot;
    return current.documentId === summary.snapshot.documentId
      && current.generation === summary.snapshot.generation
      && current.epoch === summary.snapshot.epoch;
  }

  private async postError(
    request: RequestAddress,
    identity: AcceptedRequestIdentity,
    code: string,
    message: string,
    recoverable: boolean,
  ): Promise<void> {
    await this.channel.postMessage(createProtocolEnvelope({
      type: 'ERROR',
      documentId: identity.documentId,
      generation: identity.generation,
      ...(identity.epoch === undefined ? {} : { epoch: identity.epoch }),
      delivery: 'reply',
      requestId: request.requestId,
      payload: { code, message, recoverable },
    }) as HostExtensionMessage);
  }
}

function captureSnapshotIdentity(snapshot: SnapshotIdentity): AcceptedRequestIdentity {
  return Object.freeze({
    documentId: snapshot.documentId,
    generation: snapshot.generation,
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
  });
}

function querySourceIdentity(snapshot: SnapshotIdentity): import('@shared/contracts/query-dto').QuerySourceIdentityV1 {
  return {
    // The document id is the host-owned opaque source handle. Physical paths
    // remain outside the DTO and are never resolved by the Webview.
    sourceId: snapshot.documentId,
    documentId: snapshot.documentId,
    generation: snapshot.generation,
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
    fingerprint: snapshot.prefixFingerprint,
  };
}

function sameQuerySourceIdentity(
  left: import('@shared/contracts/query-dto').QuerySourceIdentityV1,
  right: import('@shared/contracts/query-dto').QuerySourceIdentityV1,
): boolean {
  return left.sourceId === right.sourceId
    && left.documentId === right.documentId
    && left.generation === right.generation
    && left.epoch === right.epoch
    && left.fingerprint === right.fingerprint;
}

function isTransientSourceChange(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'UNEXPECTED_EOF') return true;
  if (code !== 'SOURCE_CHANGED') return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string'
    && (message.includes('no stable baseline') || message.includes('while the snapshot was being checked'));
}
