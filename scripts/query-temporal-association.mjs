const EVENT_STARTED = 'jsonlview.query.started';
const EVENT_SETTLED = 'jsonlview.query.settled';
const ALLOWED_ATTRIBUTES = new Set([
  'stage',
  'request_seq',
  'outcome',
  'delivery',
  'abort_observed',
  'duration_ms',
  'rows',
  'stale_reason',
  'error_name',
]);
const OUTCOMES = new Set(['completed', 'stale', 'cancelled', 'failed']);
const DELIVERIES = new Set(['accepted', 'rejected', 'skipped', 'failed']);
const STALE_REASONS = new Set(['document', 'generation', 'epoch']);
export const MAX_QUERY_TAP_EVENTS = 8;

function fail(reason) {
  throw new Error(`Query temporal association failed closed: ${reason}.`);
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('event shape is invalid');
  const eventKeys = Object.keys(event);
  if (eventKeys.some((key) => !['traceId', 'startupId', 'eventName', 'attributes'].includes(key))) {
    fail('event envelope exceeds the allowlist');
  }
  const { traceId, startupId, eventName, attributes } = event;
  if (!Object.hasOwn(event, 'traceId') || !Object.hasOwn(event, 'startupId') || !Object.hasOwn(event, 'eventName')
    || !Object.hasOwn(event, 'attributes') || !isIdentifier(traceId) || !isIdentifier(startupId)) {
    fail('correlation identity is invalid');
  }
  if (eventName !== EVENT_STARTED && eventName !== EVENT_SETTLED) fail('event name is unsupported');
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) fail('attributes are invalid');
  const keys = Object.keys(attributes);
  if (keys.some((key) => !ALLOWED_ATTRIBUTES.has(key))) fail('attributes exceed the allowlist');
  if (attributes.stage !== 'get_rows' || !Number.isSafeInteger(attributes.request_seq) || attributes.request_seq < 1) {
    fail('query identity is invalid');
  }
  for (const key of ['stage', 'request_seq']) {
    if (!Object.hasOwn(attributes, key)) fail('query identity is inherited or missing');
  }
  if (eventName === EVENT_STARTED) {
    if (keys.length !== 2) fail('start event has unexpected attributes');
    return { traceId, startupId, eventName, stage: attributes.stage, requestSeq: attributes.request_seq };
  }
  for (const key of ['outcome', 'delivery', 'abort_observed', 'duration_ms']) {
    if (!Object.hasOwn(attributes, key)) fail('settled terminal attributes are inherited or missing');
  }
  if (!OUTCOMES.has(attributes.outcome) || !DELIVERIES.has(attributes.delivery)
    || typeof attributes.abort_observed !== 'boolean' || !isNonnegativeSafeInteger(attributes.duration_ms)) {
    fail('settled event terminal attributes are invalid');
  }
  if (attributes.rows !== undefined && !isNonnegativeSafeInteger(attributes.rows)) fail('row count is invalid');
  if (attributes.stale_reason !== undefined && !STALE_REASONS.has(attributes.stale_reason)) fail('stale reason is invalid');
  if (attributes.error_name !== undefined && !isIdentifier(attributes.error_name)) fail('error name is invalid');
  if ((attributes.outcome === 'stale') !== (attributes.stale_reason !== undefined)) fail('stale reason does not match outcome');
  if ((attributes.outcome === 'failed') !== (attributes.error_name !== undefined)) fail('error name does not match outcome');
  return {
    traceId, startupId, eventName, stage: attributes.stage, requestSeq: attributes.request_seq,
    outcome: attributes.outcome, delivery: attributes.delivery, abortObserved: attributes.abort_observed,
    hostDurationMs: attributes.duration_ms,
  };
}

function validateDomTransition(domTransition) {
  if (!domTransition || typeof domTransition !== 'object' || Array.isArray(domTransition)) fail('DOM transition is missing');
  const { direction, fromPage, toPage, cursorFirstOrdinal, mountedOrdinal, webviewElapsedMs } = domTransition;
  const delta = direction === 'next' ? 1 : direction === 'previous' ? -1 : 0;
  if (delta === 0 || !Number.isSafeInteger(fromPage) || fromPage < 1 || !Number.isSafeInteger(toPage) || toPage < 1
    || toPage !== fromPage + delta || !Number.isSafeInteger(cursorFirstOrdinal)
    || cursorFirstOrdinal < 0 || mountedOrdinal !== cursorFirstOrdinal
    || !Number.isFinite(webviewElapsedMs) || webviewElapsedMs < 0) {
    fail('DOM state did not advance by one page');
  }
}

/** Associate one bounded host query window with one committed Webview page transition by time only. */
export function pairQueryTemporalAssociation({ events, overflow = false, outOfWindowEvents = 0, domTransition }) {
  if (overflow) fail('host event window overflowed');
  if (!Number.isSafeInteger(outOfWindowEvents) || outOfWindowEvents !== 0) fail('host event arrived outside its click window');
  if (!Array.isArray(events) || events.length !== 2 || events.length > MAX_QUERY_TAP_EVENTS) {
    fail('host event window did not contain exactly one pair');
  }
  const started = normalizeEvent(events[0]);
  const settled = normalizeEvent(events[1]);
  if (started.eventName !== EVENT_STARTED || settled.eventName !== EVENT_SETTLED) fail('host events are unmatched or out of order');
  if (started.traceId !== settled.traceId || started.startupId !== settled.startupId
    || started.stage !== settled.stage || started.requestSeq !== settled.requestSeq) {
    fail('host correlation identity changed within the pair');
  }
  if (settled.outcome !== 'completed' || settled.delivery !== 'accepted' || settled.abortObserved) {
    fail('host query did not complete and deliver successfully');
  }
  validateDomTransition(domTransition);
  return Object.freeze({
    association: 'bounded-temporal-co-occurrence-only',
    causalAttribution: false,
    direction: domTransition.direction,
    hostDurationMs: settled.hostDurationMs,
    webviewElapsedMs: Number(domTransition.webviewElapsedMs.toFixed(3)),
  });
}

/** Return aggregate timings without implying that the click caused the host query. */
export function summarizeQueryTemporalAssociation(samples) {
  if (!Array.isArray(samples) || samples.length === 0) fail('no paired samples were measured');
  const summarize = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    const percentile = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
    const round = (value) => Number(value.toFixed(3));
    return {
      sampleCount: sorted.length,
      minMs: round(sorted[0]),
      p50Ms: round(percentile(0.5)),
      p95Ms: round(percentile(0.95)),
      maxMs: round(sorted.at(-1)),
    };
  };
  return Object.freeze({
    associatedSampleCount: samples.length,
    association: 'bounded-temporal-co-occurrence-only',
    causalAttribution: false,
    percentileMethod: 'nearest-rank',
    hostQueryDuration: summarize(samples.map((sample) => sample.hostDurationMs)),
    webviewClickToDomSettle: summarize(samples.map((sample) => sample.webviewElapsedMs)),
    clocks: Object.freeze({ host: 'extension-host-performance.now', webview: 'window.performance.now' }),
    presentationGuaranteed: false,
  });
}
