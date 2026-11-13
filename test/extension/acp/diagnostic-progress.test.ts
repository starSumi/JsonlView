import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAcpDiagnosticProgress } from '../../../src/extension/acp/diagnostic-progress';

const host = vi.hoisted(() => ({
  messages: [] as string[],
  status: { text: '', show: vi.fn(), dispose: vi.fn() },
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15 },
  window: {
    createStatusBarItem: () => host.status,
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({
      report: ({ message }: { message: string }) => host.messages.push(message),
    }, { isCancellationRequested: false }),
  },
}));

describe('native ACP progress lifecycle', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); host.messages.length = 0; });

  it.each(['completed', 'failed'] as const)('keeps elapsed time visible and releases its timer when %s', async (outcome) => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const operation = withAcpDiagnosticProgress(async (progress) => {
      progress.report('initialize');
      await barrier;
      if (outcome === 'failed') throw new Error('connection failed');
    });
    const settled = operation.catch((error: unknown) => error);
    expect(host.status.text).toContain('initialize');
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.status.text).toContain('elapsed 2 s');
    finish?.();
    const result = await settled;
    expect(result instanceof Error).toBe(outcome === 'failed');
    expect(host.status.dispose).toHaveBeenCalledOnce();
    const renders = host.messages.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.messages).toHaveLength(renders);
    expect(vi.getTimerCount()).toBe(0);
  });
});
