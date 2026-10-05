import { afterEach, describe, expect, it, vi } from 'vitest';

describe('packaged newline scanner process fuse', () => {
  const originalFilename = Object.getOwnPropertyDescriptor(globalThis, '__filename');

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.doUnmock('node:module');
    vi.resetModules();
    if (originalFilename === undefined) {
      Reflect.deleteProperty(globalThis, '__filename');
    } else {
      Object.defineProperty(globalThis, '__filename', originalFilename);
    }
  });

  it('fuses an already-active peer after another packaged scanner fails', async () => {
    let nativeCalls = 0;
    const binding = {
      abiVersion: () => 2,
      capabilities: () => 1,
      scanLf(_chunk: Uint8Array, _start: number, _limit: number): Uint32Array {
        nativeCalls += 1;
        if (nativeCalls === 2) throw new Error('sentinel native failure');
        return new Uint32Array([1]);
      },
    };

    vi.resetModules();
    vi.doMock('node:fs', () => ({ existsSync: () => true }));
    vi.doMock('node:module', () => ({ createRequire: () => () => binding }));
    Object.defineProperty(globalThis, '__filename', {
      configurable: true,
      value: 'E:\\jsonl-view-test\\dist\\extension.cjs',
    });

    const { createNewlineScanner } = await import('../../src/engine/newline-scanner');
    const peer = createNewlineScanner({ mode: 'native' });
    const failing = createNewlineScanner({ mode: 'native' });

    expect(peer.scan(Buffer.from('a\nb'))).toMatchObject({ count: 1 });
    expect(failing.scan(Buffer.from('a\nb'))).toMatchObject({ count: 1 });
    expect(nativeCalls).toBe(2);
    expect(failing.diagnostics()).toMatchObject({
      activeMode: 'node',
      fallbackReason: expect.stringContaining('sentinel native failure'),
    });

    expect(peer.scan(Buffer.from('a\nb'))).toMatchObject({ count: 1 });
    expect(nativeCalls).toBe(2);
    expect(peer.diagnostics()).toMatchObject({
      activeMode: 'node',
      fallbackReason: expect.stringContaining('process fuse'),
    });
  });
});
