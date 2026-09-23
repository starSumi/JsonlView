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
  epoch?: number;
}

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  generation: string;
  epoch?: number;
}

export type RequestPayload<TType extends WebviewRequest['type']> = Extract<
  WebviewRequest,
  { type: TType }
>['payload'];

const EXTENSION_MESSAGE_TYPES = new Set<ExtensionMessage['type']>([
  'OPENED',
  'ROWS',
  'PROBLEMS',
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
  GET_PROBLEMS: 'problems',
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
    && (candidate.epoch === undefined || (Number.isSafeInteger(candidate.epoch) && candidate.epoch >= 0))
    && typeof candidate.requestId === 'string'
    && 'payload' in candidate;
}

export function shouldAcceptMessage(
  message: ExtensionMessage,
  session: ProtocolSession,
  pending: ReadonlyMap<string, PendingRequest>,
  retiredGenerations: ReadonlySet<string> = new Set(),
): boolean {
  const request = pending.get(message.requestId);
  if (message.type === 'OPENED') {
    if (!openedSnapshotMatchesEnvelope(message)) {
      return false;
    }
    if (retiredGenerations.has(message.payload.snapshot.generation)) {
      return false;
    }
    if (!acceptOpenedEpoch(message, session)) return false;
    if (request?.kind === 'ready') {
      // READY starts from a bootstrap identity, so the opened document may
      // legitimately differ from the request's initial document id.
      return true;
    }
    if (request?.kind === 'rebuild') {
      return message.documentId === session.documentId;
    }
    return message.requestId === '' && message.documentId === session.documentId;
  }
  if (!acceptEpoch(message.epoch, session.epoch)) return false;
  if (message.documentId !== session.documentId || message.generation !== session.generation) {
    return false;
  }
  if (message.type === 'ERROR') {
    return message.requestId.length === 0 || request?.generation === session.generation;
  }
  if (message.type === 'ROWS') {
    return request?.kind === 'rows' && request.generation === session.generation;
  }
  if (message.type === 'PROBLEMS') {
    return request?.kind === 'problems' && request.generation === session.generation;
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

function acceptEpoch(messageEpoch: number | undefined, sessionEpoch: number | undefined): boolean {
  return messageEpoch === undefined || sessionEpoch === undefined || messageEpoch === sessionEpoch;
}

function acceptOpenedEpoch(
  message: Extract<ExtensionMessage, { type: 'OPENED' }>,
  session: ProtocolSession,
): boolean {
  const messageEpoch = message.epoch ?? message.payload.snapshot.epoch;
  if (messageEpoch === undefined || session.epoch === undefined) return true;
  if (messageEpoch < session.epoch) return false;
  if (messageEpoch === session.epoch && message.generation !== session.generation) return false;
  return true;
}

function openedSnapshotMatchesEnvelope(
  message: Extract<ExtensionMessage, { type: 'OPENED' }>,
): boolean {
  const snapshot = message.payload?.snapshot;
  return snapshot !== undefined
    && typeof snapshot.documentId === 'string'
    && typeof snapshot.generation === 'string'
    && message.documentId === snapshot.documentId
    && message.generation === snapshot.generation
    && (message.epoch === undefined
      || snapshot.epoch === undefined
      || message.epoch === snapshot.epoch);
}

function responseCompletesRequest(type: ExtensionMessage['type']): boolean {
  return type === 'OPENED'
    || type === 'ROWS'
    || type === 'PROBLEMS'
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
  // This closes the regression path for generations the client has already
  // observed. Legacy protocol messages may omit the optional monotonic epoch,
  // so unseen same-document generations without ordering metadata remain
  // producer-trust-bound; epoch-bearing messages are ordered explicitly.
  readonly #retiredGenerations = new Set<string>();
  #session: ProtocolSession;

  public constructor(transport: MessageTransport, initialSession: ProtocolSession) {
    this.#transport = transport;
    this.#session = initialSession;
  }

  public get session(): ProtocolSession {
    return this.#session;
  }

  public setSession(session: ProtocolSession): void {
    const identityChanged = session.generation !== this.#session.generation
      || session.documentId !== this.#session.documentId;
    const epochChanged = session.epoch !== this.#session.epoch;
    if (identityChanged || epochChanged) {
      if (identityChanged && this.#session.generation.length > 0) {
        this.#retiredGenerations.add(this.#session.generation);
      }
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
      ...(this.#session.epoch === undefined ? {} : { epoch: this.#session.epoch }),
    };
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      documentId: this.#session.documentId,
      generation: this.#session.generation,
      ...(this.#session.epoch === undefined ? {} : { epoch: this.#session.epoch }),
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
    if (!isExtensionMessage(value) || !shouldAcceptMessage(value, this.#session, this.#pending, this.#retiredGenerations)) {
      return undefined;
    }
    if (value.type === 'OPENED') {
      this.setSession({
        documentId: value.payload.snapshot.documentId,
        generation: value.payload.snapshot.generation,
        ...(value.epoch === undefined && value.payload.snapshot.epoch === undefined
          ? {}
          : { epoch: value.epoch ?? value.payload.snapshot.epoch }),
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
