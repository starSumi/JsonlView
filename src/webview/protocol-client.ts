import {
  type ExtensionMessage,
  type WebviewOutboundRequest,
  type WebviewRequest,
} from '@shared/types';
import { createProtocolEnvelope, isExtensionMessage } from '@shared/transport';
import type { RequestKind } from './shared/request-state';
import { isRevealAckPayload, type RevealAckPayload } from '@shared/contracts/reveal';

export { isExtensionMessage };

export interface MessageTransport {
  postMessage(message: WebviewOutboundRequest): void;
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

const REQUEST_KIND_BY_TYPE: Record<WebviewRequest['type'], RequestKind> = {
  LOOKUP_LINEAGE_RECORD: 'lineage',
  GET_GRAPH: 'graph',
  REVEAL_GRAPH_RECORD: 'graphReveal',
  READY: 'ready',
  GET_ROWS: 'rows',
  GET_PROBLEMS: 'problems',
  GET_DETAIL: 'detail',
  OPEN_RECORD_TEXT: 'ready',
  GET_SCHEMA: 'schema',
  GET_INSIGHTS: 'insights',
  SET_PROFILE: 'profile',
  SET_FOLLOW_MODE: 'follow',
  SET_ROW_ORDER: 'order',
  OPEN_SESSION_NAVIGATOR: 'ready',
  SAVE_PREVIEW_AS: 'ready',
  DIAGNOSE_ERROR: 'ready',
  CANCEL: 'rows',
  REBUILD_INDEX: 'rebuild',
  REVEAL_ACK: 'ready',
};

let requestCounter = 0;

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  requestCounter += 1;
  return `jsonl-view-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function shouldAcceptMessage(
  message: ExtensionMessage,
  session: ProtocolSession,
  pending: ReadonlyMap<string, PendingRequest>,
  retiredGenerations: ReadonlySet<string> = new Set(),
): boolean {
  // Protocol v1 messages from older Hosts had no delivery field. A non-empty
  // id can only be a correlated reply (or the established host REVEAL request);
  // empty-id broadcasts always require the explicit v1 delivery marker.
  const delivery = message.delivery ?? (message.requestId.length === 0
    ? undefined : message.type === 'REVEAL' ? 'request' : 'reply');
  const request = pending.get(message.requestId);
  if (message.type === 'OPENED') {
    if (!openedSnapshotMatchesEnvelope(message)) {
      return false;
    }
    if (retiredGenerations.has(message.payload.snapshot.generation)) {
      return false;
    }
    if (!acceptOpenedEpoch(message, session)) return false;
    if (delivery === 'reply' && request?.kind === 'ready') {
      // READY starts from a bootstrap identity, so the opened document may
      // legitimately differ from the request's initial document id.
      return true;
    }
    if (delivery === 'reply' && request?.kind === 'rebuild') {
      return message.documentId === session.documentId;
    }
    return delivery === 'broadcast' && message.documentId === session.documentId;
  }
  if (!acceptEpoch(message.epoch, session.epoch)) return false;
  if (message.documentId !== session.documentId || message.generation !== session.generation) {
    return false;
  }
  if (message.type === 'ERROR') {
    return delivery === 'broadcast' || (delivery === 'reply' && request?.generation === session.generation);
  }
  if (message.type === 'PREVIEW_STATUS') return delivery === 'broadcast';
  if (message.type === 'NAVIGATOR_VISIBILITY') return delivery === 'broadcast';
  if (message.type === 'NAVIGATOR_STATUS') {
    return delivery === 'reply' && request?.kind === 'ready' && request.generation === session.generation;
  }
  if (message.type === 'ROWS') {
    return delivery === 'reply' && request?.kind === 'rows' && request.generation === session.generation;
  }
  if (message.type === 'GRAPH') return delivery === 'reply' && request?.kind === 'graph' && request.generation === session.generation;
  if (message.type === 'LINEAGE_LOOKUP_RESULT') return delivery === 'reply' && request?.kind === 'lineage' && request.generation === session.generation;
  if (message.type === 'GRAPH_REVEAL_RESULT') return delivery === 'reply' && request?.kind === 'graphReveal' && request.generation === session.generation;
  if (message.type === 'PROBLEMS') {
    return delivery === 'reply' && request?.kind === 'problems' && request.generation === session.generation;
  }
  if (message.type === 'DETAIL') {
    return delivery === 'reply' && request?.kind === 'detail' && request.generation === session.generation;
  }
  if (message.type === 'SCHEMA') {
    return delivery === 'reply' && request?.kind === 'schema' && request.generation === session.generation;
  }
  if (message.type === 'INSIGHTS') {
    return delivery === 'reply' && request?.kind === 'insights' && request.generation === session.generation;
  }
  if (message.type === 'PROFILE_CHANGED') {
    return delivery === 'broadcast'
      || (delivery === 'reply' && request?.kind === 'profile' && request.generation === session.generation);
  }
  if (message.type === 'ROW_ORDER_CHANGED') {
    return delivery === 'reply' && request?.kind === 'order' && request.generation === session.generation;
  }
  if (message.type === 'INDEX_PROGRESS') {
    return delivery === 'broadcast'
      || (delivery === 'reply' && (request?.kind === 'follow' || request?.kind === 'rebuild')
        && request.generation === session.generation);
  }
  if (message.type === 'SOURCE_INVALIDATED') {
    return delivery === 'broadcast';
  }
  if (message.type === 'REVEAL') {
    return delivery === 'request' && message.requestId.length > 0 && message.epoch === session.epoch
      && message.payload.sourceId.length > 0
      && message.payload.generation === message.generation
      && message.payload.nativeId.length > 0
      && message.payload.anchorOrdinal.length > 0;
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
  return type === 'LINEAGE_LOOKUP_RESULT' || type === 'GRAPH' || type === 'GRAPH_REVEAL_RESULT' || type === 'OPENED'
    || type === 'ROWS'
    || type === 'PROBLEMS'
    || type === 'DETAIL'
    || type === 'SCHEMA'
    || type === 'INSIGHTS'
    || type === 'INDEX_PROGRESS'
    || type === 'PROFILE_CHANGED'
    || type === 'ROW_ORDER_CHANGED'
    || type === 'NAVIGATOR_STATUS'
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
  #reveal: Extract<ExtensionMessage, { type: 'REVEAL' }> | undefined;

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
      this.#reveal = undefined;
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
    const envelope = createProtocolEnvelope({
      type,
      documentId: this.#session.documentId,
      generation: this.#session.generation,
      ...(this.#session.epoch === undefined ? {} : { epoch: this.#session.epoch }),
      delivery: 'request',
      requestId,
      payload,
    }) as WebviewOutboundRequest;
    // Diagnostic handoff is a one-way host action; it has no correlated
    // response and must not leave an unbounded pending entry behind.
    if (type !== 'CANCEL' && type !== 'DIAGNOSE_ERROR' && type !== 'REVEAL_ACK' && type !== 'OPEN_RECORD_TEXT') {
      this.#pending.set(requestId, request);
    }
    this.#transport.postMessage(envelope);
    return request;
  }

  public acknowledgeReveal(message: Extract<ExtensionMessage, { type: 'REVEAL' }>, payload: RevealAckPayload): void {
    if (this.#reveal !== message || !isRevealAckPayload(payload) || payload.anchorOrdinal !== message.payload.anchorOrdinal
      || message.documentId !== this.#session.documentId || message.generation !== this.#session.generation
      || message.epoch !== this.#session.epoch) return;
    this.#reveal = undefined;
    this.#transport.postMessage(createProtocolEnvelope({ type: 'REVEAL_ACK', documentId: message.documentId,
      generation: message.generation, ...(message.epoch === undefined ? {} : { epoch: message.epoch }),
      delivery: 'reply', requestId: message.requestId, payload }) as WebviewOutboundRequest);
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
    if (value.type === 'REVEAL') this.#reveal = value;
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
