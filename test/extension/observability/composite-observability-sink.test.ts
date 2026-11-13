import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  createCompositeObservabilitySink,
  createOtlpMetricSink,
  readOtlpSettings,
  startCompositeObservabilitySink,
  validateOtlpMetricsEndpoint,
  type OtlpMetricSink,
  type OtlpSettings,
} from '../../../src/extension/observability/composite-observability-sink';
import { createObservabilityEvent, type ObservabilityEvent } from '../../../src/extension/observability/observability-contract';
import type { QueryMetricProjection } from '../../../src/extension/observability/otlp-projection';
import { createEphemeralLoopbackTls } from '../../fixtures/ephemeral-tls';

const require = createRequire(import.meta.url);

function settledEvent(overrides: Record<string, unknown> = {}): ObservabilityEvent {
  return createObservabilityEvent('jsonlview.query.settled', {
    stage: 'get_rows', request_seq: 7, outcome: 'completed', delivery: 'accepted',
    abort_observed: false, duration_ms: 12, rows: 4, ...overrides,
  })!;
}

function fakeMetricSink() {
  const recordMetric = vi.fn<(metric: QueryMetricProjection) => void>();
  const revoke = vi.fn<() => void>();
  const shutdown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const sink: OtlpMetricSink = { recordMetric, revoke, shutdown };
  return { sink, recordMetric, revoke, shutdown };
}

describe('composite observability sink OTLP boundary', () => {
  const { cert: testCertificate, key: testPrivateKey } = createEphemeralLoopbackTls();
  it.each([
    ['https://collector.example/v1/metrics', 'https://collector.example/v1/metrics'],
    ['http://localhost:4318/v1/metrics', 'http://localhost:4318/v1/metrics'],
    ['http://127.0.0.1:4318/v1/metrics', 'http://127.0.0.1:4318/v1/metrics'],
    ['http://127.42.9.5:4318/v1/metrics', 'http://127.42.9.5:4318/v1/metrics'],
    ['http://[::1]:4318/v1/metrics', 'http://[::1]:4318/v1/metrics'],
  ])('accepts explicitly selected safe endpoint %s', (input, expected) => {
    expect(validateOtlpMetricsEndpoint(input)).toBe(expected);
  });

  it.each([
    'http://collector.example/v1/metrics',
    'ftp://localhost/v1/metrics',
    'https://user:password@collector.example/v1/metrics',
    'https://collector.example/v1/metrics?token=secret',
    'https://collector.example/v1/metrics#fragment',
    'http://localhost.evil.example/v1/metrics',
    'https://collector.example:443/v1/metrics',
    'https:\\\\collector.example\\v1\\metrics',
    'not a URL',
    '',
  ])('rejects unsafe or ambiguous endpoint %s', (endpoint) => {
    expect(validateOtlpMetricsEndpoint(endpoint)).toBeUndefined();
  });

  it.each([
    {
      name: 'falls back to the legacy pair when neither canonical value is explicit',
      values: {
        'jsonlview.telemetry.otlp.enabled': { globalValue: true },
        'jsonlview.telemetry.otlp.endpoint': { globalValue: 'https://legacy.example/v1/metrics' },
      },
      expected: { enabled: true, endpoint: 'https://legacy.example/v1/metrics' },
      legacyKeysRead: ['jsonlview.telemetry.otlp.enabled', 'jsonlview.telemetry.otlp.endpoint'],
    },
    {
      name: 'preserves an explicitly configured canonical false while falling back for the endpoint',
      values: {
        'jsonlView.telemetry.otlp.enabled': { globalValue: false },
        'jsonlview.telemetry.otlp.enabled': { globalValue: true },
        'jsonlview.telemetry.otlp.endpoint': { globalValue: 'https://legacy.example/v1/metrics' },
      },
      expected: { enabled: false, endpoint: 'https://legacy.example/v1/metrics' },
      legacyKeysRead: ['jsonlview.telemetry.otlp.endpoint'],
    },
    {
      name: 'preserves an explicitly configured canonical empty endpoint while falling back for enabled',
      values: {
        'jsonlView.telemetry.otlp.endpoint': { globalValue: '' },
        'jsonlview.telemetry.otlp.endpoint': { globalValue: 'https://legacy.example/v1/metrics' },
        'jsonlview.telemetry.otlp.enabled': { globalValue: true },
      },
      expected: { enabled: true, endpoint: '' },
      legacyKeysRead: ['jsonlview.telemetry.otlp.enabled'],
    },
    {
      name: 'uses explicit canonical values without consulting either legacy key',
      values: {
        'jsonlView.telemetry.otlp.enabled': { globalValue: true },
        'jsonlView.telemetry.otlp.endpoint': { globalValue: 'https://canonical.example/v1/metrics' },
        'jsonlview.telemetry.otlp.enabled': { globalValue: false },
        'jsonlview.telemetry.otlp.endpoint': { globalValue: 'https://legacy.example/v1/metrics' },
      },
      expected: { enabled: true, endpoint: 'https://canonical.example/v1/metrics' },
      legacyKeysRead: [],
    },
  ])('resolves canonical and legacy machine settings: $name', ({ values, expected, legacyKeysRead }) => {
    const inspect = vi.fn((key: string) => values[key as keyof typeof values]);
    const keysRead: readonly string[] = legacyKeysRead;

    expect(readOtlpSettings(inspect)).toEqual(expected);
    expect(inspect).toHaveBeenCalledWith('jsonlView.telemetry.otlp.enabled');
    expect(inspect).toHaveBeenCalledWith('jsonlView.telemetry.otlp.endpoint');
    for (const key of keysRead) expect(inspect).toHaveBeenCalledWith(key);
    for (const key of ['jsonlview.telemetry.otlp.enabled', 'jsonlview.telemetry.otlp.endpoint']) {
      if (!keysRead.includes(key)) expect(inspect).not.toHaveBeenCalledWith(key);
    }
  });

  it('ignores workspace, folder, and default values when resolving both setting spellings', () => {
    const inspect = vi.fn((key: string) => key === 'jsonlView.telemetry.otlp.enabled'
      ? { workspaceValue: true, workspaceFolderValue: true, defaultValue: false }
      : key === 'jsonlView.telemetry.otlp.endpoint'
        ? { workspaceValue: 'https://workspace.example/v1/metrics', defaultValue: '' }
        : undefined);

    expect(readOtlpSettings(inspect)).toEqual({ enabled: false, endpoint: '' });
  });

  it.each([
    { name: 'disabled even with a valid endpoint', settings: { enabled: false, endpoint: 'https://collector.example/v1/metrics' }, shouldLoad: false },
    { name: 'enabled with an invalid endpoint', settings: { enabled: true, endpoint: 'http://collector.example/v1/metrics' }, shouldLoad: false },
    { name: 'enabled with a valid endpoint', settings: { enabled: true, endpoint: 'https://collector.example/v1/metrics' }, shouldLoad: true },
  ])('enters the lazy OTLP exporter factory only when opted in and valid: $name', async ({ settings, shouldLoad }) => {
    const createMetricSink = vi.fn(() => fakeMetricSink().sink);
    const composite = createCompositeObservabilitySink({ settings, createMetricSink });

    await composite.ready;

    expect(createMetricSink).toHaveBeenCalledTimes(shouldLoad ? 1 : 0);
    await composite.dispose();
  });

  it('emits at most one fixed warning through the injected callback when lazy initialization fails', async () => {
    const writeOutputChannelWarning = vi.fn();
    const localSink = { record: vi.fn() };
    const composite = createCompositeObservabilitySink({
      localSink,
      settings: { enabled: true, endpoint: 'https://one.example/v1/metrics' },
      createMetricSink: vi.fn().mockRejectedValue(new Error('private exporter failure')),
      writeOutputChannelWarning,
    });

    await composite.ready;
    await composite.configure({ enabled: true, endpoint: 'https://two.example/v1/metrics' });
    composite.record(settledEvent());

    expect(writeOutputChannelWarning).toHaveBeenCalledOnce();
    expect(writeOutputChannelWarning).toHaveBeenCalledWith(expect.stringMatching(/OTLP metrics exporter could not be initialized/u));
    expect(JSON.stringify(writeOutputChannelWarning.mock.calls)).not.toMatch(/private|one\.example|two\.example/u);
    expect(localSink.record).toHaveBeenCalledOnce();
    await composite.dispose();
  });

  it('does not create an exporter, timer, or network-capable sink when disabled', async () => {
    const createMetricSink = vi.fn(() => fakeMetricSink().sink);
    const localSink = { record: vi.fn() };
    const composite = createCompositeObservabilitySink({
      localSink,
      settings: { enabled: false, endpoint: 'https://collector.example/v1/metrics' },
      createMetricSink,
    });
    await composite.ready;

    composite.record(settledEvent());
    await composite.dispose();

    expect(createMetricSink).not.toHaveBeenCalled();
    expect(localSink.record).toHaveBeenCalledTimes(1);
  });

  it('skips projection entirely on the disabled path, including local-sink composition', async () => {
    const composite = createCompositeObservabilitySink({ settings: { enabled: false, endpoint: '' } });
    await composite.ready;
    let eventSnapshots = 0;
    const event = new Proxy(settledEvent(), {
      ownKeys(target) {
        eventSnapshots += 1;
        return Reflect.ownKeys(target);
      },
    });

    composite.record(event);
    composite.withLocalSink({ record: () => undefined }).record(event);

    expect(eventSnapshots).toBe(0);
    await composite.dispose();
  });

  it('does not create an exporter for invalid endpoint even when explicitly enabled', async () => {
    const createMetricSink = vi.fn(() => fakeMetricSink().sink);
    const composite = createCompositeObservabilitySink({
      localSink: { record: vi.fn() },
      settings: { enabled: true, endpoint: 'http://collector.example/v1/metrics' },
      createMetricSink,
    });
    await composite.ready;
    await composite.dispose();
    expect(createMetricSink).not.toHaveBeenCalled();
  });

  it('exports only the validated settled duration metric and its three bounded dimensions', async () => {
    const metric = fakeMetricSink();
    const createMetricSink = vi.fn(() => metric.sink);
    const localSink = { record: vi.fn() };
    const composite = createCompositeObservabilitySink({
      localSink,
      settings: { enabled: true, endpoint: 'https://collector.example/v1/metrics' },
      createMetricSink,
    });
    await composite.ready;
    const started = createObservabilityEvent('jsonlview.query.started', { stage: 'get_rows', request_seq: 7 })!;
    const settled = settledEvent({ request_seq: 999, rows: 555 });

    composite.record(started);
    composite.record(settled);

    expect(createMetricSink).toHaveBeenCalledExactlyOnceWith('https://collector.example/v1/metrics');
    expect(localSink.record).toHaveBeenCalledTimes(2);
    expect(metric.recordMetric).toHaveBeenCalledExactlyOnceWith({
      name: 'jsonlview.query.duration', unit: 'ms', value: 12,
      attributes: { outcome: 'completed', delivery: 'accepted', abort_observed: false },
    });
    expect(JSON.stringify(metric.recordMetric.mock.calls)).not.toMatch(/request_seq|rows|timestamp|path|trace_id|span_id/u);
    await composite.dispose();
    expect(metric.shutdown).toHaveBeenCalledOnce();
  });

  it('contains exporter failures so local observation and query settlement continue', async () => {
    const metric = fakeMetricSink();
    metric.recordMetric.mockImplementation(() => { throw new Error('private exporter detail'); });
    metric.shutdown.mockRejectedValue(new Error('private shutdown detail'));
    const localSink = { record: vi.fn() };
    const composite = createCompositeObservabilitySink({
      localSink,
      settings: { enabled: true, endpoint: 'https://collector.example/v1/metrics' },
      createMetricSink: () => metric.sink,
    });
    await composite.ready;

    expect(() => composite.record(settledEvent())).not.toThrow();
    await expect(composite.dispose()).resolves.toBeUndefined();
    expect(localSink.record).toHaveBeenCalledOnce();
  });

  it('reconfigures on explicit enable, endpoint change, and disable without retaining the old exporter', async () => {
    const first = fakeMetricSink();
    const second = fakeMetricSink();
    const createMetricSink = vi.fn()
      .mockReturnValueOnce(first.sink)
      .mockReturnValueOnce(second.sink);
    const composite = createCompositeObservabilitySink({
      localSink: { record: vi.fn() },
      settings: { enabled: false, endpoint: '' },
      createMetricSink,
    });
    await composite.ready;
    const firstConfig: OtlpSettings = { enabled: true, endpoint: 'https://a.example/v1/metrics' };
    const secondConfig: OtlpSettings = { enabled: true, endpoint: 'https://b.example/v1/metrics' };

    await composite.configure(firstConfig);
    composite.record(settledEvent());
    await composite.configure(secondConfig);
    composite.record(settledEvent());
    await composite.configure({ enabled: false, endpoint: secondConfig.endpoint });
    composite.record(settledEvent());

    expect(createMetricSink.mock.calls).toEqual([[firstConfig.endpoint], [secondConfig.endpoint]]);
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(second.shutdown).toHaveBeenCalledOnce();
    expect(first.revoke).toHaveBeenCalledOnce();
    expect(second.revoke).toHaveBeenCalledOnce();
    expect(first.recordMetric).toHaveBeenCalledOnce();
    expect(second.recordMetric).toHaveBeenCalledOnce();
  });

  it('does not permit a stale async shutdown to re-enable an older configuration', async () => {
    const first = fakeMetricSink();
    let finishShutdown!: () => void;
    first.shutdown.mockImplementation(() => new Promise<void>((resolve) => { finishShutdown = resolve; }));
    const next = fakeMetricSink();
    const createMetricSink = vi.fn().mockReturnValueOnce(first.sink).mockReturnValueOnce(next.sink);
    const composite = createCompositeObservabilitySink({
      localSink: { record: vi.fn() },
      settings: { enabled: true, endpoint: 'https://a.example/v1/metrics' },
      createMetricSink,
    });
    await composite.ready;

    const changeToB = composite.configure({ enabled: true, endpoint: 'https://b.example/v1/metrics' });
    const changeToDisabled = composite.configure({ enabled: false, endpoint: '' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finishShutdown();
    await Promise.all([changeToB, changeToDisabled]);
    composite.record(settledEvent());

    expect(createMetricSink).toHaveBeenCalledOnce();
    expect(next.recordMetric).not.toHaveBeenCalled();
  });

  it('subscribes before awaiting the initial factory and reapplies changes made during activation', async () => {
    let completeFactory!: (sink: OtlpMetricSink) => void;
    let signalFactoryStarted!: () => void;
    let onSettingsChange: (() => void) | undefined;
    const factoryStarted = new Promise<void>((resolve) => { signalFactoryStarted = resolve; });
    const stale = fakeMetricSink();
    let currentSettings: OtlpSettings = {
      enabled: true,
      endpoint: 'https://collector.example/v1/metrics',
    };
    const composite = createCompositeObservabilitySink({
      settings: currentSettings,
      createMetricSink: vi.fn(() => {
        signalFactoryStarted();
        return new Promise<OtlpMetricSink>((resolve) => { completeFactory = resolve; });
      }),
    });
    const lifecycle = startCompositeObservabilitySink(
      composite,
      (listener) => {
        onSettingsChange = listener;
        return { dispose: vi.fn() };
      },
      () => currentSettings,
    );

    await factoryStarted;
    expect(onSettingsChange).toBeTypeOf('function');
    currentSettings = { enabled: false, endpoint: '' };
    onSettingsChange?.();
    completeFactory(stale.sink);
    await lifecycle.ready;

    expect(stale.revoke).toHaveBeenCalledOnce();
    expect(stale.shutdown).toHaveBeenCalledOnce();
    composite.record(settledEvent());
    expect(stale.recordMetric).not.toHaveBeenCalled();
    lifecycle.subscription.dispose();
    await composite.dispose();
  });

  it('sends the real OTLP/HTTP metric payload with only the allowlisted resource and attributes', async () => {
    const requests: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    const endpoint = await listen(server);
    const composite = createCompositeObservabilitySink({
      settings: { enabled: true, endpoint },
    });
    await composite.ready;

    const sensitiveEvent = {
      ...settledEvent(),
      timestamp: '2042-01-02T03:04:05.678Z',
      source_path: 'C:\\private\\session.jsonl',
      prompt: 'private prompt text',
      trace_id: 'non-exported-trace-id',
    } as ObservabilityEvent;
    composite.record(sensitiveEvent);
    await composite.forceFlush();
    await composite.dispose();
    await close(server);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers['content-type']).toContain('application/json');
    const payload = JSON.parse(requests[0]!.body) as {
      resourceMetrics: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeMetrics: Array<{ metrics: Array<{ name: string; histogram: { dataPoints: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> } }> }>;
      }>;
    };
    const resourceAttributes = payload.resourceMetrics[0]!.resource.attributes;
    const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
    const pointAttributes = metrics[0]!.histogram.dataPoints[0]!.attributes;

    expect(resourceAttributes).toEqual([{ key: 'service.name', value: { stringValue: 'jsonlview' } }]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.name).toBe('jsonlview.query.duration');
    expect(pointAttributes.map(({ key }) => key).sort()).toEqual(['abort_observed', 'delivery', 'outcome']);
    expect(requests[0]!.body).not.toMatch(/request_seq|rows|source_path|prompt|trace_id|span_id|private|session\.jsonl|2042-01-02T03:04:05\.678Z/u);
  }, 15_000);

  it('does not inherit ambient OTLP headers from either environment variable', async () => {
    const envKeys = ['OTEL_EXPORTER_OTLP_METRICS_HEADERS', 'OTEL_EXPORTER_OTLP_HEADERS'] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS = 'Authorization=Bearer%20ambient-metrics,X-Ambient-Metrics=metrics-secret,Content-Length=0,Transfer-Encoding=identity,Connection=keep-alive,User-Agent=ambient-agent,Host=evil.example';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer%20ambient-generic,X-Ambient-Generic=generic-secret';

    let requestHeaders: Record<string, string | string[] | undefined> | undefined;
    let requestBody = '';
    const server = createServer((request, response) => {
      requestHeaders = request.headers;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBody = Buffer.concat(chunks).toString('utf8');
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    const endpoint = await listen(server);
    let composite: ReturnType<typeof createCompositeObservabilitySink> | undefined;
    try {
      composite = createCompositeObservabilitySink({ settings: { enabled: true, endpoint } });
      await composite.ready;
      composite.record(settledEvent());
      await composite.forceFlush();
      expect(requestHeaders).toBeDefined();
      expect(requestHeaders?.authorization).toBeUndefined();
      expect(requestHeaders?.['x-ambient-metrics']).toBeUndefined();
      expect(requestHeaders?.['x-ambient-generic']).toBeUndefined();
      expect(requestHeaders?.['user-agent']).not.toBe('ambient-agent');
      expect(requestHeaders?.host).not.toBe('evil.example');
      expect(requestHeaders?.['content-length']).not.toBe('0');
      expect(requestBody.startsWith('{')).toBe(true);
      expect(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS).toContain('ambient-metrics');
      expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toContain('ambient-generic');
    } finally {
      await composite?.dispose();
      await close(server);
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not read ambient OTLP certificate or key files during exporter construction', async () => {
    const envKeys = [
      'OTEL_EXPORTER_OTLP_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_CLIENT_KEY',
      'OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
      'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
    ] as const;
    const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const ambientPath = join(process.cwd(), `.jsonlview-ambient-cert-must-not-be-read-${process.pid}-${Date.now()}.pem`);
    const cjsFs = require('node:fs') as typeof import('node:fs');
    const readFileSpy = vi.spyOn(cjsFs, 'readFileSync');
    for (const key of envKeys) process.env[key] = ambientPath;

    let sink: OtlpMetricSink | undefined;
    try {
      sink = await createOtlpMetricSink('https://collector.example/v1/metrics');
      const ambientReads = readFileSpy.mock.calls.filter(([file]) => String(file) === ambientPath);
      expect(ambientReads).toHaveLength(0);
      for (const key of envKeys) expect(process.env[key]).toBe(ambientPath);
    } finally {
      await sink?.shutdown();
      readFileSpy.mockRestore();
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('pins an uncompressed OTLP request despite an ambient compression setting', async () => {
    const key = 'OTEL_EXPORTER_OTLP_METRICS_COMPRESSION';
    const previous = process.env[key];
    process.env[key] = 'gzip';
    let requestHeaders: Record<string, string | string[] | undefined> | undefined;
    let requestBody = '';
    const server = createServer((request, response) => {
      requestHeaders = request.headers;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBody = Buffer.concat(chunks).toString('utf8');
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    const endpoint = await listen(server);
    let composite: ReturnType<typeof createCompositeObservabilitySink> | undefined;
    try {
      composite = createCompositeObservabilitySink({ settings: { enabled: true, endpoint } });
      await composite.ready;
      composite.record(settledEvent());
      await composite.forceFlush();
      expect(requestHeaders?.['content-encoding']).toBeUndefined();
      expect(requestBody.startsWith('{')).toBe(true);
    } finally {
      await composite?.dispose();
      await close(server);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('sends a real HTTPS OTLP payload with the fixture CA explicitly trusted', async () => {
    let requestCount = 0;
    let requestBody = '';
    const server = createHttpsServer({ cert: testCertificate, key: testPrivateKey }, (request, response) => {
      requestCount += 1;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requestBody = Buffer.concat(chunks).toString('utf8');
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    const endpoint = await listenSecure(server);
    const composite = createCompositeObservabilitySink({
      settings: { enabled: true, endpoint },
      createMetricSink: (target) => createOtlpMetricSink(target, { ca: testCertificate }),
    });
    await composite.ready;
    composite.record(settledEvent());
    await composite.forceFlush();
    await composite.dispose();
    await close(server);

    expect(requestCount).toBe(1);
    expect(JSON.parse(requestBody)).toMatchObject({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'jsonlview.query.duration' }] }] }],
    });
  });

  it('does not follow an HTTP redirect or forward metric bodies to another origin', async () => {
    let redirectTargetRequests = 0;
    const target = createServer((_request, response) => {
      redirectTargetRequests += 1;
      response.writeHead(200).end('{}');
    });
    const targetEndpoint = await listen(target);
    const redirect = createServer((_request, response) => {
      response.writeHead(302, { location: targetEndpoint }).end();
    });
    const redirectEndpoint = await listen(redirect);
    const composite = createCompositeObservabilitySink({
      settings: { enabled: true, endpoint: redirectEndpoint },
    });
    await composite.ready;
    composite.record(settledEvent());
    await composite.forceFlush();
    await composite.dispose();
    await Promise.all([close(redirect), close(target)]);

    expect(redirectTargetRequests).toBe(0);
  });

  it('aborts an in-flight request on endpoint change and confines the new export to the new endpoint', async () => {
    let oldRequestCount = 0;
    let newRequestCount = 0;
    let signalOldRequestSeen!: () => void;
    let signalOldResponseClosed!: () => void;
    let releaseOldResponse!: () => void;
    const oldRequestSeen = new Promise<void>((resolve) => { signalOldRequestSeen = resolve; });
    const oldResponseClosed = new Promise<void>((resolve) => { signalOldResponseClosed = resolve; });
    const oldResponseGate = new Promise<void>((resolve) => { releaseOldResponse = resolve; });
    const oldServer = createServer((request, response) => {
      oldRequestCount += 1;
      response.on('close', () => {
        if (!response.writableEnded) signalOldResponseClosed();
      });
      request.on('data', () => {});
      request.on('end', () => {
        signalOldRequestSeen();
        void oldResponseGate.then(() => {
          if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
      });
    });
    const newServer = createServer((request, response) => {
      newRequestCount += 1;
      request.on('data', () => {});
      request.on('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    });
    const oldEndpoint = await listen(oldServer);
    const newEndpoint = await listen(newServer);
    const composite = createCompositeObservabilitySink({
      settings: { enabled: true, endpoint: oldEndpoint },
    });
    await composite.ready;
    composite.record(settledEvent());
    const oldExport = composite.forceFlush();
    await oldRequestSeen;

    const startedAt = performance.now();
    await composite.configure({ enabled: true, endpoint: newEndpoint });
    await oldResponseClosed;
    expect(performance.now() - startedAt).toBeLessThan(1_500);

    composite.record(settledEvent());
    await composite.forceFlush();
    await oldExport;
    await composite.dispose();
    releaseOldResponse();
    await Promise.all([close(oldServer), close(newServer)]);

    expect(oldRequestCount).toBe(1);
    expect(newRequestCount).toBe(1);
  });

  it('blocks a queued 503 Retry-After retry after revocation without another HTTP POST', async () => {
    let requestCount = 0;
    let releaseResponse!: () => void;
    let signalRequestSeen!: () => void;
    let signalResponseFinished!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requestSeen = new Promise<void>((resolve) => { signalRequestSeen = resolve; });
    const responseFinished = new Promise<void>((resolve) => { signalResponseFinished = resolve; });
    let queuedRetry!: () => void;
    const server = createServer((request, response) => {
      requestCount += 1;
      request.on('data', () => {});
      request.on('end', () => {
        signalRequestSeen();
        void responseGate.then(() => {
          response.writeHead(503, { 'retry-after': '0' });
          response.once('finish', signalResponseFinished);
          response.end('retry');
        });
      });
    });
    const endpoint = await listen(server);
    const composite = createCompositeObservabilitySink({
      settings: { enabled: true, endpoint },
      createMetricSink: (target) => createOtlpMetricSink(target, { timeoutMillis: 2_500 }),
    });
    await composite.ready;
    const originalSetTimeout = globalThis.setTimeout;
    let negativeDelayCalls = 0;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((
      ((handler: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => {
        if (delay === -1) {
          negativeDelayCalls += 1;
          queuedRetry = () => {
            if (typeof handler === 'function') handler(...args);
          };
          return undefined as unknown as ReturnType<typeof setTimeout>;
        }
        return Reflect.apply(originalSetTimeout, globalThis, [handler, delay, ...args]) as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout
    ));
    composite.record(settledEvent());
    const inFlight = composite.forceFlush();
    await requestSeen;
    releaseResponse();
    await responseFinished;
    // Hold only the SDK's negative-delay retry callback, so revocation can be
    // tested after the 503 has been parsed but before its retry executes.
    await vi.waitFor(() => expect(queuedRetry).toBeTypeOf('function'), { timeout: 1_000 });
    expect(negativeDelayCalls).toBe(1);
    timeoutSpy.mockRestore();
    // Revoke while the queued retry is held, then execute that callback against
    // the permanently revoked agent. The real Node warning remains an upstream
    // runtime behavior documented in ADR-034.
    const startedAt = performance.now();
    const disabling = composite.configure({ enabled: false, endpoint: '' });
    queuedRetry();
    await Promise.all([inFlight, disabling]);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    composite.record(settledEvent());
    await composite.dispose();
    await close(server);

    expect(requestCount).toBe(1);
  });

  it('cancels an in-flight request on disposal and finishes within the shutdown bound', async () => {
    let requestCount = 0;
    let signalRequestSeen!: () => void;
    let signalResponseClosed!: () => void;
    const requestSeen = new Promise<void>((resolve) => { signalRequestSeen = resolve; });
    const responseClosed = new Promise<void>((resolve) => { signalResponseClosed = resolve; });
    const server = createServer((request, response) => {
      requestCount += 1;
      response.on('close', () => {
        if (!response.writableEnded) signalResponseClosed();
      });
      request.on('data', () => {});
      request.on('end', signalRequestSeen);
    });
    const endpoint = await listen(server);
    const composite = createCompositeObservabilitySink({ settings: { enabled: true, endpoint } });
    await composite.ready;
    composite.record(settledEvent());
    const inFlight = composite.forceFlush();
    await requestSeen;

    const startedAt = performance.now();
    await composite.dispose();
    await responseClosed;
    await inFlight;
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    await close(server);

    expect(requestCount).toBe(1);
  });
});

async function listen(server: NetServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1/metrics`;
}

async function listenSecure(server: NetServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `https://127.0.0.1:${address.port}/v1/metrics`;
}

async function close(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
