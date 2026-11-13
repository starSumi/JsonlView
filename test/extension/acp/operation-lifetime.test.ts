import { describe, expect, it, vi } from 'vitest';
import { AcpOperationLifetime } from '../../../src/extension/acp/operation-lifetime';

describe('ACP operation lifetime', () => {
  it('waits for a pending profile selection and prevents it from launching after close', async () => {
    const lifetime = new AcpOperationLifetime();
    lifetime.open();
    let resolveProfile!: () => void;
    let launched = false;
    const operation = lifetime.run(async () => {
      await new Promise<void>((resolve) => { resolveProfile = resolve; });
      if (!lifetime.isOpen) return;
      launched = true;
    });
    await vi.waitFor(() => expect(resolveProfile).toBeTypeOf('function'));

    let closed = false;
    const closing = lifetime.close().then(() => { closed = true; });
    expect(lifetime.isOpen).toBe(false);
    expect(lifetime.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    resolveProfile();
    await Promise.all([operation, closing]);

    expect(launched).toBe(false);
    expect(closed).toBe(true);
  });

  it('does not admit operations after close and can reopen on a new activation', async () => {
    const lifetime = new AcpOperationLifetime();
    lifetime.open();
    expect(lifetime.signal.aborted).toBe(false);
    await lifetime.close();
    const operation = vi.fn(async () => {});

    await lifetime.run(operation);
    expect(operation).not.toHaveBeenCalled();

    lifetime.open();
    await lifetime.run(operation);
    expect(operation).toHaveBeenCalledOnce();
  });
});
