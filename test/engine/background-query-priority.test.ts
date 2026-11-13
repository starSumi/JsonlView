import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlFileEngine } from '../../src/engine';

const directories: string[] = [];
const engines: JsonlFileEngine[] = [];
const backgroundMethods = ['getBackgroundRows', 'inspectBackgroundRows'] as const;

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(maxQueuedOperations?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-background-query-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.jsonl');
  await writeFile(path, '{"id":0}\n{"id":1}\n{"id":2}\n');
  const engine = await JsonlFileEngine.open(path, {
    ...(maxQueuedOperations === undefined ? {} : { maxQueuedOperations }),
  });
  engines.push(engine);
  return engine;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

type PositionalRead = (
  buffer: Buffer, offset: number, length: number, position: number | bigint | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

function holdNextRead(engine: JsonlFileEngine) {
  const handle = (engine as unknown as { handle: Awaited<ReturnType<typeof open>> }).handle;
  const original = handle.read.bind(handle) as PositionalRead;
  const started = deferred();
  const gate = deferred();
  const spy = vi.spyOn(handle, 'read') as unknown as {
    mockImplementationOnce(read: PositionalRead): void;
    mockRestore(): void;
  };
  spy.mockImplementationOnce(async (buffer, offset, length, position) => {
    started.resolve();
    await gate.promise;
    return original(buffer, offset, length, position);
  });
  return { started: started.promise, release: gate.resolve, restore: () => spy.mockRestore() };
}

describe('background row and profile probe dispatch', () => {
  it.each(backgroundMethods)('dispatches foreground before queued %s without preempting an active read', async (method) => {
    const engine = await fixture();
    const held = holdNextRead(engine);
    const order: string[] = [];
    const observe = (name: string) => () => { if (!order.includes(name)) order.push(name); };
    const active = engine.getRows({ limit: 1, onHydrated: observe('active') });
    try {
      await held.started;
      const background = engine[method]({ limit: 1, onHydrated: observe('background') });
      let blocker: string | undefined;
      const foreground = engine.getRows({
        limit: 1, onHydrated: observe('foreground'),
        onTiming: (timing) => { blocker = timing.queueBlockedBy; },
      });
      expect(order).toEqual([]);
      held.release();
      await Promise.all([active, background, foreground]);
      expect(order).toEqual(['active', 'foreground', 'background']);
      expect(blocker).toBe('get_rows');
    } finally {
      held.release();
      await active.catch(() => undefined);
      held.restore();
    }
  });

  it('keeps opportunistic pages and probes FIFO while retaining their operation names', async () => {
    const engine = await fixture();
    const held = holdNextRead(engine);
    const order: string[] = [];
    const observe = (name: string) => () => { if (!order.includes(name)) order.push(name); };
    const active = engine.getRows({ limit: 1 });
    try {
      await held.started;
      const probe = engine.inspectBackgroundRows({ limit: 1, onHydrated: observe('probe') });
      let blocker: string | undefined;
      const page = engine.getBackgroundRows({
        limit: 1, onHydrated: observe('page'),
        onTiming: (timing) => { blocker = timing.queueBlockedBy; },
      });
      held.release();
      const [, inspection] = await Promise.all([active, probe, page]);
      expect(order).toEqual(['probe', 'page']);
      expect(inspection).not.toHaveProperty('rows');
      expect(blocker).toBe('inspect_rows');
    } finally {
      held.release();
      await active.catch(() => undefined);
      held.restore();
    }
  });

  it.each(backgroundMethods)('applies the existing queue bound to %s', async (method) => {
    const engine = await fixture(1);
    const held = holdNextRead(engine);
    const active = engine.getRows({ limit: 1 });
    try {
      await held.started;
      await expect(engine[method]({ limit: 1 })).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    } finally {
      held.release();
      await active;
      held.restore();
    }
  });

  it.each(backgroundMethods)('cancels queued %s before it reads or hydrates', async (method) => {
    const engine = await fixture();
    const held = holdNextRead(engine);
    const active = engine.getRows({ limit: 1 });
    try {
      await held.started;
      const controller = new AbortController();
      const hydrated = vi.fn();
      const background = engine[method]({ limit: 1, onHydrated: hydrated, signal: controller.signal });
      const result = background.then(() => undefined, (error: unknown) => error);
      controller.abort();
      held.release();
      await active;
      expect(await result).toMatchObject({ code: 'ABORTED' });
      expect(hydrated).not.toHaveBeenCalled();
      await expect(engine.getRows({ limit: 1 })).resolves.toHaveProperty('rows');
    } finally {
      held.release();
      await active.catch(() => undefined);
      held.restore();
    }
  });

  it.each(backgroundMethods)('drains queued %s on disposal after the active read settles', async (method) => {
    const engine = await fixture();
    const held = holdNextRead(engine);
    const active = engine.getRows({ limit: 1 });
    const activeResult = active.then(() => undefined, (error: unknown) => error);
    try {
      await held.started;
      const hydrated = vi.fn();
      const background = engine[method]({ limit: 1, onHydrated: hydrated });
      const backgroundResult = background.then(() => undefined, (error: unknown) => error);
      const closing = engine.dispose();
      held.release();
      await closing;
      expect(await activeResult).toMatchObject({ code: 'ABORTED' });
      expect(await backgroundResult).toMatchObject({ code: 'ABORTED' });
      expect(hydrated).not.toHaveBeenCalled();
      expect(engine.getDiagnostics().open).toBe(false);
      expect(() => engine[method]()).toThrow(/disposed/);
    } finally {
      held.release();
      await activeResult;
      held.restore();
    }
  });
});
