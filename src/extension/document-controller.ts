import type {
  ColumnSpec,
  DocumentSummary,
  ExtensionMessage,
  FieldStats,
  AnalysisIntentV1,
  InsightSummary,
  ProblemPage,
  RecordDetail,
  RecordRef,
  RowSort,
  SnapshotIdentity,
  WebviewRequest,
} from '../shared/types';
import { LoadProblemPage, LoadRecordPage, type ProblemPageReader, type ProblemPageRequest, type RecordPageReader, type RecordPageRequest } from '../application';
import { createProtocolEnvelope, readProtocolIdentity } from '../shared/transport';
import { validateWebviewRequest } from './message-validation';
import { RequestRegistry } from './request-registry';
import { summaryIdentityMatches } from './summary-identity';

type ExtensionMessageByType = {
  [TType in ExtensionMessage['type']]: Extract<ExtensionMessage, { type: TType }>;
};

type ExtensionPayload<TType extends ExtensionMessage['type']> = ExtensionMessageByType[TType]['payload'];
type RequestAddress = Pick<WebviewRequest, 'requestId'>;
type AcceptedRequestIdentity = Readonly<Pick<SnapshotIdentity, 'documentId' | 'generation' | 'epoch'>>;

/** @deprecated Import RecordPageRequest from application ports for new code. */
export type RowsRequest = RecordPageRequest;

/** @deprecated Import ProblemPageRequest from application ports for new code. */
export type ProblemsRequest = ProblemPageRequest;

export interface JsonlSessionPort extends RecordPageReader, ProblemPageReader {
  getSummary(): DocumentSummary;
  getProfileColumns(): readonly ColumnSpec[];
  getProblems(request: ProblemsRequest, signal: AbortSignal): Promise<ProblemPage>;
  getDetail(ref: RecordRef, full: boolean, signal: AbortSignal): Promise<RecordDetail>;
  getSchema(offset: number, limit: number, signal: AbortSignal): Promise<{
    fields: FieldStats[];
    totalFields: number;
    complete: boolean;
  }>;
  getInsights(
    intent: AnalysisIntentV1,
    signal: AbortSignal,
  ): Promise<InsightSummary>;
  setProfile(profileId: string, signal: AbortSignal): Promise<DocumentSummary>;
  setFollowMode(enabled: boolean): Promise<DocumentSummary>;
  rebuild(signal: AbortSignal): Promise<DocumentSummary>;
}

export interface MessageChannel {
  postMessage(message: ExtensionMessage): PromiseLike<boolean>;
}

export interface DocumentControllerHooks {
  /** Cancel document-owned recovery before a user-triggered rebuild starts. */
  beforeRebuild?: () => void;
  onRowOrderChanged?: (direction: RowSort['direction']) => Promise<void>;
  /** Deliver host-owned positioning intents only after the Webview handshake. */
  onReady?: () => Promise<void> | void;
  onReadyReceived?: () => void;
  /** Observe whether the Webview host accepted the initial summary post. */
  onOpenedDelivery?: (delivered: boolean) => void;
  onFirstRowsRequest?: () => void;
  onFirstRowsResult?: (result: { status: 'posted' | 'rejected' | 'stale' | 'failed' | 'cancelled'; rows?: number; indexedRecords?: string }) => void;
  /** Focus the opt-in Session Navigator without changing the document. */
  onOpenSessionNavigator?: () => Promise<void> | void;
  /** Hand off a bounded Webview error to the host-owned diagnostic flow. */
  onDiagnosticError?: (diagnostic: { code: string; message: string; action?: 'explain' | 'copy' }) => Promise<void> | void;
  /** Schedule bounded source recovery without replacing the current snapshot. */
  onTransientSourceChange?: () => Promise<boolean> | boolean;
}

export class DocumentController {
  private readonly requests = new RequestRegistry();
  private readonly loadRecordPage: LoadRecordPage;
  private readonly loadProblemPage: LoadProblemPage;
  private disposed = false;
  private rebuildRequestSequence = 0;
  private firstRowsRequested = false;
  private firstRowsPosted = false;

  public constructor(
    private readonly session: JsonlSessionPort,
    private readonly channel: MessageChannel,
    private readonly hooks: DocumentControllerHooks = {},
  ) {
    this.loadRecordPage = new LoadRecordPage(session);
    this.loadProblemPage = new LoadProblemPage(session);
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
    const summary = this.session.getSummary();
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
    try {
      switch (request.type) {
        case 'READY':
          this.hooks.onReadyReceived?.();
          if (await this.postIfCurrent(request, acceptedIdentity, 'OPENED', summary)) {
            this.hooks.onOpenedDelivery?.(true);
            await this.hooks.onReady?.();
          } else {
            this.hooks.onOpenedDelivery?.(false);
          }
          return;
        case 'OPEN_SESSION_NAVIGATOR':
          await this.hooks.onOpenSessionNavigator?.();
          return;
        case 'GET_ROWS': {
          firstRowsRequest = !this.firstRowsPosted;
          if (firstRowsRequest) {
            if (!this.firstRowsRequested) {
              this.firstRowsRequested = true;
              this.hooks.onFirstRowsRequest?.();
            }
          }
          signal = this.requests.startLatest('viewport', request.requestId);
          const page = await this.loadRecordPage.execute(request.payload, signal);
          const current = this.isCurrentIdentity(acceptedIdentity);
          const posted = current && await this.postIfCurrent(
            request,
            acceptedIdentity,
            'ROWS',
            page,
          );
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
        case 'GET_DETAIL':
          signal = this.requests.startLatest('detail', request.requestId);
          await this.postIfCurrent(
            request,
            acceptedIdentity,
            'DETAIL',
            await this.session.getDetail(request.payload.ref, request.payload.full ?? false, signal),
          );
          return;
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
          await this.postIfCurrent({ requestId: '' }, acceptedIdentity, 'INDEX_PROGRESS', updated);
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
          const rebuildRequestSequence = ++this.rebuildRequestSequence;
          signal = this.requests.startLatest('rebuild', request.requestId);
          this.hooks.beforeRebuild?.();
          const rebuilt = await this.session.rebuild(signal);
          // A cancelled caller may still observe a shared rebuild result. Only
          // the latest live caller may publish it, and only when the session
          // still owns the returned generation.
          if (
            rebuilt.snapshot.documentId !== request.documentId
            || !this.canPublishRebuild(rebuildRequestSequence, signal, rebuilt)
          ) return;
          await this.post(request, captureSnapshotIdentity(rebuilt.snapshot), 'OPENED', rebuilt);
          return;
        }
        default:
          await this.postError(request, acceptedIdentity, 'UNSUPPORTED_MESSAGE', 'Unsupported request.', false);
      }
    } catch (error) {
      if (firstRowsRequest) this.hooks.onFirstRowsResult?.({ status: signal?.aborted ? 'cancelled' : 'failed' });
      if (signal?.aborted) {
        return;
      }
      if (!this.isCurrentIdentity(acceptedIdentity)) return;
      if (isTransientSourceChange(error)) {
        const handled = await this.hooks.onTransientSourceChange?.();
        if (!this.isCurrentIdentity(acceptedIdentity)) return;
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
      if (!this.isCurrentIdentity(acceptedIdentity)) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.postError(request, acceptedIdentity, 'REQUEST_FAILED', message, true);
    } finally {
      this.requests.finish(request.requestId);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.requests.cancelAll();
  }

  public cancelActive(): void {
    this.requests.cancelAll();
  }

  private async post<TType extends ExtensionMessage['type']>(
    request: RequestAddress,
    identity: AcceptedRequestIdentity,
    type: TType,
    payload: ExtensionPayload<TType>,
  ): Promise<boolean> {
    return this.postEnvelope<TType>(request, identity, type, payload);
  }

  private async postEnvelope<TType extends ExtensionMessage['type']>(
    request: RequestAddress,
    identity: AcceptedRequestIdentity,
    type: TType,
    payload: ExtensionPayload<TType>,
  ): Promise<boolean> {
    const message = createProtocolEnvelope({
      type,
      documentId: identity.documentId,
      generation: identity.generation,
      ...(identity.epoch === undefined ? {} : { epoch: identity.epoch }),
      requestId: request.requestId,
      payload,
    }) as unknown as ExtensionMessageByType[TType];
    return this.channel.postMessage(message);
  }

  private async postIfCurrent<TType extends ExtensionMessage['type']>(
    request: RequestAddress,
    expectedIdentity: AcceptedRequestIdentity,
    type: TType,
    payload: ExtensionPayload<TType>,
  ): Promise<boolean> {
    if (!this.isCurrentIdentity(expectedIdentity)) return false;
    return this.postEnvelope<TType>(request, expectedIdentity, type, payload);
  }

  private isCurrentIdentity(expectedIdentity: AcceptedRequestIdentity): boolean {
    const current = this.session.getSummary().snapshot;
    return current.documentId === expectedIdentity.documentId
      && current.generation === expectedIdentity.generation
      && current.epoch === expectedIdentity.epoch;
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
      requestId: request.requestId,
      payload: { code, message, recoverable },
    }));
  }
}

function captureSnapshotIdentity(snapshot: SnapshotIdentity): AcceptedRequestIdentity {
  return Object.freeze({
    documentId: snapshot.documentId,
    generation: snapshot.generation,
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
  });
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
