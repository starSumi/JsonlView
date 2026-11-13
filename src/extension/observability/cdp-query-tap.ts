import type { RuntimeExecutionIdentity } from '@shared/execution-identity';
import type { ObservabilityEvent } from './observability-contract';
import { isSafeErrorName } from './error-metadata';

const CDP_QUERY_TAP_QUEUE_LIMIT = 8;
const CDP_QUERY_TAP_TIMEOUT_MS = 250;

type CdpQueryEventName = 'jsonlview.query.started' | 'jsonlview.query.settled';
type CdpQueryAttributes = Readonly<Record<string, string | number | boolean>>;

export interface CdpQueryTapEnvelope {
  readonly __jsonlViewCdpQueryTap: 1;
  readonly traceId: string;
  readonly startupId: string;
  readonly eventName: CdpQueryEventName;
  readonly attributes: CdpQueryAttributes;
}

export interface CdpQueryTapTransport {
  postMessage(message: CdpQueryTapEnvelope): PromiseLike<boolean>;
}

export interface CdpQueryTap {
  record(event: ObservabilityEvent): void;
  dispose(): void;
}

const QUERY_OUTCOMES = new Set(['completed', 'stale', 'cancelled', 'failed']);
const QUERY_DELIVERIES = new Set(['accepted', 'rejected', 'skipped', 'failed']);
const QUERY_STALE_REASONS = new Set(['document', 'generation', 'epoch']);

export function isCdpQueryTapEnabled(
  extensionMode: RuntimeExecutionIdentity['extensionMode'],
  optIn: string | undefined,
): boolean {
  return extensionMode === 'development' && optIn === '1';
}

export function createCdpQueryTap(
  transport: CdpQueryTapTransport,
  identity: { readonly traceId: string; readonly startupId: string },
  enabled: boolean,
): CdpQueryTap {
  if (!enabled || !isBoundedSequenceId(identity.traceId) || !isBoundedSequenceId(identity.startupId)) {
    return { record: () => undefined, dispose: () => undefined };
  }

  const tapIdentity = Object.freeze({ traceId: identity.traceId, startupId: identity.startupId });
  const queue: CdpQueryTapEnvelope[] = [];
  let closed = false;
  let inFlight = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let deliveryToken: object | undefined;

  const clearTimeoutIfSet = (): void => {
    if (timeout === undefined) return;
    clearTimeout(timeout);
    timeout = undefined;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    clearTimeoutIfSet();
    deliveryToken = undefined;
    inFlight = false;
  };

  const drain = (): void => {
    if (closed || inFlight || queue.length === 0) return;
    const envelope = queue.shift()!;
    const token = {};
    deliveryToken = token;
    inFlight = true;
    timeout = setTimeout(() => {
      if (deliveryToken !== token) return;
      // A wedged VS Code bridge is terminal for this panel's diagnostic tap.
      // Do not open a second unresolved postMessage or retain queued events.
      close();
    }, CDP_QUERY_TAP_TIMEOUT_MS);

    const settle = (delivered: boolean): void => {
      if (closed || deliveryToken !== token) return;
      if (delivered !== true) {
        // A rejected or false delivery invalidates the paired observation.
        close();
        return;
      }
      clearTimeoutIfSet();
      deliveryToken = undefined;
      inFlight = false;
      drain();
    };
    try {
      void Promise.resolve(transport.postMessage(envelope)).then(
        (delivered) => settle(delivered === true),
        () => settle(false),
      );
    } catch {
      close();
    }
  };

  return {
    record(event) {
      if (closed) return;
      try {
        const envelope = toCdpQueryTapEnvelope(event, tapIdentity);
        if (envelope === undefined) return;
        if (queue.length >= CDP_QUERY_TAP_QUEUE_LIMIT) {
          close();
          return;
        }
        queue.push(envelope);
        drain();
      } catch {
        // This opt-in diagnostic must never participate in request delivery.
        close();
      }
    },
    dispose: close,
  };
}

function toCdpQueryTapEnvelope(
  event: ObservabilityEvent,
  identity: { readonly traceId: string; readonly startupId: string },
): CdpQueryTapEnvelope | undefined {
  if (event.name !== 'jsonlview.query.started' && event.name !== 'jsonlview.query.settled') return undefined;
  const source = event.attributes;
  if (source.stage !== 'get_rows' || !isPositiveSafeInteger(source.request_seq)) return undefined;
  const attributes: Record<string, string | number | boolean> = {
    stage: 'get_rows',
    request_seq: source.request_seq,
  };
  if (event.name === 'jsonlview.query.started') {
    return Object.freeze({
      __jsonlViewCdpQueryTap: 1, traceId: identity.traceId, startupId: identity.startupId,
      eventName: event.name, attributes: Object.freeze(attributes),
    });
  }

  const outcome = source.outcome;
  const delivery = source.delivery;
  if (typeof outcome !== 'string' || !QUERY_OUTCOMES.has(outcome)
    || typeof delivery !== 'string' || !QUERY_DELIVERIES.has(delivery)
    || typeof source.abort_observed !== 'boolean'
    || !isNonnegativeSafeInteger(source.duration_ms)) return undefined;
  attributes.outcome = outcome;
  attributes.delivery = delivery;
  attributes.abort_observed = source.abort_observed;
  attributes.duration_ms = source.duration_ms;
  if (source.rows !== undefined) {
    if (!isNonnegativeSafeInteger(source.rows)) return undefined;
    attributes.rows = source.rows;
  }
  if (outcome === 'stale') {
    if (typeof source.stale_reason !== 'string' || !QUERY_STALE_REASONS.has(source.stale_reason)) return undefined;
    attributes.stale_reason = source.stale_reason;
  } else if (source.stale_reason !== undefined) return undefined;
  if (outcome === 'failed') {
    if (!isSafeErrorName(source.error_name) || (delivery !== 'skipped' && delivery !== 'failed')) return undefined;
    attributes.error_name = source.error_name;
  } else if (source.error_name !== undefined) return undefined;
  if (outcome === 'completed' && delivery !== 'accepted' && delivery !== 'rejected') return undefined;
  if ((outcome === 'stale' || outcome === 'cancelled') && delivery !== 'skipped' && delivery !== 'failed') return undefined;

  return Object.freeze({
    __jsonlViewCdpQueryTap: 1, traceId: identity.traceId, startupId: identity.startupId,
    eventName: event.name, attributes: Object.freeze(attributes),
  });
}

function isBoundedSequenceId(value: string): boolean {
  if (value.length === 0 || value.length > 16) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
