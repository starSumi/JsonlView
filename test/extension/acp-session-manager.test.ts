import { describe, expect, it, vi } from 'vitest';
import {
  ACP_CANCEL_GRACE_MS,
  AcpSessionCancelledError,
  AcpSessionManager,
  type AcpProcessFactory,
  type AcpProcessHandle,
} from '../../src/extension/acp-session-manager';

class FakeProcess implements AcpProcessHandle {
  readonly writes: unknown[] = [];
  readonly kill = vi.fn();
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(error?: Error) => void>();

  writeLine(line: string): void {
    this.writes.push(JSON.parse(line));
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitMessage(message: unknown): void {
    const line = JSON.stringify(message);
    for (const listener of this.lineListeners) listener(line);
  }

  emitRaw(line: string): void {
    for (const listener of this.lineListeners) listener(line);
  }

  emitStderr(line: string): void {
    for (const listener of this.stderrListeners) listener(line);
  }

  emitExit(error?: Error): void {
    for (const listener of this.exitListeners) listener(error);
  }
}

function createHarness() {
  const process = new FakeProcess();
  const factory = vi.fn<AcpProcessFactory>(() => process);
  const manager = new AcpSessionManager({
    launch: { command: 'fake-agent', args: ['--stdio'], cwd: 'C:/workspace', timeoutMs: 100 },
    processFactory: factory,
  });
  return { process, factory, manager };
}

describe('ACP session manager', () => {
  it('does not spawn until explicit start and performs initialize/session/new over JSON-RPC', async () => {
    const { process, factory, manager } = createHarness();
    expect(factory).not.toHaveBeenCalled();

    const start = manager.start();
    expect(factory).toHaveBeenCalledWith({
      command: 'fake-agent',
      args: ['--stdio'],
      cwd: 'C:/workspace',
    });
    expect(process.writes).toEqual([
      expect.objectContaining({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    ]);
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    expect(process.writes).toHaveLength(2);
    expect(process.writes[1]).toEqual(expect.objectContaining({ id: 2, method: 'session/new' }));
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } });

    await expect(start).resolves.toBe('session-1');
    expect(manager.state).toBe('ready');
    expect(manager.activeSessionId).toBe('session-1');
  });

  it('keeps stderr outside protocol and forwards session updates while prompting', async () => {
    const { process } = createHarness();
    const stderr = vi.fn();
    const update = vi.fn();
    const session = new AcpSessionManager({
      launch: { command: 'fake-agent', timeoutMs: 100 },
      processFactory: () => process,
      onStderr: stderr,
      onUpdate: update,
    });
    const start = session.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    process.emitStderr('agent log');
    expect(stderr).toHaveBeenCalledWith('agent log');

    const prompt = session.prompt('inspect the selected record');
    expect(process.writes[2]).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 's', prompt: [{ type: 'text', text: 'inspect the selected record' }] },
    });
    process.emitMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { type: 'agent_message_chunk' } } });
    expect(update).toHaveBeenCalledWith({ sessionId: 's', update: { type: 'agent_message_chunk' } });
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    expect(session.state).toBe('ready');
  });

  it('waits for a cancelled prompt terminal response and continues forwarding trailing updates', async () => {
    const { process } = createHarness();
    const update = vi.fn();
    const session = new AcpSessionManager({
      launch: { command: 'fake-agent', timeoutMs: 100 },
      processFactory: () => process,
      onUpdate: update,
    });
    const start = session.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;

    const prompt = session.prompt('long running');
    session.cancel();
    expect(process.writes.at(-1)).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } });
    expect(session.state).toBe('prompting');
    process.emitMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { type: 'agent_message_chunk' } } });
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    expect(update).toHaveBeenCalledWith({ sessionId: 's', update: { type: 'agent_message_chunk' } });
    expect(session.state).toBe('ready');
  });

  it('kills the process when a cancelled prompt ignores the grace deadline', async () => {
    vi.useFakeTimers();
    try {
      const { process, manager } = createHarness();
      const start = manager.start();
      process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
      await Promise.resolve();
      process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
      await start;

      const prompt = manager.prompt('long running');
      manager.cancel();
      const rejected = expect(prompt).rejects.toBeInstanceOf(AcpSessionCancelledError);
      await vi.advanceTimersByTimeAsync(ACP_CANCEL_GRACE_MS);
      await rejected;
      expect(process.kill).toHaveBeenCalledTimes(1);
      expect(manager.state).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels startup by killing the process and does not create a session', async () => {
    const { process, manager } = createHarness();
    const start = manager.start();
    manager.cancel();

    await expect(start).rejects.toBeInstanceOf(AcpSessionCancelledError);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.writes.map((message) => (message as { method: string }).method)).toEqual(['initialize']);
    expect(manager.state).toBe('failed');
  });

  it('does not create a session when startup is cancelled after initialize completes', async () => {
    const { process, manager } = createHarness();
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    manager.cancel();

    await expect(start).rejects.toBeInstanceOf(AcpSessionCancelledError);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(process.writes.map((message) => (message as { method: string }).method)).toEqual(['initialize']);
  });

  it('requires protocol version 1 and rejects agents requiring unsupported authentication', async () => {
    const incompatible = createHarness();
    const incompatibleStart = incompatible.manager.start();
    incompatible.process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 2 } });
    await expect(incompatibleStart).rejects.toThrow('protocol version 1');
    expect(incompatible.process.writes).toHaveLength(1);
    expect(incompatible.process.kill).toHaveBeenCalledTimes(1);

    const authenticated = createHarness();
    const authenticatedStart = authenticated.manager.start();
    authenticated.process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'oauth' }] } });
    await expect(authenticatedStart).rejects.toThrow('authentication');
    expect(authenticated.process.writes).toHaveLength(1);
    expect(authenticated.process.kill).toHaveBeenCalledTimes(1);
  });

  it('treats the ACP cancelled-request response as cancellation only after user cancellation', async () => {
    const { process, manager } = createHarness();
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;

    const prompt = manager.prompt('cancel me');
    manager.cancel();
    process.emitMessage({ jsonrpc: '2.0', id: 3, error: { code: -32800, message: 'Cancelled' } });
    await expect(prompt).rejects.toBeInstanceOf(AcpSessionCancelledError);
    expect(manager.state).toBe('ready');
  });

  it('fails closed on malformed output and request timeout, killing only the ACP process', async () => {
    const malformed = createHarness();
    const start = malformed.manager.start();
    malformed.process.emitRaw('{malformed');
    await expect(start).rejects.toThrow('invalid JSON');
    expect(malformed.process.kill).toHaveBeenCalledTimes(1);
    expect(malformed.manager.state).toBe('failed');

    const timedOut = createHarness();
    const timeoutStart = timedOut.manager.start();
    await expect(timeoutStart).rejects.toThrow('timed out');
    expect(timedOut.process.kill).toHaveBeenCalledTimes(1);
    expect(timedOut.manager.state).toBe('failed');
  });
});
