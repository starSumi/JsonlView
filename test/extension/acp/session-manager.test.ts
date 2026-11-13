import { describe, expect, it, vi } from 'vitest';
import process from 'node:process';
import {
  ACP_CANCEL_GRACE_MS,
  ACP_MAX_LINE_BYTES,
  AcpSessionCancelledError,
  AcpSessionManager,
  type AcpProcessFactory,
  type AcpProcessHandle,
  type AcpPermissionOutcome,
} from '../../../src/extension/acp/session-manager';

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

function createHarness(onRequestPermission?: ConstructorParameters<typeof AcpSessionManager>[0]['onRequestPermission']) {
  const process = new FakeProcess();
  const factory = vi.fn<AcpProcessFactory>(() => process);
  const manager = new AcpSessionManager({
    launch: { command: 'fake-agent', args: ['--stdio'], cwd: 'C:/workspace', timeoutMs: 100 },
    processFactory: factory,
    ...(onRequestPermission === undefined ? {} : { onRequestPermission }),
  });
  return { process, factory, manager };
}

describe('ACP session manager', () => {
  it('reports the active protocol stage without letting a progress observer break the connection', async () => {
    const child = new FakeProcess();
    const stages: string[] = [];
    const manager = new AcpSessionManager({
      launch: { command: 'fake-agent', timeoutMs: 100 },
      processFactory: () => child,
      onStage: (stage) => { stages.push(stage); throw new Error('broken observer'); },
    });
    const start = manager.start();
    expect(stages).toEqual(['launch', 'initialize']);
    child.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    expect(stages.at(-1)).toBe('session/new');
    child.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    expect(stages.at(-1)).toBe('session/prompt');
    child.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    manager.close();
  });

  it('exposes the timed-out operation and its limit as structured metadata', async () => {
    vi.useFakeTimers();
    try {
      const { manager } = createHarness();
      const start = manager.start();
      const rejected = expect(start).rejects.toMatchObject({ operation: 'initialize', timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('requires protocol version 1 while allowing adapters to advertise their supported authentication', async () => {
    const incompatible = createHarness();
    const incompatibleStart = incompatible.manager.start();
    incompatible.process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 2 } });
    await expect(incompatibleStart).rejects.toThrow('protocol version 1');
    expect(incompatible.process.writes).toHaveLength(1);
    expect(incompatible.process.kill).toHaveBeenCalledTimes(1);

    const authenticated = createHarness();
    const authenticatedStart = authenticated.manager.start();
    authenticated.process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'oauth' }] } });
    await Promise.resolve();
    expect(authenticated.process.writes[1]).toMatchObject({ method: 'session/new' });
    authenticated.process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 'authenticated' } });
    await expect(authenticatedStart).resolves.toBe('authenticated');
    authenticated.manager.close();
  });

  it('does not attempt authentication when session/new reports authentication required', async () => {
    const { process, manager } = createHarness();
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, authMethods: [{ id: 'login', name: 'Login' }] } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'Authentication required' } });
    await expect(start).rejects.toThrow('Authentication required');
    expect(process.writes).toHaveLength(2);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('replies to unknown agent requests with method-not-found without killing the prompt', async () => {
    const { process, manager } = createHarness();
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    process.emitMessage({ jsonrpc: '2.0', id: 'agent-1', method: 'fs/read_text_file', params: {} });
    expect(process.writes.at(-1)).toEqual({ jsonrpc: '2.0', id: 'agent-1', error: { code: -32601, message: 'Method not found' } });
    expect(process.kill).not.toHaveBeenCalled();
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    manager.close();
  });

  it('defaults tool permission requests to cancelled while preserving the prompt', async () => {
    const { process, manager } = createHarness();
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    process.emitMessage({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 's', toolCall: { toolCallId: 'tool-1', title: 'Read authorized records' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
    } });
    await Promise.resolve();
    expect(process.writes.at(-1)).toEqual({ jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } });
    expect(process.kill).not.toHaveBeenCalled();
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompt;
    manager.close();
  });

  it.each(['cancel', 'close'] as const)('cancels pending permission on %s and ignores a late selection', async (action) => {
    let select: ((outcome: AcpPermissionOutcome) => void) | undefined;
    let permissionSignal: AbortSignal | undefined;
    const permission = vi.fn((_request, signal: AbortSignal) => {
      permissionSignal = signal;
      return new Promise<AcpPermissionOutcome>((resolve) => { select = resolve; });
    });
    const { process, manager } = createHarness(permission);
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    const settled = prompt.catch(() => undefined);
    process.emitMessage({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 's', toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }],
    } });
    manager[action]();
    expect(permissionSignal?.aborted).toBe(true);
    expect(process.writes).toContainEqual({ jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } });
    const writes = process.writes.length;
    select?.({ outcome: 'selected', optionId: 'yes' });
    await Promise.resolve();
    expect(process.writes).toHaveLength(writes);
    if (action === 'cancel') process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
    await settled;
    manager.close();
  });

  it.each(['yes', 'never-offered', 'persistent'])('only returns an offered once permission option (%s)', async (optionId) => {
    const { process, manager } = createHarness(() => ({ outcome: 'selected', optionId }));
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    process.emitMessage({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 's', toolCall: { toolCallId: 'tool-1' },
      options: [
        { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'persistent', name: 'Always allow', kind: 'allow_always' },
      ],
    } });
    await Promise.resolve();
    expect(process.writes.at(-1)).toEqual({ jsonrpc: '2.0', id: 'permission-1', result: { outcome: optionId === 'yes'
      ? { outcome: 'selected', optionId: 'yes' } : { outcome: 'cancelled' } } });
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompt;
    manager.close();
  });

  it('cancels permission for another session without invoking the permission port', async () => {
    const permission = vi.fn(() => ({ outcome: 'selected' as const, optionId: 'yes' }));
    const { process, manager } = createHarness(permission);
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    process.emitMessage({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
      sessionId: 'other', toolCall: { toolCallId: 'tool-1' }, options: [],
    } });
    expect(permission).not.toHaveBeenCalled();
    expect(process.writes.at(-1)).toEqual({ jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } });
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompt;
    manager.close();
  });

  it('bounds permission UI input and request IDs before invoking the port', async () => {
    const permission = vi.fn(() => ({ outcome: 'cancelled' as const }));
    const { process, manager } = createHarness(permission);
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    const valid = { sessionId: 's', toolCall: { toolCallId: 't' }, options: [{ optionId: 'yes', name: 'Read once', kind: 'allow_once' }] };
    for (const params of [
      { ...valid, sessionId: 'x'.repeat(257) },
      { ...valid, toolCall: { toolCallId: 'x'.repeat(257) } },
      { ...valid, toolCall: { toolCallId: 't', title: 42 } },
      { ...valid, toolCall: { toolCallId: 't', title: 'x'.repeat(513) } },
      { ...valid, options: [{ ...valid.options[0], optionId: 'x'.repeat(257) }] },
      { ...valid, options: [{ ...valid.options[0], name: 'x'.repeat(513) }] },
      { ...valid, options: Array.from({ length: 33 }, (_, i) => ({ ...valid.options[0], optionId: String(i) })) },
      { ...valid, options: [valid.options[0], valid.options[0]] },
    ]) {
      process.emitMessage({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params });
      expect(process.writes.at(-1)).toMatchObject({ error: { code: -32602 } });
    }
    process.emitRaw('{"jsonrpc":"2.0","id":1e400,"method":"session/request_permission","params":{}}');
    expect(process.writes.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
    process.emitMessage({ jsonrpc: '2.0', id: 'x'.repeat(257), method: 'session/request_permission', params: valid });
    expect(process.writes.at(-1)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(permission).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    process.emitMessage({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompt;
    manager.close();
  });

  it.each([
    { error: null },
    { error: {} },
    { error: { code: -32000 } },
    { error: { code: 0.5, message: 'invalid' } },
    { error: { code: -32000, message: 'x'.repeat(4097) } },
    { result: {}, error: { code: -32000, message: 'both' } },
    {},
  ])('rejects malformed response fields without throwing or losing the pending prompt', async (fields) => {
    const { process, manager } = createHarness();
    const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await start;
    const prompt = manager.prompt('inspect');
    const rejected = expect(prompt).rejects.toThrow('invalid JSON-RPC');
    expect(() => process.emitMessage({ jsonrpc: '2.0', id: 3, ...fields })).not.toThrow();
    await rejected;
    expect(process.kill).toHaveBeenCalledOnce();
    expect(manager.state).toBe('failed');
    manager.close();
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
  it('ignores updates for a foreign or absent session rather than mixing conversations', async () => {
    const { process } = createHarness(); const onUpdate = vi.fn();
    const manager = new AcpSessionManager({ launch: { command: 'fake-agent', timeoutMs: 100 }, processFactory: () => process, onUpdate });
    const start = manager.start(); process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }); await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }); await start;
    for (const sessionId of ['other', undefined]) process.emitMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { content: 'foreign' } } });
    expect(onUpdate).not.toHaveBeenCalled(); manager.close();
  });
  it.each(['', 'x'.repeat(257)])('rejects an invalid session ID before allowing prompts', async (sessionId) => {
    const { process, manager } = createHarness(); const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }); await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId } });
    await expect(start).rejects.toThrow('sessionId'); expect(manager.state).toBe('failed');
  });
  it('refuses an over-limit outbound prompt before writing the line', async () => {
    const { process, manager } = createHarness(); const start = manager.start();
    process.emitMessage({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }); await Promise.resolve();
    process.emitMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } }); await start;
    await expect(manager.prompt('中'.repeat(ACP_MAX_LINE_BYTES / 2))).rejects.toThrow('line limit');
    expect(process.writes).toHaveLength(2); expect(manager.state).toBe('failed');
  });
  it('preserves UTF-8 characters split across actual ACP stdout and stderr pipe chunks', async () => {
    const updates: unknown[] = []; const stderr: string[] = [];
    const adapter = `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);if(q.method==='session/prompt'){const text=JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'utf8',update:{text:'中文🙂'}}})+'\\n';const bytes=Buffer.from(text);const split=bytes.indexOf(Buffer.from('中'))+1;process.stdout.write(bytes.subarray(0,split));setTimeout(()=>{process.stdout.write(bytes.subarray(split));const log=Buffer.from('中文日志\\n');process.stderr.write(log.subarray(0,1));setTimeout(()=>{process.stderr.write(log.subarray(1));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{stopReason:'end_turn'}})+'\\n');},30);},30);}else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:q.method==='initialize'?{protocolVersion:1}:{sessionId:'utf8'}})+'\\n');});`;
    const manager = new AcpSessionManager({ launch: { command: process.execPath, args: ['-e', adapter], timeoutMs: 2000 },
      onUpdate: (event) => updates.push(event.update), onStderr: (line) => stderr.push(line) });
    try { await manager.start(); await manager.prompt('inspect'); expect(updates).toEqual([{ text: '中文🙂' }]); expect(stderr).toEqual(['中文日志']); }
    finally { await manager.close(); }
  });

  it.skipIf(process.platform === 'win32')('awaits ACP process-tree escalation before close resolves', async () => {
    const adapter = [
      "const { spawn } = require('node:child_process')",
      "const readline = require('node:readline')",
      "process.on('SIGTERM', () => {})",
      "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
      "process.stderr.write(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }) + '\\n')",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => { const request = JSON.parse(line); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize' ? { protocolVersion: 1 } : { sessionId: 'shutdown-test' } }) + '\\n') })",
      'setInterval(() => {}, 1000)',
    ].join(';');
    let descendants: { childPid: number; grandchildPid: number } | undefined;
    const manager = new AcpSessionManager({
      launch: { command: process.execPath, args: ['-e', adapter], timeoutMs: 3000 },
      onStderr: (line) => { try { descendants = JSON.parse(line) as typeof descendants; } catch { /* Ignore non-fixture output. */ } },
    });
    try {
      const starting = manager.start();
      await expect.poll(() => descendants, { timeout: 3000 }).toBeDefined();
      await expect(starting).resolves.toBe('shutdown-test');
      const startedAt = Date.now();
      await expect(manager.close()).resolves.toMatchObject({ outcome: 'terminated' });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
      expect(descendants).toBeDefined();
      await expect.poll(() => descendants !== undefined &&
        !isProcessAlive(descendants.childPid) && !isProcessAlive(descendants.grandchildPid), { timeout: 1000 }).toBe(true);
    } finally {
      await manager.close();
      for (const pid of descendants === undefined ? [] : [descendants.childPid, descendants.grandchildPid]) {
        if (isProcessAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* The process may exit between the probe and cleanup. */ }
        }
      }
    }
  });
});

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
