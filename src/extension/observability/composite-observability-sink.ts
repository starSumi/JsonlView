import { isIP } from 'node:net';
import type { Agent as HttpAgent, ClientRequest, ClientRequestArgs } from 'node:http';
import type { Duplex } from 'node:stream';
import { projectQueryMetric, type QueryMetricProjection } from './otlp-projection';
import type { ObservabilityEvent } from './observability-contract';

const SETTLED_METRICS_INTERVAL_MS = 10_000;
const EXPORT_TIMEOUT_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 1_500;
const OTLP_INITIALIZATION_WARNING = 'OTLP metrics exporter could not be initialized; local observability remains active.';
const AMBIENT_OTLP_ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_COMPRESSION',
  'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION',
  'OTEL_EXPORTER_OTLP_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
] as const;
type OtlpMetricExporterConfig = NonNullable<ConstructorParameters<
  typeof import('@opentelemetry/exporter-metrics-otlp-http').OTLPMetricExporter
>[0]>;
type OtlpCompression = NonNullable<OtlpMetricExporterConfig['compression']>;
const OTLP_COMPRESSION_NONE = 'none' as unknown as OtlpCompression;
const revokedMetricSinks = new WeakSet<OtlpMetricSink>();
const OTLP_CONTENT_TYPE = 'application/json';

type AgentAddRequest = {
  addRequest(request: ClientRequest, options: ClientRequestArgs): void;
};

export interface OtlpSettings {
  readonly enabled: boolean;
  readonly endpoint: string;
}

export interface OtlpMetricSink {
  recordMetric(metric: QueryMetricProjection): void;
  forceFlush?(): Promise<void>;
  revoke?(): void;
  shutdown(): Promise<void>;
}

export interface ObservabilitySink {
  record(event: ObservabilityEvent): void;
}

export interface OtlpConfigurationInspection {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
  readonly defaultValue?: unknown;
}

export type OtlpSettingInspector = (key: string) => OtlpConfigurationInspection | undefined;

export function readOtlpSettings(inspect: OtlpSettingInspector): OtlpSettings {
  // These are machine settings. Deliberately read only the user/remote machine
  // value so a repository cannot silently enable export or redirect its endpoint.
  const enabledValue = readSettingValueWithLegacyFallback(
    inspect,
    'jsonlView.telemetry.otlp.enabled',
    'jsonlview.telemetry.otlp.enabled',
  );
  const endpointValue = readSettingValueWithLegacyFallback(
    inspect,
    'jsonlView.telemetry.otlp.endpoint',
    'jsonlview.telemetry.otlp.endpoint',
  );
  return {
    enabled: enabledValue === true,
    endpoint: typeof endpointValue === 'string' ? endpointValue : '',
  };
}

function readSettingValueWithLegacyFallback(
  inspect: OtlpSettingInspector,
  canonicalKey: string,
  legacyKey: string,
): unknown {
  const canonicalValue = inspect(canonicalKey)?.globalValue;
  return canonicalValue === undefined ? inspect(legacyKey)?.globalValue : canonicalValue;
}

export function validateOtlpMetricsEndpoint(endpoint: string): string | undefined {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.trim() !== endpoint) return undefined;
  if (/[\u0000-\u0020\u007f]/u.test(endpoint)) return undefined;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }

  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  if (url.href !== endpoint) return undefined;
  if (url.pathname !== '/v1/metrics') return undefined;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1).toLowerCase()
    : url.hostname.toLowerCase();
  if (url.protocol === 'http:' && !isLoopbackHost(hostname)) return undefined;

  return url.href;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const family = isIP(hostname);
  if (family === 4) return Number(hostname.split('.', 1)[0]) === 127;
  return family === 6 && hostname === '::1';
}

export interface CompositeObservabilitySinkOptions {
  readonly localSink?: ObservabilitySink;
  readonly settings: OtlpSettings;
  readonly createMetricSink?: (endpoint: string) => OtlpMetricSink | Promise<OtlpMetricSink>;
  readonly writeOutputChannelWarning?: (message: string) => void;
}

export interface CompositeObservabilitySink extends ObservabilitySink {
  readonly ready: Promise<void>;
  configure(settings: OtlpSettings): Promise<void>;
  withLocalSink(localSink: ObservabilitySink): ObservabilitySink;
  forceFlush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface OtlpSettingsSubscription {
  dispose(): void;
}

/**
 * Register the configuration listener synchronously before activation awaits
 * an optional dynamic SDK import. Re-read after the initial factory settles so
 * a setting change during that import cannot leave a stale exporter mounted.
 */
export function startCompositeObservabilitySink(
  sink: CompositeObservabilitySink,
  subscribe: (listener: () => void) => OtlpSettingsSubscription,
  readSettings: () => OtlpSettings,
): { readonly subscription: OtlpSettingsSubscription; readonly ready: Promise<void> } {
  const subscription = subscribe(() => {
    void sink.configure(readSettings());
  });
  const ready = sink.ready.then(() => sink.configure(readSettings()));
  return { subscription, ready };
}

/**
 * Keep local event observation independent from the explicitly enabled OTLP
 * metrics projection. The only external point accepted here is the validated
 * settled query-duration metric; raw events never cross the exporter boundary.
 */
export function createCompositeObservabilitySink(
  options: CompositeObservabilitySinkOptions,
): CompositeObservabilitySink {
  const createMetricSink = options.createMetricSink ?? createOtlpMetricSink;
  let activeSink: OtlpMetricSink | undefined;
  let desiredKey: string | undefined;
  let generation = 0;
  let disposed = false;
  let initializationWarningWritten = false;
  let operation: Promise<void> = Promise.resolve();

  const initial = configure(options.settings);

  function configure(settings: OtlpSettings): Promise<void> {
    const endpoint = settings.enabled ? validateOtlpMetricsEndpoint(settings.endpoint) : undefined;
    const nextKey = JSON.stringify([settings.enabled === true, endpoint ?? '']);
    if (nextKey === desiredKey) return operation;
    desiredKey = nextKey;
    const token = ++generation;
    const previous = activeSink;
    activeSink = undefined;
    safelyRevoke(previous);
    const previousOperation = operation;

    operation = (async () => {
      await contain(previousOperation);
      if (previous !== undefined) await boundedShutdown(previous);
      if (disposed || token !== generation || !settings.enabled || endpoint === undefined) return;

      let created: OtlpMetricSink;
      try {
        created = await createMetricSink(endpoint);
      } catch {
        writeInitializationWarning();
        return;
      }
      if (disposed || token !== generation) {
        safelyRevoke(created);
        await boundedShutdown(created);
        return;
      }
      activeSink = created;
    })();
    return operation;
  }

  function record(event: ObservabilityEvent): void {
    safelyRecord(options.localSink, event);
    const sink = activeSink;
    if (sink === undefined) return;
    const metric = projectQueryMetric(event);
    if (metric === undefined) return;
    try {
      sink.recordMetric(metric);
    } catch {
      // Exporter and SDK errors must not change local query settlement.
    }
  }

  function writeInitializationWarning(): void {
    if (initializationWarningWritten) return;
    initializationWarningWritten = true;
    try {
      options.writeOutputChannelWarning?.(OTLP_INITIALIZATION_WARNING);
    } catch {
      // The injected OutputChannel callback cannot affect local observability.
    }
  }

  return {
    ready: initial,
    record,
    configure,
    withLocalSink(localSink) {
      return { record: (event) => {
        safelyRecord(localSink, event);
        const sink = activeSink;
        if (sink === undefined) return;
        const metric = projectQueryMetric(event);
        if (metric === undefined) return;
        try {
          sink.recordMetric(metric);
        } catch {
          // The local sink remains the primary observability path.
        }
      } };
    },
    async forceFlush() {
      await contain(operation);
      try {
        await activeSink?.forceFlush?.();
      } catch {
        // Explicit flush is best-effort and never surfaces telemetry failures.
      }
    },
    async dispose() {
      if (disposed) {
        await boundedWait(operation);
        return;
      }
      disposed = true;
      generation += 1;
      const previous = activeSink;
      activeSink = undefined;
      safelyRevoke(previous);
      await boundedWait(operation);
      const inFlight = activeSink;
      activeSink = undefined;
      if (previous !== undefined) await boundedShutdown(previous);
      if (inFlight !== undefined && inFlight !== previous) await boundedShutdown(inFlight);
    },
  };
}

function safelyRecord(sink: ObservabilitySink | undefined, event: ObservabilityEvent): void {
  try {
    sink?.record(event);
  } catch {
    // Local diagnostics cannot be allowed to interfere with query settlement.
  }
}

async function contain(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // Configuration and exporter lifecycle failures are contained.
  }
}

async function boundedWait(promise: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      contain(promise),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedShutdown(sink: OtlpMetricSink): Promise<void> {
  safelyRevoke(sink);
  await boundedWait(Promise.resolve().then(() => sink.shutdown()));
}

function safelyRevoke(sink: OtlpMetricSink | undefined): void {
  if (sink === undefined || revokedMetricSinks.has(sink)) return;
  revokedMetricSinks.add(sink);
  try {
    sink.revoke?.();
  } catch {
    // A failed revoke still proceeds to bounded SDK shutdown.
  }
}

/** @internal Exported for local HTTP integration tests with a controlled retry window. */
export async function createOtlpMetricSink(
  endpoint: string,
  options: { readonly timeoutMillis?: number; readonly ca?: string | Buffer } = {},
): Promise<OtlpMetricSink> {
  const validatedEndpoint = validateOtlpMetricsEndpoint(endpoint);
  if (validatedEndpoint === undefined) throw new Error('Invalid OTLP metrics endpoint.');
  const timeoutMillis = options.timeoutMillis ?? EXPORT_TIMEOUT_MS;
  // Keep SDK initialization, provider setup, and its periodic timer off the
  // default activation path. Dependencies are loaded only after explicit opt-in.
  const [exporterModule, metricsModule, resourcesModule] = await Promise.all([
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'),
  ]);
  let allowExports = true;
  let revokeAgent = () => {};
  const exporter = constructExporterWithoutAmbientConfiguration(() => new exporterModule.OTLPMetricExporter({
    url: validatedEndpoint,
    timeoutMillis,
    concurrencyLimit: 1,
    compression: OTLP_COMPRESSION_NONE,
    temporalityPreference: metricsModule.AggregationTemporality.DELTA,
    httpAgentOptions: (protocol) => createRevocableAgent(protocol, (revoke) => {
      revokeAgent = revoke;
      if (!allowExports) revokeAgent();
    }, options.ca),
  }));
  const exportWithTransport = exporter.export.bind(exporter);
  const revocableExporter = Object.create(exporter) as typeof exporter;
  revocableExporter.export = (metrics, callback) => {
    if (!allowExports) {
      callback({ code: 0 });
      return;
    }
    exportWithTransport(metrics, callback);
  };
  const reader = new metricsModule.PeriodicExportingMetricReader({
    exporter: revocableExporter,
    exportIntervalMillis: SETTLED_METRICS_INTERVAL_MS,
    exportTimeoutMillis: timeoutMillis,
  });
  const provider = new metricsModule.MeterProvider({
    resource: resourcesModule.resourceFromAttributes({ 'service.name': 'jsonlview' }),
    readers: [reader],
  });
  const duration = provider.getMeter('jsonlview').createHistogram('jsonlview.query.duration', {
    unit: 'ms',
    description: 'Duration of a completed JsonlView query operation.',
  });

  return {
    recordMetric(metric) {
      duration.record(metric.value, metric.attributes);
    },
    forceFlush: () => provider.forceFlush(),
    revoke: () => {
      allowExports = false;
      revokeAgent();
    },
    shutdown: () => provider.shutdown(),
  };
}

/**
 * The upstream exporter reads header, compression, and certificate/key defaults
 * from process.env in its synchronous constructor. Mask those ambient inputs
 * for that one constructor call so a host-wide OTEL setting cannot alter this
 * explicit, content-free metrics boundary or cause an ambient file read. The
 * values are restored immediately.
 */
function constructExporterWithoutAmbientConfiguration<T>(factory: () => T): T {
  const previous = new Map<string, string | undefined>();
  try {
    for (const key of AMBIENT_OTLP_ENV_KEYS) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
    return factory();
  } finally {
    for (const key of AMBIENT_OTLP_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createRevocableAgent(
  protocol: string,
  registerRevoke: (revoke: () => void) => void,
  ca?: string | Buffer,
): Promise<HttpAgent | import('node:https').Agent> {
  if (protocol === 'http:') {
    const { Agent } = await import('node:http');
    let revoked = false;
    class RevocableHttpAgent extends Agent {
      addRequest(request: ClientRequest, options: ClientRequestArgs): void {
        sanitizeOtlpRequestHeaders(request, options);
        callBaseAgentAddRequest(Object.getPrototypeOf(RevocableHttpAgent.prototype) as AgentAddRequest, this, request, options);
      }

      override createConnection(options: ClientRequestArgs, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
        if (revoked) {
          failRevokedConnection(callback);
          return null;
        }
        return super.createConnection(options, callback);
      }

      revoke(): void {
        if (revoked) return;
        revoked = true;
        this.destroy();
      }
    }
    const agent = new RevocableHttpAgent({ keepAlive: false });
    registerRevoke(() => agent.revoke());
    return agent;
  }

  if (protocol === 'https:') {
    const { Agent } = await import('node:https');
    let revoked = false;
    class RevocableHttpsAgent extends Agent {
      addRequest(request: ClientRequest, options: ClientRequestArgs): void {
        sanitizeOtlpRequestHeaders(request, options);
        callBaseAgentAddRequest(Object.getPrototypeOf(RevocableHttpsAgent.prototype) as AgentAddRequest, this, request, options);
      }

      override createConnection(options: ClientRequestArgs, callback?: (error: Error | null, socket: Duplex) => void): Duplex | null | undefined {
        if (revoked) {
          failRevokedConnection(callback);
          return null;
        }
        return super.createConnection(options, callback);
      }

      revoke(): void {
        if (revoked) return;
        revoked = true;
        this.destroy();
      }
    }
    const agentOptions = ca === undefined ? { keepAlive: false } : { keepAlive: false, ca };
    const agent = new RevocableHttpsAgent(agentOptions);
    registerRevoke(() => agent.revoke());
    return agent;
  }

  throw new Error('Unsupported OTLP endpoint protocol.');
}

function sanitizeOtlpRequestHeaders(request: ClientRequest, options: ClientRequestArgs): void {
  const suppliedHeaders = options.headers !== undefined && !Array.isArray(options.headers)
    ? Object.keys(options.headers as Record<string, unknown>).map((key) => key.toLowerCase())
    : [];
  if (options.headers !== undefined && !Array.isArray(options.headers)) {
    const headers = options.headers as Record<string, unknown>;
    // The JSON metrics exporter owns this value. Never let an ambient OTEL
    // header override the serializer's media type or inject transport headers.
    for (const key of Object.keys(headers)) delete headers[key];
    headers['content-type'] = OTLP_CONTENT_TYPE;
  } else if (options.headers !== undefined) {
    options.headers = [];
  }
  // Node copies the options into the ClientRequest before handing it to the
  // Agent. Remove ambient headers from that public request state as well;
  // changing only options.headers leaves them on the wire. Host is retained
  // only when it was generated by Node rather than supplied in options.
  for (const key of request.getHeaderNames()) {
    const normalized = key.toLowerCase();
    if (normalized === 'content-type') request.setHeader(key, OTLP_CONTENT_TYPE);
    else if (normalized === 'host') {
      if (!suppliedHeaders.includes('host')) continue;
      const host = formatRequestHost(options);
      if (host === undefined) request.removeHeader(key);
      else request.setHeader(key, host);
    }
    else request.removeHeader(key);
  }
}

function formatRequestHost(options: ClientRequestArgs): string | undefined {
  const hostname = typeof options.hostname === 'string'
    ? options.hostname
    : typeof options.host === 'string' ? options.host : undefined;
  if (hostname === undefined || hostname.length === 0) return undefined;
  if (options.port === undefined || String(options.port).length === 0) return hostname;
  const bracketed = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${bracketed}:${String(options.port)}`;
}

function callBaseAgentAddRequest(
  basePrototype: AgentAddRequest,
  agent: HttpAgent,
  request: ClientRequest,
  options: ClientRequestArgs,
): void {
  // `addRequest` is the narrow Node hook that lets us sanitize the request
  // after the exporter has built it but before the agent puts it on the wire.
  // Fail closed if a future runtime removes or changes that hook; silently
  // falling back would re-open the ambient-header boundary.
  if (typeof basePrototype.addRequest !== 'function') {
    throw new Error('OTLP exporter transport requires the Node Agent.addRequest hook.');
  }
  Reflect.apply(basePrototype.addRequest, agent, [request, options]);
}

function failRevokedConnection(callback?: (error: Error | null, socket: Duplex) => void): void {
  const error = Object.assign(new Error('OTLP exporter transport has been revoked.'), {
    code: 'ERR_OTLP_EXPORT_REVOKED',
  });
  if (callback === undefined) throw error;
  queueMicrotask(() => callback(error, undefined as unknown as Duplex));
}
