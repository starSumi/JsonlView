import { spawn } from 'node:child_process';

export const ACP_CLIENT_NAME = 'JsonlView';
export const ACP_PROTOCOL_VERSION = 1;
export const ACP_DEFAULT_TIMEOUT_MS = 10_000;
export const ACP_MAX_LINE_BYTES = 1_048_576;

export type AcpSessionState = 'idle' | 'starting' | 'ready' | 'prompting' | 'closed' | 'failed';

export interface AcpLaunchOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly clientInfo?: { readonly name: string; readonly title?: string; readonly version: string };
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
  readonly sessionCwd?: string;
  readonly sessionMcpServers?: readonly unknown[];
}

export interface AcpProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface AcpProcessHandle {
  writeLine(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onStderr(listener: (line: string) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  kill(): void;
}

export type AcpProcessFactory = (spec: AcpProcessSpec) => AcpProcessHandle;

export interface AcpSessionUpdate {
  readonly sessionId?: string;
  readonly update: unknown;
}

export interface AcpSessionManagerOptions {
  readonly launch: AcpLaunchOptions;
  readonly processFactory?: AcpProcessFactory;
  readonly onUpdate?: (update: AcpSessionUpdate) => void;
  readonly onStderr?: (line: string) => void;
}

export type AcpPromptContent =
  | string
  | readonly { readonly type: 'text'; readonly text: string }[];

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
    this.code = code;
    this.data = data;
  }
}

export class AcpSessionTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`ACP ${operation} timed out after ${timeoutMs} ms`);
    this.name = 'AcpSessionTimeoutError';
  }
}

export class AcpSessionCancelledError extends Error {
  constructor() {
    super('ACP prompt was cancelled');
    this.name = 'AcpSessionCancelledError';
  }
}

type JsonRpcId = number | string;

interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly operation: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class AcpSessionManager {
  private readonly launch: AcpLaunchOptions;
  private readonly processFactory: AcpProcessFactory;
  private readonly onUpdate: ((update: AcpSessionUpdate) => void) | undefined;
  private readonly onStderr: ((line: string) => void) | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private process: AcpProcessHandle | undefined;
  private nextId = 1;
  private sessionId: string | undefined;
  private stateValue: AcpSessionState = 'idle';
  private promptRequestId: number | undefined;
  private intentionalClose = false;

  constructor(options: AcpSessionManagerOptions) {
    this.launch = options.launch;
    this.processFactory = options.processFactory ?? createNodeAcpProcess;
    this.onUpdate = options.onUpdate;
    this.onStderr = options.onStderr;
  }

  get state(): AcpSessionState {
    return this.stateValue;
  }

  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Starts an explicitly requested local ACP process. The constructor never connects. */
  async start(): Promise<string> {
    if (this.stateValue !== 'idle') {
      throw new Error(`ACP session cannot start from state ${this.stateValue}`);
    }
    this.stateValue = 'starting';
    this.intentionalClose = false;
    try {
      this.process = this.processFactory({
        command: this.launch.command,
        args: [...(this.launch.args ?? [])],
        ...(this.launch.cwd === undefined ? {} : { cwd: this.launch.cwd }),
        ...(this.launch.env === undefined ? {} : { env: this.launch.env }),
      });
      this.process.onLine((line) => this.handleLine(line));
      this.process.onStderr((line) => this.onStderr?.(line));
      this.process.onExit((error) => this.handleExit(error));

      await this.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: this.launch.clientInfo ?? { name: ACP_CLIENT_NAME, version: '0.0.0' },
        clientCapabilities: this.launch.clientCapabilities ?? {},
      }, 'initialize');

      const result = await this.request(
        'session/new',
        {
          cwd: this.launch.sessionCwd ?? this.launch.cwd ?? process.cwd(),
          mcpServers: [...(this.launch.sessionMcpServers ?? [])],
        },
        'session/new',
      );
      const id = readSessionId(result);
      if (id === undefined) throw new Error('ACP session/new response did not include sessionId');
      this.sessionId = id;
      this.stateValue = 'ready';
      return id;
    } catch (error) {
      this.fail(asError(error));
      throw error;
    }
  }

  async prompt(content: AcpPromptContent): Promise<unknown> {
    if (this.stateValue !== 'ready' || this.sessionId === undefined) {
      throw new Error(`ACP prompt requires a ready session, current state is ${this.stateValue}`);
    }
    this.stateValue = 'prompting';
    const prompt = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : [...content];
    const requestId = this.nextId;
    this.promptRequestId = requestId;
    try {
      return await this.request('session/prompt', { sessionId: this.sessionId, prompt }, 'session/prompt');
    } finally {
      if (this.promptRequestId === requestId) this.promptRequestId = undefined;
      if (this.stateValue === 'prompting') this.stateValue = 'ready';
    }
  }

  cancel(): void {
    if (this.stateValue !== 'prompting' || this.sessionId === undefined) return;
    this.writeNotification('session/cancel', { sessionId: this.sessionId });
    const requestId = this.promptRequestId;
    if (requestId !== undefined) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined) {
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(new AcpSessionCancelledError());
      }
    }
    this.promptRequestId = undefined;
    this.stateValue = 'ready';
  }

  close(): void {
    if (this.stateValue === 'closed') return;
    this.intentionalClose = true;
    this.rejectAll(new Error('ACP session closed'));
    this.process?.kill();
    this.process = undefined;
    this.sessionId = undefined;
    this.promptRequestId = undefined;
    this.stateValue = 'closed';
  }

  private request(method: string, params: unknown, operation: string): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.launch.timeoutMs ?? ACP_DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpSessionTimeoutError(operation, timeoutMs));
        this.fail(new AcpSessionTimeoutError(operation, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { operation, timer, resolve, reject });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
        this.fail(asError(error));
      }
    });
  }

  private writeNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: Record<string, unknown>): void {
    if (this.process === undefined) throw new Error('ACP process is not running');
    this.process.writeLine(JSON.stringify(message));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      this.fail(new Error('ACP process emitted invalid JSON'));
      return;
    }
    if (!isRecord(value) || value.jsonrpc !== '2.0') {
      this.fail(new Error('ACP process emitted an invalid JSON-RPC message'));
      return;
    }
    if ((typeof value.id === 'number' || typeof value.id === 'string') && ('result' in value || 'error' in value)) {
      this.handleResponse(value as unknown as JsonRpcResponse);
      return;
    }
    if (typeof value.method === 'string' && !('id' in value)) {
      const notification = value as unknown as JsonRpcNotification;
      if (notification.method === 'session/update') {
        const params = isRecord(notification.params) ? notification.params : {};
        this.onUpdate?.({
          ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
          update: params.update ?? notification.params,
        });
      }
      return;
    }
    this.fail(new Error('ACP process emitted an unsupported JSON-RPC message'));
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) {
      pending.reject(new AcpRpcError(response.error.code, response.error.message, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleExit(error?: Error): void {
    if (this.intentionalClose || this.stateValue === 'closed') return;
    this.fail(error ?? new Error('ACP process exited'));
  }

  private fail(error: Error): void {
    if (this.stateValue === 'failed' || this.stateValue === 'closed') return;
    this.stateValue = 'failed';
    this.rejectAll(error);
    this.process?.kill();
    this.process = undefined;
    this.sessionId = undefined;
    this.promptRequestId = undefined;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function createNodeAcpProcess(spec: AcpProcessSpec): AcpProcessHandle {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env === undefined ? process.env : { ...process.env, ...spec.env },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutBuffer = '';
  let stderrBuffer = '';
  const lineListeners = new Set<(line: string) => void>();
  const stderrListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(error?: Error) => void>();
  let killed = false;

  const emitLines = (chunk: string, buffer: 'stdout' | 'stderr'): void => {
    const next = (buffer === 'stdout' ? stdoutBuffer : stderrBuffer) + chunk;
    const lines = next.split(/\r?\n/gu);
    const remainder = lines.pop() ?? '';
    if (Buffer.byteLength(remainder, 'utf8') > ACP_MAX_LINE_BYTES) {
      for (const listener of exitListeners) listener(new Error('ACP message exceeded line limit'));
      child.kill();
      return;
    }
    if (buffer === 'stdout') stdoutBuffer = remainder;
    else stderrBuffer = remainder;
    for (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > ACP_MAX_LINE_BYTES) {
        for (const listener of exitListeners) listener(new Error('ACP message exceeded line limit'));
        child.kill();
        return;
      }
      if (buffer === 'stdout') for (const listener of lineListeners) listener(line);
      else for (const listener of stderrListeners) listener(line);
    }
  };

  child.stdout.on('data', (chunk: Buffer | string) => emitLines(String(chunk), 'stdout'));
  child.stderr.on('data', (chunk: Buffer | string) => emitLines(String(chunk), 'stderr'));
  child.on('error', (error) => {
    for (const listener of exitListeners) listener(error);
  });
  child.on('close', (code, signal) => {
    if (!killed && (code !== 0 || signal !== null)) {
      const suffix = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      for (const listener of exitListeners) listener(new Error(`ACP process exited with ${suffix}`));
    } else {
      for (const listener of exitListeners) listener();
    }
  });

  return {
    writeLine: (line) => child.stdin.write(`${line}\n`),
    onLine: (listener) => {
      lineListeners.add(listener);
      return () => lineListeners.delete(listener);
    },
    onStderr: (listener) => {
      stderrListeners.add(listener);
      return () => stderrListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    kill: () => {
      killed = true;
      child.kill();
    },
  };
}

function readSessionId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  return typeof result.sessionId === 'string' ? result.sessionId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
