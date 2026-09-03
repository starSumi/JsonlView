import type {
  DocumentSummary,
  ExtensionMessage,
  FieldStats,
  InsightDimension,
  InsightSummary,
  Predicate,
  RecordDetail,
  RecordRef,
  RowPage,
  WebviewRequest,
} from '../shared/types';
import { PROTOCOL_VERSION } from '../shared/types';
import { validateWebviewRequest } from './message-validation';
import { RequestRegistry } from './request-registry';

export interface RowsRequest {
  anchorOrdinal?: string;
  direction?: 'forward' | 'backward';
  limit: number;
  predicate?: Predicate;
}

export interface JsonlSessionPort {
  getSummary(): DocumentSummary;
  getRows(request: RowsRequest, signal: AbortSignal): Promise<RowPage>;
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

export class DocumentController {
  private readonly requests = new RequestRegistry();
  private disposed = false;

  public constructor(
    private readonly session: JsonlSessionPort,
    private readonly channel: MessageChannel,
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
    if (request.type !== 'READY' && request.generation !== summary.snapshot.generation) {
      await this.postError(request, 'STALE_GENERATION', 'The source file changed. Refreshing the current view is required.', true);
      return;
    }

    if (request.type === 'CANCEL') {
      this.requests.cancel(request.payload.targetRequestId);
      return;
    }

    let signal: AbortSignal | undefined;
    try {
      switch (request.type) {
        case 'READY':
          await this.post(request, 'OPENED', summary);
          return;
        case 'GET_ROWS':
          signal = this.requests.startLatest('viewport', request.requestId);
          await this.post(request, 'ROWS', await this.session.getRows(request.payload, signal));
          return;
        case 'GET_DETAIL':
          signal = this.requests.startLatest('detail', request.requestId);
          await this.post(
            request,
            'DETAIL',
            await this.session.getDetail(request.payload.ref, request.payload.full ?? false, signal),
          );
          return;
        case 'GET_SCHEMA':
          signal = this.requests.startLatest('schema', request.requestId);
          await this.post(
            request,
            'SCHEMA',
            await this.session.getSchema(request.payload.offset, request.payload.limit, signal),
          );
          return;
        case 'GET_INSIGHTS':
          signal = this.requests.startLatest('insights', request.requestId);
          await this.post(
            request,
            'INSIGHTS',
            await this.session.getInsights(request.payload.dimension, request.payload.predicate, signal),
          );
          return;
        case 'SET_PROFILE': {
          signal = this.requests.startLatest('profile', request.requestId);
          const updated = await this.session.setProfile(request.payload.profileId, signal);
          await this.post(request, 'PROFILE_CHANGED', {
            profileId: updated.profileId,
            columns: [],
          });
          await this.post(request, 'INDEX_PROGRESS', updated);
          return;
        }
        case 'SET_FOLLOW_MODE':
          await this.post(
            request,
            'INDEX_PROGRESS',
            await this.session.setFollowMode(request.payload.enabled),
          );
          return;
        case 'REBUILD_INDEX':
          signal = this.requests.startLatest('rebuild', request.requestId);
          await this.post(request, 'OPENED', await this.session.rebuild(signal));
          return;
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
    payload: Extract<ExtensionMessage, { type: TType }>['payload'],
  ): Promise<void> {
    await this.channel.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type,
      documentId: request.documentId,
      generation: this.session.getSummary().snapshot.generation,
      requestId: request.requestId,
      payload,
    } as Extract<ExtensionMessage, { type: TType }>);
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
