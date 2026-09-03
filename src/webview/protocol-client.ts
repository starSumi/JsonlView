import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type ProtocolEnvelope,
  type WebviewRequest,
} from '../shared/types';
import type { RequestKind } from './state';

export interface MessageTransport {
  postMessage(message: WebviewRequest): void;
}

export interface ProtocolSession {
  documentId: string;
  generation: string;
}

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  generation: string;
}

export type RequestPayload<TType extends WebviewRequest['type']> = Extract<
  WebviewRequest,
  { type: TType }
>['payload'];

const EXTENSION_MESSAGE_TYPES = new Set<ExtensionMessage['type']>([
  'OPENED',
  'ROWS',
  'DETAIL',
  'SCHEMA',
  'INSIGHTS',
  'INDEX_PROGRESS',
  'PROFILE_CHANGED',
  'SOURCE_INVALIDATED',
  'ERROR',
]);

const REQUEST_KIND_BY_TYPE: Record<WebviewRequest['type'], RequestKind> = {
  READY: 'ready',
  GET_ROWS: 'rows',
  GET_DETAIL: 'detail',
  GET_SCHEMA: 'schema',
  GET_INSIGHTS: 'insights',
  SET_PROFILE: 'profile',
  SET_FOLLOW_MODE: 'follow',
  CANCEL: 'rows',
  REBUILD_INDEX: 'rebuild',
};

let requestCounter = 0;

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  requestCounter += 1;
  return `jsonl-view-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ProtocolEnvelope<string, unknown>>;
  return candidate.protocolVersion === PROTOCOL_VERSION
    && typeof candidate.type === 'string'
    && EXTENSION_MESSAGE_TYPES.has(candidate.type as ExtensionMessage['type'])
    && typeof candidate.documentId === 'string'
    && typeof candidate.generation === 'string'
    && typeof candidate.requestId === 'string'
    && 'payload' in candidate;
}

export function shouldAcceptMessage(
  message: ExtensionMessage,
  session: ProtocolSession,
  pending: ReadonlyMap<string, PendingRequest>,
): boolean {
  const request = pending.get(message.requestId);
  if (message.type === 'OPENED') {
    return request?.kind === 'ready'
      || request?.kind === 'rebuild'
      || (message.requestId === '' && message.documentId === session.documentId);
  }
  if (message.documentId !== session.documentId || message.generation !== session.generation) {
    return false;
  }
  if (message.type === 'ERROR') {
    return message.requestId.length === 0 || request?.generation === session.generation;
  }
  if (message.type === 'ROWS') {
    return request?.kind === 'rows' && request.generation === session.generation;
  }
  if (message.type === 'DETAIL') {
    return request?.kind === 'detail' && request.generation === session.generation;
  }
  if (message.type === 'SCHEMA') {
    return request?.kind === 'schema' && request.generation === session.generation;
  }
  if (message.type === 'INSIGHTS') {
    return request?.kind === 'insights' && request.generation === session.generation;
  }
  if (message.type === 'PROFILE_CHANGED') {
    return message.requestId === '' || (request?.kind === 'profile' && request.generation === session.generation);
  }
  if (message.type === 'INDEX_PROGRESS') {
    return message.requestId === ''
      || ((request?.kind === 'follow' || request?.kind === 'rebuild') && request.generation === session.generation);
  }
  if (message.type === 'SOURCE_INVALIDATED') {
    return message.requestId === '';
  }
  return false;
}

function responseCompletesRequest(type: ExtensionMessage['type']): boolean {
  return type === 'OPENED'
    || type === 'ROWS'
    || type === 'DETAIL'
    || type === 'SCHEMA'
    || type === 'INSIGHTS'
    || type === 'INDEX_PROGRESS'
    || type === 'PROFILE_CHANGED'
    || type === 'ERROR';
}

export class VsCodeMessageClient {
  readonly #transport: MessageTransport;
  readonly #pending = new Map<string, PendingRequest>();
  #session: ProtocolSession;

  public constructor(transport: MessageTransport, initialSession: ProtocolSession) {
    this.#transport = transport;
    this.#session = initialSession;
  }

  public get session(): ProtocolSession {
    return this.#session;
  }

  public setSession(session: ProtocolSession): void {
    if (session.generation !== this.#session.generation || session.documentId !== this.#session.documentId) {
      this.#pending.clear();
    }
    this.#session = session;
  }

  public send<TType extends WebviewRequest['type']>(
    type: TType,
    payload: RequestPayload<TType>,
  ): PendingRequest {
    const requestId = createRequestId();
    const kind = REQUEST_KIND_BY_TYPE[type];
    const request: PendingRequest = {
      id: requestId,
      kind,
      generation: this.#session.generation,
    };
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      documentId: this.#session.documentId,
      generation: this.#session.generation,
      requestId,
      payload,
    } as WebviewRequest;
    if (type !== 'CANCEL') {
      this.#pending.set(requestId, request);
    }
    this.#transport.postMessage(envelope);
    return request;
  }

  public cancel(kind: RequestKind): string[] {
    const cancelled: string[] = [];
    for (const request of this.#pending.values()) {
      if (request.kind !== kind) {
        continue;
      }
      cancelled.push(request.id);
      this.#pending.delete(request.id);
      this.send('CANCEL', { targetRequestId: request.id });
    }
    return cancelled;
  }

  public accept(value: unknown): ExtensionMessage | undefined {
    if (!isExtensionMessage(value) || !shouldAcceptMessage(value, this.#session, this.#pending)) {
      return undefined;
    }
    if (value.type === 'OPENED') {
      this.setSession({
        documentId: value.payload.snapshot.documentId,
        generation: value.payload.snapshot.generation,
      });
    }
    if (responseCompletesRequest(value.type)) {
      this.#pending.delete(value.requestId);
    }
    return value;
  }

  public hasPending(kind: RequestKind): boolean {
    for (const request of this.#pending.values()) {
      if (request.kind === kind) {
        return true;
      }
    }
    return false;
  }
}
