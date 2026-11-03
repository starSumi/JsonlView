/** Explicit opt-in, host-owned MCP JSON-RPC server for read-only queries. */

import { performance } from 'node:perf_hooks';

export const MCP_READ_ONLY_PROTOCOL_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18'] as const);
export type McpReadOnlyProtocolVersion = (typeof MCP_READ_ONLY_PROTOCOL_VERSIONS)[number];
export const MCP_READ_ONLY_TOOL_NAME = 'jsonlview_query_records' as const;
export const MCP_READ_ONLY_SERVER_NAME = 'JsonlView' as const;
export const MCP_READ_ONLY_SERVER_VERSION = '0.1.0' as const;

const DEFAULT_BUDGET_MS = 3_000;
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUED_REQUESTS = 8;
export const MCP_READ_ONLY_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE = MCP_READ_ONLY_MAX_LINE_BYTES;
const DEFAULT_MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_DEPTH = 6;
const MAX_STRING = 4096;
const MAX_ARRAY = 256;
const MAX_KEYS = 64;
const MAX_LIMIT = 256;
const MAX_BYTES = 512 * 1024;
const FORBIDDEN_KEYS = new Set(['path', 'sourcePath', 'filePath', 'fsPath', 'rootPath', 'rootUri', 'uri', 'file', 'cwd', 'command', 'write', 'mutation']);

export interface McpLineTransport {
  sendLine(line: string): void | Promise<void>;
  onLine(listener: (line: string) => void): () => void;
}

export interface McpReadOnlyToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly additionalProperties?: boolean; readonly properties?: Readonly<Record<string, unknown>>; readonly required?: readonly string[] };
  readonly annotations: { readonly readOnlyHint: true; readonly destructiveHint: false };
}

export interface McpReadOnlyQueryRequest {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly protocolVersion: McpReadOnlyProtocolVersion;
  readonly signal: AbortSignal;
  readonly cancellationSupported: boolean;
}

export interface McpReadOnlyQueryResult {
  readonly structuredContent?: unknown;
  readonly content?: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
}

export type McpReadOnlyQuery = (request: McpReadOnlyQueryRequest) => Promise<unknown | McpReadOnlyQueryResult>;

export interface McpReadOnlyServerOptions {
  readonly transport: McpLineTransport;
  readonly query: McpReadOnlyQuery;
  readonly tools?: readonly McpReadOnlyToolDefinition[];
  readonly protocolVersions?: readonly string[];
  readonly allowedSourceIds?: readonly string[];
  /** Total arrival-to-finish budget, including queue wait. The default is 3000ms. */
  readonly budgetMs?: number;
  /** @deprecated Use budgetMs. Kept as an alias for existing embedders. */
  readonly requestTimeoutMs?: number;
  /** Defaults to unsupported; marks whether the query adapter cooperatively observes AbortSignal. */
  readonly cancellationMode?: 'cooperative' | 'unsupported';
  /** Maximum number of tool queries executing at once. Defaults to 2. */
  readonly maxConcurrency?: number;
  /** Maximum number of waiting tool queries. Defaults to 8. */
  readonly maxQueuedRequests?: number;
  readonly maxLineBytes?: number;
  readonly maxResponseBytes?: number;
}

export type McpJsonRpcId = string | number | null;

export const MCP_READ_ONLY_TOOL: McpReadOnlyToolDefinition = Object.freeze({
  name: MCP_READ_ONLY_TOOL_NAME,
  description: 'Read a bounded page of raw physical JSONL records from the explicitly authorized JsonlView source. Records are not split: a single record larger than maxBytes fails explicitly. Stdio defaults are two active and eight waiting queries with a 3000ms total request budget. Set JSONLVIEW_MCP_MAX_CONCURRENCY (1..8; 1 serializes scans) and JSONLVIEW_MCP_BUDGET_MS (1..60000) to override the active-query limit and budget. Packaged stdio uses the cancellable portable reader; native synchronous reads remain available to other adapters and cannot be interrupted mid-read.',
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({
      sourceId: { type: 'string', minLength: 1, maxLength: 256 },
      startOrdinal: { type: 'string', minLength: 1, maxLength: 20, pattern: '^(0|[1-9][0-9]*)$' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      maxBytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES },
    }),
  }),
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false }),
});

export type McpReadOnlyServerErrorCode = 'not_initialized' | 'already_initialized' | 'invalid_request' | 'invalid_params' | 'method_not_found' | 'unknown_tool' | 'unsupported_protocol_version' | 'query_failed' | 'query_cancelled' | 'request_timeout' | 'server_busy' | 'response_too_large' | 'line_too_large' | 'server_stopped';

export class McpReadOnlyServerError extends Error {
  public readonly code: McpReadOnlyServerErrorCode;
  public readonly rpcCode: number;
  public readonly data?: unknown;
  public constructor(code: McpReadOnlyServerErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'McpReadOnlyServerError';
    this.code = code;
    this.rpcCode = rpcCodeFor(code);
    this.data = data;
  }
}

interface PendingRequest {
  readonly key: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly controller: AbortController;
  readonly resolve: (value: unknown | undefined) => void;
  readonly reject: (reason: unknown) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  readonly deadlineAt: number;
  state: 'queued' | 'running' | 'finished';
  timedOut: boolean;
  responseSettled: boolean;
}

/** Construction is inert. Calling start() is the explicit connection boundary. */
export class McpReadOnlyServer {
  readonly #transport: McpLineTransport;
  readonly #query: McpReadOnlyQuery;
  readonly #tools: readonly McpReadOnlyToolDefinition[];
  readonly #versions: readonly McpReadOnlyProtocolVersion[];
  readonly #allowedSourceIds: ReadonlySet<string> | undefined;
  readonly #budgetMs: number;
  readonly #cancellationMode: 'cooperative' | 'unsupported';
  readonly #maxConcurrency: number;
  readonly #maxQueuedRequests: number;
  readonly #maxLineBytes: number;
  readonly #maxResponseBytes: number;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #queue: PendingRequest[] = [];
  #activeCount = 0;
  #unsubscribe: (() => void) | undefined;
  #started = false;
  #stoppedOnce = false;
  #initialized = false;
  #version: McpReadOnlyProtocolVersion | undefined;

  public constructor(options: McpReadOnlyServerOptions) {
    this.#transport = options.transport;
    this.#query = options.query;
    this.#tools = freezeTools(options.tools ?? [MCP_READ_ONLY_TOOL]);
    this.#versions = normalizeVersions(options.protocolVersions);
    this.#allowedSourceIds = options.allowedSourceIds === undefined ? undefined : new Set(options.allowedSourceIds);
    this.#budgetMs = bounded(options.budgetMs ?? options.requestTimeoutMs ?? DEFAULT_BUDGET_MS, 1, 60_000, 'budgetMs');
    this.#cancellationMode = options.cancellationMode ?? 'unsupported';
    this.#maxConcurrency = bounded(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, 1, 8, 'maxConcurrency');
    this.#maxQueuedRequests = bounded(options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS, 0, 256, 'maxQueuedRequests');
    this.#maxLineBytes = bounded(options.maxLineBytes ?? DEFAULT_MAX_LINE, 256, 16 * 1024 * 1024, 'maxLineBytes');
    this.#maxResponseBytes = bounded(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE, 256, 16 * 1024 * 1024, 'maxResponseBytes');
  }

  public get started(): boolean { return this.#started; }
  public get initialized(): boolean { return this.#initialized; }
  public get protocolVersion(): McpReadOnlyProtocolVersion | undefined { return this.#version; }

  public start(): void {
    if (this.#started) return;
    if (this.#stoppedOnce) throw new McpReadOnlyServerError('server_stopped', 'MCP server instances cannot be restarted after stop().');
    this.#started = true;
    this.#unsubscribe = this.#transport.onLine((line) => { void this.handleLine(line).then((response) => { if (response !== undefined && this.#started) void this.#transport.sendLine(response); }).catch(() => undefined); });
  }

  public stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#stoppedOnce = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    for (const pending of [...this.#pending.values()]) this.cancelPending(pending);
    this.#queue.length = 0;
    this.#initialized = false;
    this.#version = undefined;
  }

  public async handleLine(line: string): Promise<string | undefined> {
    if (!this.#started) throw new McpReadOnlyServerError('server_stopped', 'MCP server is not started.');
    if (byteLength(line) > this.#maxLineBytes) return rpcError(null, -32004, 'MCP request line exceeds the configured byte limit.');
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { return rpcError(null, -32700, 'Parse error'); }
    if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || value.method.length === 0) return rpcError(isRecord(value) && 'id' in value ? normalizeId(value.id) ?? null : null, -32600, 'Invalid Request');
    const hasId = Object.hasOwn(value, 'id');
    const id = hasId ? normalizeId(value.id) : undefined;
    if (hasId && id === undefined) return rpcError(null, -32600, 'Invalid Request');
    try {
      const result = await this.dispatch(value.method, value.params, id);
      if (result === undefined || !hasId) return undefined;
      return this.fitResponse(id!, result);
    } catch (error) {
      if (!hasId) return undefined;
      if (error instanceof McpReadOnlyServerError && error.code === 'query_cancelled') return undefined;
      return rpcError(id!, error instanceof McpReadOnlyServerError ? error.rpcCode : -32000, error instanceof Error ? error.message : 'MCP request failed.', error instanceof McpReadOnlyServerError ? { code: error.code } : undefined);
    }
  }

  private async dispatch(method: string, params: unknown, id: McpJsonRpcId | undefined): Promise<unknown | undefined> {
    const request = id !== undefined;
    if (method === 'initialize') {
      if (!request) return undefined;
      if (this.#initialized) throw new McpReadOnlyServerError('already_initialized', 'MCP server has already been initialized.');
      const version = negotiate(params, this.#versions);
      this.#version = version;
      this.#initialized = true;
      return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: MCP_READ_ONLY_SERVER_NAME, version: MCP_READ_ONLY_SERVER_VERSION } };
    }
    if (method === 'notifications/initialized') return undefined;
    if (method === 'notifications/cancelled') { this.cancel(params); return undefined; }
    if (method === '$/cancelRequest') { this.cancel(params); return undefined; }
    if (method === 'ping') return request ? {} : undefined;
    if (!this.#initialized) throw new McpReadOnlyServerError('not_initialized', 'MCP server must be initialized first.');
    if (method === 'tools/list') return request ? { tools: this.#tools } : undefined;
    if (method === 'tools/call') return request ? this.callTool(id!, params) : undefined;
    throw new McpReadOnlyServerError('method_not_found', 'Unsupported MCP method: ' + method);
  }

  private callTool(id: McpJsonRpcId, params: unknown): Promise<unknown | undefined> {
    const parsed = parseToolCall(params, this.#tools);
    if (this.#allowedSourceIds !== undefined) {
      const sourceId = parsed.arguments.sourceId;
      if (typeof sourceId !== 'string' || !this.#allowedSourceIds.has(sourceId)) throw new McpReadOnlyServerError('invalid_params', 'sourceId is not allowlisted for this MCP session.');
    }
    const key = requestKey(id);
    if (this.#pending.has(key)) throw new McpReadOnlyServerError('invalid_request', 'MCP request ID is already in use.');
    if (this.#activeCount >= this.#maxConcurrency && this.#queue.length >= this.#maxQueuedRequests) {
      throw new McpReadOnlyServerError('server_busy', 'MCP query queue is full.');
    }
    let resolveRequest!: (value: unknown | undefined) => void;
    let rejectRequest!: (reason: unknown) => void;
    const response = new Promise<unknown | undefined>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const pending: PendingRequest = {
      key,
      toolName: parsed.name,
      arguments: parsed.arguments,
      controller: new AbortController(),
      resolve: resolveRequest,
      reject: rejectRequest,
      timeoutHandle: undefined,
      deadlineAt: performance.now() + this.#budgetMs,
      state: 'queued',
      timedOut: false,
      responseSettled: false,
    };
    this.#pending.set(key, pending);
    pending.timeoutHandle = setTimeout(() => this.timeoutPending(pending), this.#budgetMs);
    this.#queue.push(pending);
    this.pumpQueue();
    return response;
  }

  private fitResponse(id: McpJsonRpcId, result: unknown): string {
    const line = JSON.stringify({ jsonrpc: '2.0', id, result });
    if (line !== undefined && byteLength(line) <= this.#maxResponseBytes) return line;
    return rpcError(id, -32004, 'MCP response exceeds the configured byte limit.', { code: 'response_too_large' });
  }

  private cancel(params: unknown): void {
    if (!isRecord(params)) return;
    const id = normalizeId(params.requestId);
    if (id !== undefined) {
      const pending = this.#pending.get(requestKey(id));
      if (pending !== undefined) this.cancelPending(pending);
    }
  }

  private pumpQueue(): void {
    while (this.#started && this.#activeCount < this.#maxConcurrency && this.#queue.length > 0) {
      const pending = this.#queue.shift()!;
      if (pending.state !== 'queued' || pending.controller.signal.aborted) continue;
      if (this.expireIfPastDue(pending)) continue;
      pending.state = 'running';
      this.#activeCount += 1;
      void this.runPending(pending);
    }
  }

  private async runPending(pending: PendingRequest): Promise<void> {
    try {
      const value = await this.#query({
        toolName: pending.toolName,
        arguments: pending.arguments,
        protocolVersion: this.#version!,
        signal: pending.controller.signal,
        cancellationSupported: this.#cancellationMode === 'cooperative',
      });
      if (this.expireIfPastDue(pending)) return;
      if (pending.controller.signal.aborted) {
        this.settlePending(pending, pending.timedOut
          ? { kind: 'reject', reason: new McpReadOnlyServerError('request_timeout', 'MCP query exceeded its total request budget.') }
          : { kind: 'resolve', value: undefined });
        return;
      }
      const result = isQueryResult(value) ? value : { structuredContent: value };
      const content = result.content ?? [{ type: 'text' as const, text: safeJson(result.structuredContent) }];
      this.settlePending(pending, { kind: 'resolve', value: { content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }), ...(result.isError === true ? { isError: true } : {}) } });
    } catch (error) {
      if (pending.controller.signal.aborted) {
        this.settlePending(pending, pending.timedOut
          ? { kind: 'reject', reason: new McpReadOnlyServerError('request_timeout', 'MCP query exceeded its total request budget.') }
          : { kind: 'resolve', value: undefined });
      } else {
        this.settlePending(pending, { kind: 'reject', reason: error instanceof McpReadOnlyServerError
          ? error
          : new McpReadOnlyServerError('query_failed', error instanceof Error ? error.message : 'MCP query failed.') });
      }
    } finally {
      pending.state = 'finished';
      this.clearPending(pending);
      this.#activeCount -= 1;
      this.pumpQueue();
    }
  }

  private timeoutPending(pending: PendingRequest): void {
    if (pending.responseSettled) return;
    const remainingMs = pending.deadlineAt - performance.now();
    if (remainingMs > 0) {
      pending.timeoutHandle = setTimeout(() => this.timeoutPending(pending), remainingMs);
      return;
    }
    pending.timedOut = true;
    pending.controller.abort();
    if (pending.state === 'queued') {
      this.removeQueued(pending);
      pending.state = 'finished';
    }
    this.settlePending(pending, { kind: 'reject', reason: new McpReadOnlyServerError('request_timeout', 'MCP query exceeded its total request budget.') });
  }

  private expireIfPastDue(pending: PendingRequest): boolean {
    if (pending.responseSettled || performance.now() < pending.deadlineAt) return false;
    this.timeoutPending(pending);
    return true;
  }

  private cancelPending(pending: PendingRequest): void {
    pending.controller.abort();
    if (pending.state === 'queued') {
      this.removeQueued(pending);
      pending.state = 'finished';
    }
    this.settlePending(pending, { kind: 'resolve', value: undefined });
  }

  private settlePending(pending: PendingRequest, outcome: { readonly kind: 'resolve'; readonly value: unknown | undefined } | { readonly kind: 'reject'; readonly reason: unknown }): void {
    if (pending.responseSettled) return;
    pending.responseSettled = true;
    this.clearPending(pending);
    if (outcome.kind === 'resolve') pending.resolve(outcome.value);
    else pending.reject(outcome.reason);
  }

  private clearPending(pending: PendingRequest): void {
    if (pending.timeoutHandle !== undefined) clearTimeout(pending.timeoutHandle);
    pending.timeoutHandle = undefined;
    if (this.#pending.get(pending.key) === pending) this.#pending.delete(pending.key);
  }

  private removeQueued(pending: PendingRequest): void {
    const index = this.#queue.indexOf(pending);
    if (index >= 0) this.#queue.splice(index, 1);
  }
}

function freezeTools(tools: readonly McpReadOnlyToolDefinition[]): readonly McpReadOnlyToolDefinition[] {
  if (tools.length === 0 || tools.length > 32) throw new Error('MCP tool count is outside the configured range.');
  const names = new Set<string>();
  return Object.freeze(tools.map((tool) => {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/u.test(tool.name) || names.has(tool.name)) throw new Error('MCP tool name is invalid or duplicated.');
    names.add(tool.name);
    if (tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint !== false) throw new Error('MCP tools must be read-only.');
    return Object.freeze({ ...tool, inputSchema: Object.freeze({ ...tool.inputSchema, ...(tool.inputSchema.properties === undefined ? {} : { properties: Object.freeze({ ...tool.inputSchema.properties }) }) }), annotations: Object.freeze({ ...tool.annotations }) });
  }));
}

function normalizeVersions(input: readonly string[] | undefined): readonly McpReadOnlyProtocolVersion[] {
  const values = input === undefined ? [...MCP_READ_ONLY_PROTOCOL_VERSIONS] : input;
  const result = MCP_READ_ONLY_PROTOCOL_VERSIONS.filter((value) => values.includes(value));
  if (result.length === 0) throw new McpReadOnlyServerError('unsupported_protocol_version', 'No supported MCP protocol version is configured.');
  return Object.freeze([...new Set(result)]);
}

function negotiate(value: unknown, server: readonly McpReadOnlyProtocolVersion[]): McpReadOnlyProtocolVersion {
  if (!isRecord(value) || typeof value.protocolVersion !== 'string') throw new McpReadOnlyServerError('invalid_params', 'initialize.protocolVersion is required.');
  const version = value.protocolVersion as McpReadOnlyProtocolVersion;
  if (MCP_READ_ONLY_PROTOCOL_VERSIONS.includes(version) && server.includes(version)) return version;
  // MCP 2025-11-25 requires the server to return another supported version.
  return server[0]!;
}

function parseToolCall(value: unknown, tools: readonly McpReadOnlyToolDefinition[]): { name: string; arguments: Readonly<Record<string, unknown>> } {
  if (!isRecord(value) || typeof value.name !== 'string') throw new McpReadOnlyServerError('invalid_params', 'tools/call requires a tool name.');
  if (tools.every((tool) => tool.name !== value.name)) throw new McpReadOnlyServerError('unknown_tool', 'Unsupported MCP tool: ' + value.name);
  const args = value.arguments === undefined ? {} : value.arguments;
  if (!isRecord(args)) throw new McpReadOnlyServerError('invalid_params', 'tools/call arguments must be an object.');
  const tool = tools.find((candidate) => candidate.name === value.name)!;
  const properties = tool.inputSchema.properties === undefined ? undefined : new Set(Object.keys(tool.inputSchema.properties));
  const encoded = safeJson(args);
  if (byteLength(encoded) > MAX_ARGUMENT_BYTES) throw new McpReadOnlyServerError('invalid_params', 'MCP tool arguments exceed the byte limit.');
  for (const required of tool.inputSchema.required ?? []) if (!(required in args)) throw new McpReadOnlyServerError('invalid_params', 'Missing required MCP argument: ' + required);
  validateSchema(args, tool.inputSchema.properties);
  walk(args, 0, properties);
  return { name: value.name, arguments: Object.freeze({ ...args }) };
}

function validateSchema(args: Readonly<Record<string, unknown>>, properties: Readonly<Record<string, unknown>> | undefined): void {
  if (properties === undefined) return;
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (!isRecord(schema)) continue;
    if (schema.type === 'integer' && (!Number.isSafeInteger(value) || (typeof schema.minimum === 'number' && (value as number) < schema.minimum) || (typeof schema.maximum === 'number' && (value as number) > schema.maximum))) throw new McpReadOnlyServerError('invalid_params', 'MCP integer argument is outside its schema: ' + key);
    if (schema.type === 'string' && typeof value !== 'string') throw new McpReadOnlyServerError('invalid_params', 'MCP argument must be a string: ' + key);
    if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern, 'u').test(value)) throw new McpReadOnlyServerError('invalid_params', 'MCP string argument does not match its schema: ' + key);
    if (schema.type === 'array' && !Array.isArray(value)) throw new McpReadOnlyServerError('invalid_params', 'MCP argument must be an array: ' + key);
    if (typeof schema.maxLength === 'number' && typeof value === 'string' && value.length > schema.maxLength) throw new McpReadOnlyServerError('invalid_params', 'MCP string argument is too long: ' + key);
    if (typeof schema.maxItems === 'number' && Array.isArray(value) && value.length > schema.maxItems) throw new McpReadOnlyServerError('invalid_params', 'MCP array argument is too large: ' + key);
  }
}

function walk(value: unknown, depth: number, rootProperties?: ReadonlySet<string>): void {
  if (depth > MAX_DEPTH) throw new McpReadOnlyServerError('invalid_params', 'MCP arguments are nested too deeply.');
  if (typeof value === 'string') { if (value.length > MAX_STRING) throw new McpReadOnlyServerError('invalid_params', 'MCP argument string is too long.'); return; }
  if (Array.isArray(value)) { if (value.length > MAX_ARRAY) throw new McpReadOnlyServerError('invalid_params', 'MCP argument array is too large.'); for (const child of value) walk(child, depth + 1); return; }
  if (!isRecord(value)) { if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') throw new McpReadOnlyServerError('invalid_params', 'Unsupported MCP argument value.'); if (typeof value === 'number' && !Number.isFinite(value)) throw new McpReadOnlyServerError('invalid_params', 'MCP argument number must be finite.'); return; }
  const keys = Object.keys(value);
  if (keys.length > MAX_KEYS) throw new McpReadOnlyServerError('invalid_params', 'MCP argument object has too many keys.');
  for (const key of keys) { if (FORBIDDEN_KEYS.has(key) || /(?:^|[-_])(path|uri|file|root|cwd|command|write|mutat)(?:$|[-_])/iu.test(key)) throw new McpReadOnlyServerError('invalid_params', 'MCP argument is not permitted: ' + key); if (rootProperties !== undefined && depth === 0 && !rootProperties.has(key)) throw new McpReadOnlyServerError('invalid_params', 'Unsupported MCP argument: ' + key); walk(value[key], depth + 1); }
}

function isQueryResult(value: unknown): value is McpReadOnlyQueryResult { return isRecord(value) && ('structuredContent' in value || 'content' in value || value.isError === true); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function normalizeId(value: unknown): McpJsonRpcId | undefined { return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value)) ? value : undefined; }
function requestKey(id: McpJsonRpcId): string { return typeof id + ':' + String(id); }
function rpcCodeFor(code: McpReadOnlyServerErrorCode): number { if (code === 'method_not_found' || code === 'unknown_tool') return -32601; if (code === 'invalid_params' || code === 'unsupported_protocol_version') return -32602; if (code === 'invalid_request') return -32600; if (code === 'line_too_large' || code === 'response_too_large') return -32004; if (code === 'server_busy') return -32003; if (code === 'not_initialized' || code === 'already_initialized' || code === 'request_timeout' || code === 'query_cancelled') return -32002; return -32000; }
function rpcError(id: McpJsonRpcId, code: number, message: string, data?: unknown): string { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }); }
function safeJson(value: unknown): string { try { const result = JSON.stringify(value); return result === undefined ? 'null' : result; } catch { throw new McpReadOnlyServerError('query_failed', 'MCP result is not JSON serializable.'); } }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function bounded(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(name + ' is outside the configured range.'); return value; }
