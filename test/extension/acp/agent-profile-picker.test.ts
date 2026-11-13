import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  trusted: false,
  config: {} as Record<string, unknown>,
  get: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() { return host.trusted; },
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => {
        host.get(key);
        return host.config[key] ?? fallback;
      },
    }),
  },
  window: {
    showErrorMessage: (...args: unknown[]) => host.showErrorMessage(...args),
    showInformationMessage: (...args: unknown[]) => host.showInformationMessage(...args),
    showQuickPick: (...args: unknown[]) => host.showQuickPick(...args),
  },
  CancellationTokenSource: class CancellationTokenSource {
    readonly token = { isCancellationRequested: false };
    cancel(): void { this.token.isCancellationRequested = true; }
    dispose(): void {}
  },
}));

import { selectConfiguredAcpAgentProfile } from '../../../src/extension/acp/agent-profile-picker';

describe('ACP agent profile selection', () => {
  beforeEach(() => {
    host.trusted = false;
    host.config = {};
    host.get.mockReset();
    host.showErrorMessage.mockReset();
    host.showInformationMessage.mockReset();
    host.showQuickPick.mockReset();
  });

  it('checks workspace trust before reading profile settings or showing a picker', async () => {
    await expect(selectConfiguredAcpAgentProfile(vi.fn())).resolves.toBeUndefined();

    expect(host.showErrorMessage).toHaveBeenCalledWith('ACP agents can only be launched in a trusted workspace.');
    expect(host.get).not.toHaveBeenCalled();
    expect(host.showQuickPick).not.toHaveBeenCalled();
  });

  it('uses the native picker only after trust and validation succeed', async () => {
    host.trusted = true;
    host.config.profiles = [
      { id: 'one', label: 'Agent One', command: 'agent-one', args: [], timeoutMs: 10_000 },
      { id: 'two', label: 'Agent Two', command: 'agent-two', args: [], timeoutMs: 10_000 },
    ];
    host.showQuickPick.mockImplementation(async (items: Array<{ profileId: string }>) => items[1]);

    await expect(selectConfiguredAcpAgentProfile(vi.fn())).resolves.toMatchObject({ id: 'two' });

    expect(host.showQuickPick).toHaveBeenCalledOnce();
  });

  it('cancels the native picker and rejects its late selection when activation closes', async () => {
    host.trusted = true;
    host.config.profiles = [
      { id: 'one', label: 'Agent One', command: 'agent-one', args: [], timeoutMs: 10_000 },
      { id: 'two', label: 'Agent Two', command: 'agent-two', args: [], timeoutMs: 10_000 },
    ];
    let resolvePicker!: (value: unknown) => void;
    let token!: { isCancellationRequested: boolean };
    host.showQuickPick.mockImplementation((_items: unknown, _options: unknown, cancellation: typeof token) => {
      token = cancellation;
      return new Promise((resolve) => { resolvePicker = resolve; });
    });
    const cancellation = new AbortController();
    const selecting = selectConfiguredAcpAgentProfile(vi.fn(), cancellation.signal);

    cancellation.abort();
    expect(token.isCancellationRequested).toBe(true);
    resolvePicker({ profileId: 'one' });
    await expect(selecting).resolves.toBeUndefined();
  });
});
