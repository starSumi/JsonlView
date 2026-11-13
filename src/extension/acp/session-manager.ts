import { createRuntimeProcessFactory } from '@runtime/index';
import type { RuntimeSettlement, RuntimeTarget } from '@runtime/index';

export const ACP_CLIENT_NAME = 'JsonlView';
export const ACP_PROTOCOL_VERSION = 1;
export const ACP_DEFAULT_TIMEOUT_MS = 10_000;
export const ACP_CANCEL_GRACE_MS = 2_000;
export const ACP_MAX_LINE_BYTES = 1_048_576;

export type AcpSessionState = 'idle' | 'starting' | 'ready' | 'prompting' | 'closed' | 'failed';
export type AcpRequestOperation = 'initialize' | 'session/new' | 'session/prompt';
export type AcpSessionStage = 'launch' | AcpRequestOperation;

/** ACP v1 McpServerStdio: unlike native CLI config, env is an array. */
export interface AcpMcpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: { readonly toolCallId: string; readonly title?: string | null };
  readonly options: readonly {
    readonly optionId: string;
    readonly name: string;
    readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }[];
}

export type AcpPermissionOutcome = { readonly outcome: 'cancelled' }
  | { readonly outcome: 'selected'; readonly optionId: string };

export interface AcpLaunchOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly executionTarget?: RuntimeTarget;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly clientInfo?: { readonly name: string; readonly title?: string; readonly version: string };
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
  readonly sessionCwd?: string;
  readonly sessionMcpServers?: readonly AcpMcpServerStdio[];
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
  stop?(): Promise<RuntimeSettlement>;
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
  readonly onStage?: (stage: AcpSessionStage) => void;
  readonly onRequestPermission?: (request: AcpPermissionRequest, signal: AbortSignal) => AcpPermissionOutcome | Promise<AcpPermissionOutcome>;
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
  readonly operation: AcpRequestOperation;
  readonly timeoutMs: number;

  constructor(operation: AcpRequestOperation, timeoutMs: number) {
    super(`ACP ${operation} timed out after ${timeoutMs} ms`);
    this.name = 'AcpSessionTimeoutError';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
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
  readonly operation: AcpRequestOperation;
  timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class AcpSessionManager {
  private readonly launch: AcpLaunchOptions;
  private readonly processFactory: AcpProcessFactory;
  private readonly onUpdate: ((update: AcpSessionUpdate) => void) | undefined;
  private readonly onStderr: ((line: string) => void) | undefined;
  private readonly onStage: AcpSessionManagerOptions['onStage'];
  private readonly onRequestPermission: AcpSessionManagerOptions['onRequestPermission'];
  private readonly pendingPermissions = new Map<JsonRpcId, { readonly controller: AbortController; readonly finish: (outcome: AcpPermissionOutcome) => void }>();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private process: AcpProcessHandle | undefined;
  private nextId = 1;
  private sessionId: string | undefined;
  private stateValue: AcpSessionState = 'idle';
  private promptRequestId: number | undefined;
  private promptCancelRequested = false;
  private intentionalClose = false;
  private termination: Promise<RuntimeSettlement | undefined> = Promise.resolve(undefined);

  constructor(options: AcpSessionManagerOptions) {
    this.launch = options.launch;
    this.processFactory = options.processFactory ?? createRuntimeProcessFactory(this.launch.executionTarget ?? { kind: 'local' });
    this.onUpdate = options.onUpdate;
    this.onStderr = options.onStderr;
    this.onStage = options.onStage;
    this.onRequestPermission = options.onRequestPermission;
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
      this.reportStage('launch');
      this.assertStarting();
      this.process = this.processFactory({
        command: this.launch.command,
        args: [...(this.launch.args ?? [])],
        ...(this.launch.cwd === undefined ? {} : { cwd: this.launch.cwd }),
        ...(this.launch.env === undefined ? {} : { env: this.launch.env }),
      });
      this.process.onLine((line) => this.handleLine(line));
      this.process.onStderr((line) => this.onStderr?.(line));
      this.process.onExit((error) => this.handleExit(error));

      const initializeResult = await this.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: this.launch.clientInfo ?? { name: ACP_CLIENT_NAME, version: '0.0.0' },
        clientCapabilities: this.launch.clientCapabilities ?? {},
      }, 'initialize');
      validateInitializeResult(initializeResult);
      this.assertStarting();

      const result = await this.request(
        'session/new',
        {
          cwd: this.launch.sessionCwd ?? this.launch.cwd ?? process.cwd(),
          mcpServers: [...(this.launch.sessionMcpServers ?? [])],
        },
        'session/new',
      );
      this.assertStarting();
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
    this.promptCancelRequested = false;
    try {
      return await this.request('session/prompt', { sessionId: this.sessionId, prompt }, 'session/prompt');
    } finally {
      this.cancelPermissions();
      if (this.promptRequestId === requestId) this.promptRequestId = undefined;
      this.promptCancelRequested = false;
      if (this.stateValue === 'prompting') this.stateValue = 'ready';
    }
  }

  cancel(): void {
    if (this.stateValue === 'starting') {
      this.fail(new AcpSessionCancelledError());
      return;
    }
    if (this.stateValue !== 'prompting' || this.sessionId === undefined || this.promptCancelRequested) return;
    this.promptCancelRequested = true;
    this.cancelPermissions();
    try {
      this.writeNotification('session/cancel', { sessionId: this.sessionId });
    } catch (error) {
      this.fail(asError(error));
      return;
    }
    const requestId = this.promptRequestId;
    if (requestId !== undefined) {
      const pending = this.pending.get(requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          if (this.pending.get(requestId) === pending) this.fail(new AcpSessionCancelledError());
        }, ACP_CANCEL_GRACE_MS);
      }
    }
  }

  close(): Promise<RuntimeSettlement | undefined> {
    if (this.stateValue === 'closed') return this.termination;
    this.intentionalClose = true;
    this.cancelPermissions();
    this.rejectAll(new Error('ACP session closed'));
    const processHandle = this.process;
    this.process = undefined;
    this.sessionId = undefined;
    this.promptRequestId = undefined;
    this.stateValue = 'closed';
    if (processHandle !== undefined) this.termination = stopAcpProcess(processHandle);
    return this.termination;
  }

  private reportStage(stage: AcpSessionStage): void {
    try { this.onStage?.(stage); } catch { /* Progress cannot break the protocol. */ }
  }

  private request(method: string, params: unknown, operation: AcpRequestOperation): Promise<unknown> {
    this.reportStage(operation);
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
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, 'utf8') > ACP_MAX_LINE_BYTES) throw new Error('ACP message exceeded line limit');
    this.process.writeLine(line);
  }

  private handleLine(line: string): void {
    if (this.stateValue === 'closed' || this.stateValue === 'failed') return;
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
    if ('id' in value && !isJsonRpcId(value.id)) {
      if (typeof value.method === 'string') this.write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request ID' } });
      else this.fail(new Error('ACP process emitted an invalid response ID'));
      return;
    }
    if (isJsonRpcId(value.id) && ('result' in value || 'error' in value || !('method' in value))) {
      this.handleResponse(value as unknown as JsonRpcResponse);
      return;
    }
    if (isJsonRpcId(value.id) && typeof value.method === 'string') {
      this.handleAgentRequest(value.id, value.method, value.params);
      return;
    }
    if (typeof value.method === 'string' && !('id' in value)) {
      const notification = value as unknown as JsonRpcNotification;
      if (notification.method === 'session/update') {
        const params = isRecord(notification.params) ? notification.params : {};
        if (this.sessionId === undefined || params.sessionId !== this.sessionId || !isRecord(params.update)) return;
        this.onUpdate?.({
          ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
          update: params.update ?? notification.params,
        });
      }
      return;
    }
    this.fail(new Error('ACP process emitted an unsupported JSON-RPC message'));
  }

  private handleAgentRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    const request = readPermissionRequest(params);
    if (request === undefined) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid permission request' } });
      return;
    }
    const cancelled: AcpPermissionOutcome = { outcome: 'cancelled' };
    if (request.sessionId !== this.sessionId || this.stateValue !== 'prompting' || this.promptCancelRequested || this.pendingPermissions.size >= 8 || this.pendingPermissions.has(id)) {
      this.write({ jsonrpc: '2.0', id, result: { outcome: cancelled } });
      return;
    }
    const controller = new AbortController();
    const finish = (outcome: AcpPermissionOutcome): void => {
      if (this.pendingPermissions.get(id)?.controller !== controller) return;
      this.pendingPermissions.delete(id);
      controller.abort();
      const selected = outcome.outcome === 'selected' && request.options.some((option) =>
        option.optionId === outcome.optionId && (option.kind === 'allow_once' || option.kind === 'reject_once'));
      try {
        this.write({ jsonrpc: '2.0', id, result: { outcome: selected ? outcome : cancelled } });
      } catch (error) { this.fail(asError(error)); }
    };
    this.pendingPermissions.set(id, { controller, finish });
    try {
      void Promise.resolve(this.onRequestPermission?.(request, controller.signal) ?? cancelled).then(finish, () => finish(cancelled));
    } catch { finish(cancelled); }
  }

  private cancelPermissions(): void {
    for (const permission of [...this.pendingPermissions.values()]) permission.finish({ outcome: 'cancelled' });
  }

  private handleResponse(response: JsonRpcResponse): void {
    const hasResult = Object.hasOwn(response, 'result');
    const hasError = Object.hasOwn(response, 'error');
    if ('method' in response || hasResult === hasError || (hasError && (!isRecord(response.error) || !Number.isSafeInteger(response.error.code) ||
      typeof response.error.message !== 'string' || response.error.message.length > 4096))) {
      this.fail(new Error('ACP process emitted an invalid JSON-RPC response'));
      return;
    }
    const pending = this.pending.get(response.id);
    if (pending === undefined) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) {
      if (response.error.code === -32800 && response.id === this.promptRequestId && this.promptCancelRequested) {
        pending.reject(new AcpSessionCancelledError());
        return;
      }
      pending.reject(new AcpRpcError(response.error.code, response.error.message, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleExit(error?: Error): void {
    if (this.intentionalClose || this.stateValue === 'closed') return;
    this.fail(error ?? new Error('ACP process exited'));
  }

  private assertStarting(): void {
    if (this.stateValue !== 'starting') throw new AcpSessionCancelledError();
  }

  private fail(error: Error): void {
    if (this.stateValue === 'failed' || this.stateValue === 'closed') return;
    this.stateValue = 'failed';
    this.cancelPermissions();
    this.rejectAll(error);
    const processHandle = this.process;
    this.process = undefined;
    this.sessionId = undefined;
    this.promptRequestId = undefined;
    if (processHandle !== undefined) this.termination = stopAcpProcess(processHandle);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function stopAcpProcess(processHandle: AcpProcessHandle): Promise<RuntimeSettlement | undefined> {
  try {
    if (processHandle.stop !== undefined) return processHandle.stop().catch(() => undefined);
    processHandle.kill();
  } catch {
    // ACP teardown is best-effort; the session state and pending RPCs are
    // already closed, and an adapter may not expose process settlement.
  }
  return Promise.resolve(undefined);
}

function readSessionId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  return boundedString(result.sessionId, 256) ? result.sessionId : undefined;
}

function validateInitializeResult(result: unknown): void {
  if (!isRecord(result) || result.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new Error(`ACP agent must negotiate protocol version ${ACP_PROTOCOL_VERSION}`);
  }
  if ('authMethods' in result && !Array.isArray(result.authMethods)) {
    throw new Error('ACP agent returned an invalid authMethods value');
  }
}

function readPermissionRequest(value: unknown): AcpPermissionRequest | undefined {
  if (!isRecord(value) || !boundedString(value.sessionId, 256) || !isRecord(value.toolCall) || !boundedString(value.toolCall.toolCallId, 256) || !Array.isArray(value.options) || value.options.length > 32) return undefined;
  const title = value.toolCall.title;
  if (title !== undefined && title !== null && (typeof title !== 'string' || title.length > 512)) return undefined;
  if (!value.options.every((option: unknown) => isRecord(option) && boundedString(option.optionId, 256) && boundedString(option.name, 512) &&
    typeof option.kind === 'string' && ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))) return undefined;
  if (new Set(value.options.map((option: { optionId: string }) => option.optionId)).size !== value.options.length) return undefined;
  return value as unknown as AcpPermissionRequest;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' ? Number.isSafeInteger(value) : boundedString(value, 256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
