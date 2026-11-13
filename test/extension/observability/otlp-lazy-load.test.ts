import { describe, expect, it, vi } from 'vitest';

const loadedOtlpModules = vi.hoisted((): string[] => []);

vi.mock('@opentelemetry/exporter-metrics-otlp-http', async (importOriginal) => {
  loadedOtlpModules.push('@opentelemetry/exporter-metrics-otlp-http');
  return await importOriginal();
});
vi.mock('@opentelemetry/sdk-metrics', async (importOriginal) => {
  loadedOtlpModules.push('@opentelemetry/sdk-metrics');
  return await importOriginal();
});
vi.mock('@opentelemetry/resources', async (importOriginal) => {
  loadedOtlpModules.push('@opentelemetry/resources');
  return await importOriginal();
});

const { createCompositeObservabilitySink, createOtlpMetricSink } = await import('../../../src/extension/observability/composite-observability-sink');

describe('OTLP runtime lazy loading', () => {
  it('rejects an invalid direct factory endpoint before loading SDK modules', async () => {
    await expect(createOtlpMetricSink('http://collector.example/v1/metrics')).rejects.toThrow('Invalid OTLP metrics endpoint.');
    expect(loadedOtlpModules).toEqual([]);
  });

  it.each([
    {
      name: 'stays unloaded when disabled',
      settings: { enabled: false, endpoint: 'https://collector.example/v1/metrics' },
      expectedNewModules: [],
    },
    {
      name: 'stays unloaded for an invalid endpoint',
      settings: { enabled: true, endpoint: 'http://collector.example/v1/metrics' },
      expectedNewModules: [],
    },
    {
      name: 'loads only after explicit opt-in with a valid endpoint',
      settings: { enabled: true, endpoint: 'https://collector.example/v1/metrics' },
      expectedNewModules: [
        '@opentelemetry/exporter-metrics-otlp-http',
        '@opentelemetry/resources',
        '@opentelemetry/sdk-metrics',
      ],
    },
  ])('keeps SDK and exporter modules lazy: $name', async ({ settings, expectedNewModules }) => {
    const previousCount = loadedOtlpModules.length;
    const composite = createCompositeObservabilitySink({ settings });

    await composite.ready;

    expect(loadedOtlpModules.slice(previousCount).sort()).toEqual([...expectedNewModules].sort());
    await composite.dispose();
  });
});
