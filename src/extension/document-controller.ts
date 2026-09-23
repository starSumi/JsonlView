import type {
  ColumnSpec,
  DocumentSummary,
  ExtensionMessage,
  FieldStats,
  InsightDimension,
  InsightSummary,
  Predicate,
  ProblemPage,
  RecordDetail,
  RecordRef,
  RowPage,
  RowScanBudget,
  RowSort,
  WebviewRequest,
} from '../shared/types';
import { PROTOCOL_VERSION } from '../shared/types';
import { validateWebviewRequest } from './message-validation';
import { RequestRegistry } from './request-registry';

type ExtensionMessageByType = {
  [TType in ExtensionMessage['type']]: Extract<ExtensionMessage, { type: TType }>;
};

type ExtensionPayload<TType extends ExtensionMessage['type']> = ExtensionMessageByType[TType]['payload'];

export interface RowsRequest {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  limit: number;
  predicate?: Predicate;
  sort?: RowSort;
  sortOffset?: string;
  scanBudget?: RowScanBudget;
}

export interface ProblemsRequest {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  limit: number;
  scanBudget?: RowScanBudget;
}

export interface JsonlSessionPort {
  getSummary(): DocumentSummary;
  getProfileColumns(): readonly ColumnSpec[];
  getRows(request: RowsRequest, signal: AbortSignal): Promise<RowPage>;
  getProblems(request: ProblemsRequest, signal: AbortSignal): Promise<ProblemPage>;
  getDetail(ref: RecordRef, full: boolean, signal: AbortSignal): Promise<RecordDetail>;
  getSchema(offset: number, limit: number, signal: AbortSignal): Promise<{
    fields: FieldStats[];
    totalFields: number;
    complete: boolean;
  }>;
  getInsights(
    dimension: InsightDimension,
    predicate: Predicate | undefined,
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
}

export class DocumentController {
  private readonly requests = new RequestRegistry();
  private disposed = false;
  private rebuildRequestSequence = 0;

  public constructor(
    private readonly session: JsonlSessionPort,
    private readonly channel: MessageChannel,
    private readonly hooks: DocumentControllerHooks = {},
  ) {}

  public async handleMessage(value: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    const validation = validateWebviewRequest(value);
    if (!validation.ok || validation.request === undefined) {
      await this.postError(identityFromUnknown(value), 'INVALID_REQUEST', validation.error ?? 'Invalid request.', false);
      return;
    }
    const request = validation.request;
    const summary = this.session.getSummary();
    if (request.documentId !== summary.snapshot.documentId) {
      await this.postError(request, 'WRONG_DOCUMENT', 'The request belongs to a different document.', false);
      return;
    }
    // Cancellation is a control message for a request that may belong to the
    // previous generation. Keep the document boundary above, but handle it
    // before the generation gate so a rebuild can still stop old work.
    if (request.type === 'CANCEL') {
      this.requests.cancel(request.payload.targetRequestId);
      return;
    }
    if (request.type !== 'READY' && request.generation !== summary.snapshot.generation) {
      await this.postError(request, 'STALE_GENERATION', 'The source file changed. Refreshing the current view is required.', true);
      return;
    }
    if (
      request.type !== 'READY'
      && request.epoch !== undefined
      && summary.snapshot.epoch !== undefined
      && request.epoch !== summary.snapshot.epoch
    ) {
      await this.postError(request, 'STALE_EPOCH', 'The source lifecycle advanced. Refreshing the current view is required.', true);
      return;
    }
    // Keep the generation that the operation actually read. A rebuild may
    // swap the session engine while an awaited request is in flight; such a
    // response must never be relabeled with the newer generation.
    const operationGeneration = summary.snapshot.generation;


    let signal: AbortSignal | undefined;
    try {
      switch (request.type) {
        case 'READY':
          await this.post(request, 'OPENED', summary);
          return;
        case 'GET_ROWS':
          signal = this.requests.startLatest('viewport', request.requestId);
          await this.postIfCurrent(
            request,
            operationGeneration,
            'ROWS',
            await this.session.getRows(request.payload, signal),
          );
          return;
        case 'GET_PROBLEMS':
          signal = this.requests.startLatest('problems', request.requestId);
          await this.postIfCurrent(
            request,
            operationGeneration,
            'PROBLEMS',
            await this.session.getProblems(request.payload, signal),
          );
          return;
        case 'GET_DETAIL':
          signal = this.requests.startLatest('detail', request.requestId);
          await this.postIfCurrent(
            request,
            operationGeneration,
            'DETAIL',
            await this.session.getDetail(request.payload.ref, request.payload.full ?? false, signal),
          );
          return;
        case 'GET_SCHEMA':
          signal = this.requests.startLatest('schema', request.requestId);
          await this.postIfCurrent(
            request,
            operationGeneration,
            'SCHEMA',
            await this.session.getSchema(request.payload.offset, request.payload.limit, signal),
          );
          return;
        case 'GET_INSIGHTS':
          signal = this.requests.startLatest('insights', request.requestId);
          await this.postIfCurrent(
            request,
            operationGeneration,
            'INSIGHTS',
            await this.session.getInsights(request.payload.dimension, request.payload.predicate, signal),
          );
          return;
        case 'SET_PROFILE': {
          signal = this.requests.startLatest('profile', request.requestId);
          const updated = await this.session.setProfile(request.payload.profileId, signal);
          if (!this.isCurrentGeneration(operationGeneration)) return;
          await this.postIfCurrent(request, operationGeneration, 'PROFILE_CHANGED', {
            profileId: updated.profileId,
            columns: [...this.session.getProfileColumns()],
          });
          // PROFILE_CHANGED completes the correlated request on the webview
          // side. Publish the follow-up summary as unsolicited progress so it
          // is accepted after that completion and cannot leave counts stale.
          await this.postIfCurrent({ ...request, requestId: '' }, operationGeneration, 'INDEX_PROGRESS', updated);
          return;
        }
        case 'SET_FOLLOW_MODE':
          await this.postIfCurrent(
            request,
            operationGeneration,
            'INDEX_PROGRESS',
            await this.session.setFollowMode(request.payload.enabled),
          );
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
          await this.post(request, 'OPENED', rebuilt, rebuilt.snapshot.generation);
          return;
        }
        default:
          await this.postError(request, 'UNSUPPORTED_MESSAGE', 'Unsupported request.', false);
      }
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.postError(request, 'REQUEST_FAILED', message, true);
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
    request: Pick<WebviewRequest, 'documentId' | 'generation' | 'requestId'>,
    type: TType,
    payload: ExtensionPayload<TType>,
    generation = this.session.getSummary().snapshot.generation,
  ): Promise<void> {
    await this.postEnvelope<TType>(request, type, payload, generation);
  }

  private async postEnvelope<TType extends ExtensionMessage['type']>(
    request: Pick<WebviewRequest, 'documentId' | 'generation' | 'requestId'>,
    type: TType,
    payload: ExtensionPayload<TType>,
    generation: string,
  ): Promise<void> {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      documentId: request.documentId,
      generation,
      ...(this.session.getSummary().snapshot.epoch === undefined
        ? {}
        : { epoch: this.session.getSummary().snapshot.epoch }),
      requestId: request.requestId,
      payload,
    } as ExtensionMessageByType[TType];
    await this.channel.postMessage(message);
  }

  private async postIfCurrent<TType extends ExtensionMessage['type']>(
    request: Pick<WebviewRequest, 'documentId' | 'generation' | 'requestId'>,
    expectedGeneration: string,
    type: TType,
    payload: ExtensionPayload<TType>,
  ): Promise<boolean> {
    if (!this.isCurrentGeneration(expectedGeneration)) return false;
    await this.postEnvelope<TType>(request, type, payload, expectedGeneration);
    return true;
  }

  private isCurrentGeneration(expectedGeneration: string): boolean {
    return this.session.getSummary().snapshot.generation === expectedGeneration;
  }

  private canPublishRebuild(
    requestSequence: number,
    signal: AbortSignal,
    summary: DocumentSummary,
  ): boolean {
    if (this.disposed || signal.aborted || requestSequence !== this.rebuildRequestSequence) return false;
    const current = this.session.getSummary().snapshot;
    return current.documentId === summary.snapshot.documentId
      && current.generation === summary.snapshot.generation;
  }

  private async postError(
    request: Pick<WebviewRequest, 'documentId' | 'generation' | 'requestId'>,
    code: string,
    message: string,
    recoverable: boolean,
  ): Promise<void> {
    await this.channel.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'ERROR',
      documentId: request.documentId,
      generation: this.session.getSummary().snapshot.generation,
      ...(this.session.getSummary().snapshot.epoch === undefined
        ? {}
        : { epoch: this.session.getSummary().snapshot.epoch }),
      requestId: request.requestId,
      payload: { code, message, recoverable },
    });
  }
}

function identityFromUnknown(value: unknown): Pick<
  WebviewRequest,
  'documentId' | 'generation' | 'requestId'
> {
  if (value !== null && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    return {
      documentId: typeof candidate.documentId === 'string' ? candidate.documentId : 'unknown',
      generation: typeof candidate.generation === 'string' ? candidate.generation : 'unknown',
      requestId: typeof candidate.requestId === 'string' ? candidate.requestId : 'unknown',
    };
  }
  return { documentId: 'unknown', generation: 'unknown', requestId: 'unknown' };
}
