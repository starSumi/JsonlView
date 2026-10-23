import { describe, expect, it, vi } from 'vitest';
import {
  RustQueryAdapter,
  type NativeQueryBindingProbe,
} from '../../src/extension/native/rust-query-adapter';
import { RUST_QUERY_SCHEMA, RustQueryBridge, type RustQueryResult } from '../../src/extension/rust-query-bridge';

const page: RustQueryResult = {
  schema: RUST_QUERY_SCHEMA,
  snapshot: { sizeBytes: '3', modifiedUnixMillis: '1' },
  records: [{ ordinal: '0', startByte: '0', endByte: '3', raw: 'row' }],
  nextOrdinal: null,
  truncated: false,
};

const request = { sourcePath: 'C:/authorized/data.jsonl' } as const;

function bridge(binding?: { queryRecords: (sourcePath: string, startOrdinal: string, limit: number, maxBytes: number) => string }): RustQueryBridge {
  return new RustQueryBridge({
    allowedRoots: ['C:/authorized'],
    ...(binding === undefined ? {} : { binding: { abiVersion: () => 2, capabilities: () => 4, queryRecords: binding.queryRecords } }),
  });
}

function fallback() {
  return vi.fn(async () => page);
}

describe('RustQueryAdapter', () => {
  it('keeps a validated native page on the native path', async () => {
    const portable = fallback();
    const native = vi.fn(() => JSON.stringify({ ...page, truncationReason: null }));
    const outcome = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), portable }).query(request, new AbortController().signal);
    expect(outcome).toMatchObject({ path: 'native', result: page });
    expect(native).toHaveBeenCalledOnce();
    expect(portable).not.toHaveBeenCalled();
  });

  it('uses the portable reader when the addon is missing after path authorization', async () => {
    const portable = fallback();
    const outcome = await new RustQueryAdapter({ bridge: bridge(), portable }).query(request, new AbortController().signal);
    expect(outcome).toMatchObject({ path: 'portable', fallbackReason: 'missing-binary', result: page });
    expect(portable).toHaveBeenCalledWith(request, expect.any(AbortSignal));
  });

  it('rejects an unsupported ABI before invoking the native query', async () => {
    const native = vi.fn(() => page as unknown as string);
    const portable = fallback();
    const probe: NativeQueryBindingProbe = { abiVersion: () => 1, capabilities: () => 4 };
    const authorize = vi.fn();
    const outcome = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), nativeBinding: probe, authorize, portable }).query(request, new AbortController().signal);
    expect(outcome).toMatchObject({ path: 'portable', fallbackReason: 'unsupported-native' });
    expect(authorize).toHaveBeenCalledWith(request.sourcePath);
    expect(native).not.toHaveBeenCalled();
  });

  it('rejects a binding without the query capability before invoking native', async () => {
    const native = vi.fn(() => page as unknown as string);
    const portable = fallback();
    const probe: NativeQueryBindingProbe = { abiVersion: () => 2, capabilities: () => 1 };
    const outcome = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), nativeBinding: probe, authorize: vi.fn(), portable }).query(request, new AbortController().signal);
    expect(outcome).toMatchObject({ path: 'portable', fallbackReason: 'unsupported-native' });
    expect(native).not.toHaveBeenCalled();
  });

  it('falls back when the native operation reports an exhausted budget', async () => {
    const portable = fallback();
    const native = vi.fn(() => { throw new Error('jsonl-query:record-exceeds-max-bytes'); });
    const outcome = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), portable }).query(request, new AbortController().signal);
    expect(outcome).toMatchObject({ path: 'portable', fallbackReason: 'budget-exhausted' });
    expect(native).toHaveBeenCalledOnce();
  });

  it('routes a pre-cancelled request to the portable reader without touching native', async () => {
    const portable = fallback();
    const native = vi.fn(() => JSON.stringify(page));
    const controller = new AbortController();
    controller.abort();
    const outcome = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), portable }).query(request, controller.signal);
    expect(outcome).toMatchObject({ path: 'portable', fallbackReason: 'cancelled' });
    expect(native).not.toHaveBeenCalled();
  });

  it('discards a native result when cancellation becomes visible at the boundary', async () => {
    const portable = fallback();
    const controller = new AbortController();
    const native = vi.fn(() => {
      controller.abort();
      return JSON.stringify(page);
    });
    const outcome = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), portable }).query(request, controller.signal);
    expect(outcome).toMatchObject({ path: 'portable', fallbackReason: 'cancelled' });
    expect(portable).toHaveBeenCalledOnce();
  });

  it('falls back on invalid native output while preserving authorization failures', async () => {
    const portable = fallback();
    const native = vi.fn(() => '{}');
    const invalid = await new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), portable }).query(request, new AbortController().signal);
    expect(invalid).toMatchObject({ path: 'portable', fallbackReason: 'native-failure' });

    const unauthorized = { sourcePath: 'C:/private/data.jsonl' } as const;
    await expect(new RustQueryAdapter({ bridge: bridge({ queryRecords: native }), portable }).query(unauthorized, new AbortController().signal)).rejects.toThrow(/authorized roots/iu);
    expect(portable).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a raw binding probe has no host authorization callback', async () => {
    const portable = fallback();
    const probe: NativeQueryBindingProbe = { abiVersion: () => 2, capabilities: () => 4 };
    await expect(new RustQueryAdapter({ bridge: bridge(), nativeBinding: probe, portable }).query(request, new AbortController().signal)).rejects.toThrow(/authorization/iu);
    expect(portable).not.toHaveBeenCalled();
  });
});
