import type {
  NavigationEntity,
  NavigationEntityKind,
  NavigationQuery,
  NavigationQueryResult,
  NavigationRelation,
} from './navigation-contract';

/**
 * Transport-independent compatibility set for the July 2026 MCP revision
 * and the previous maintenance revision. Keep this list explicit until a
 * transport owns the MCP initialize negotiation.
 */
export const MCP_NAVIGATION_PROTOCOL_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25'] as const);
export type McpNavigationProtocolVersion = (typeof MCP_NAVIGATION_PROTOCOL_VERSIONS)[number];

export const MCP_NAVIGATION_TOOL_NAME = 'jsonlview_query_session_metadata' as const;

const DEFAULT_BUDGET: Required<McpNavigationBudget> = Object.freeze({
  maxEntities: 500,
  maxRelations: 2_000,
  maxRecords: 2_000,
  maxMilliseconds: 1_000,
  maxBytes: 64 * 1024,
});
const MAX_BUDGET: Required<McpNavigationBudget> = Object.freeze({
  maxEntities: 10_000,
  maxRelations: 50_000,
  maxRecords: 50_000,
  maxMilliseconds: 10_000,
  maxBytes: 1024 * 1024,
});
const MAX_LIMIT = 100;
const MAX_CURSOR_COUNT = 64;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const NAVIGATION_KINDS: readonly NavigationEntityKind[] = [
  'source', 'session', 'thread', 'turn', 'workflow', 'team', 'tool', 'goal', 'plan', 'memory', 'task', 'subagent', 'event', 'other',
];

export interface McpNavigationBudget {
  readonly maxEntities?: number;
  readonly maxRelations?: number;
  readonly maxRecords?: number;
  readonly maxMilliseconds?: number;
  readonly maxBytes?: number;
}

export interface McpNavigationQueryArguments {
  readonly sourceId?: string;
  readonly cursor?: string;
  readonly kind?: NavigationEntityKind;
  readonly parentNativeId?: string;
  readonly text?: string;
  readonly limit?: number;
  readonly budget?: McpNavigationBudget;
}

export interface McpSessionMetadata {
  readonly id: string;
  readonly kind: NavigationEntityKind;
  readonly title: string;
  readonly parentId?: string;
  readonly startedAt?: string;
  readonly activityAt?: string;
  readonly status?: string;
  readonly relationship?: NavigationEntity['relationship'];
  readonly confidence: NavigationEntity['confidence'];
}

export interface McpSessionRelation {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: NavigationRelation['kind'];
}

export interface McpSessionMetadataPage {
  readonly protocolVersion: McpNavigationProtocolVersion;
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly entities: readonly McpSessionMetadata[];
  readonly relations: readonly McpSessionRelation[];
  readonly truncated: boolean;
  readonly truncatedReason?: NavigationQueryResult['truncatedReason'] | 'byte_limit';
  readonly nextCursor?: string;
}

export interface McpToolDefinition {
  readonly name: typeof MCP_NAVIGATION_TOOL_NAME;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly additionalProperties: false;
    readonly properties: Readonly<Record<string, unknown>>;
  };
  readonly annotations: { readonly readOnlyHint: true; readonly destructiveHint: false; };
}

export interface McpToolResult {
  readonly structuredContent: McpSessionMetadataPage;
  readonly isError?: false;
}

export type McpNavigationQuery = (operationId: string, query: NavigationQuery, signal: AbortSignal) => Promise<NavigationQueryResult>;

export interface McpNavigationAdapterOptions {
  readonly query: McpNavigationQuery;
  readonly allowedSourceIds: readonly string[];
  readonly sourceProviders?: Readonly<Record<string, string>>;
  readonly clock?: { now(): number };
  readonly cursorFactory?: () => string;
}

export type McpNavigationErrorCode =
  | 'unsupported_protocol_version'
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'source_not_allowlisted'
  | 'source_required'
  | 'stale_cursor'
  | 'cursor_query_mismatch'
  | 'cancelled'
  | 'response_too_large';

export class McpNavigationAdapterError extends Error {
  public readonly code: McpNavigationErrorCode;

  public constructor(code: McpNavigationErrorCode, message: string) {
    super(message);
    this.name = 'McpNavigationAdapterError';
    this.code = code;
  }
}

/** Negotiate only the two explicitly supported MCP revisions. */
export function negotiateMcpNavigationProtocolVersion(
  clientVersions?: readonly string[] | string,
  serverVersions: readonly string[] = MCP_NAVIGATION_PROTOCOL_VERSIONS,
): McpNavigationProtocolVersion {
  const client = clientVersions === undefined
    ? [...MCP_NAVIGATION_PROTOCOL_VERSIONS]
    : typeof clientVersions === 'string' ? [clientVersions] : [...clientVersions];
  assertKnownVersions(client, 'client');
  assertKnownVersions(serverVersions, 'server');
  for (const version of MCP_NAVIGATION_PROTOCOL_VERSIONS) {
    if (client.includes(version) && serverVersions.includes(version)) return version;
  }
  throw new McpNavigationAdapterError('unsupported_protocol_version', 'No supported MCP protocol version is shared.');
}

export const MCP_NAVIGATION_TOOL: McpToolDefinition = Object.freeze({
  name: MCP_NAVIGATION_TOOL_NAME,
  description: 'Query bounded, redacted local agent session metadata and relationships.',
  inputSchema: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({
      sourceId: { type: 'string', description: 'Allowlisted local source identifier.' },
      cursor: { type: 'string', description: 'Opaque in-memory continuation cursor.' },
      kind: { type: 'string', enum: NAVIGATION_KINDS },
      parentNativeId: { type: 'string' },
      text: { type: 'string', maxLength: 256 },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      budget: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxEntities: { type: 'integer', minimum: 1, maximum: MAX_BUDGET.maxEntities },
          maxRelations: { type: 'integer', minimum: 1, maximum: MAX_BUDGET.maxRelations },
          maxRecords: { type: 'integer', minimum: 1, maximum: MAX_BUDGET.maxRecords },
          maxMilliseconds: { type: 'integer', minimum: 1, maximum: MAX_BUDGET.maxMilliseconds },
          maxBytes: { type: 'integer', minimum: 128, maximum: MAX_BUDGET.maxBytes },
        },
      },
    }),
  }),
  annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false }),
});

interface CursorState {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly binding: string;
  readonly limit: number;
  readonly nextOffset: number;
  readonly expiresAt: number;
}

interface NormalizedQuery {
  readonly sourceId: string;
  readonly cursor?: string;
  readonly kind?: NavigationEntityKind;
  readonly parentNativeId?: string;
  readonly text?: string;
  readonly limit: number;
  readonly budget: Required<McpNavigationBudget>;
}

/**
 * Read-only MCP contract adapter. It deliberately owns no transport, process,
 * filesystem, VS Code, or SDK capability; a later transport can call `callTool`.
 */
export class McpReadOnlyNavigationAdapter {
  readonly #query: McpNavigationQuery;
  readonly #allowedSourceIds: ReadonlySet<string>;
  readonly #sourceProviders: Readonly<Record<string, string>>;
  readonly #clock: { now(): number };
  readonly #cursorFactory: () => string;
  readonly #cursors = new Map<string, CursorState>();

  public constructor(options: McpNavigationAdapterOptions) {
    this.#query = options.query;
    this.#allowedSourceIds = new Set(options.allowedSourceIds);
    this.#sourceProviders = options.sourceProviders ?? {};
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#cursorFactory = options.cursorFactory ?? defaultCursorFactory;
  }

  public negotiate(clientVersions?: readonly string[] | string): McpNavigationProtocolVersion {
    return negotiateMcpNavigationProtocolVersion(clientVersions);
  }

  public tools(protocolVersion?: string): readonly [McpToolDefinition] {
    if (protocolVersion !== undefined) assertSupportedVersion(protocolVersion);
    return [MCP_NAVIGATION_TOOL];
  }

  public async callTool(
    protocolVersion: string | undefined,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<McpToolResult> {
    const version = negotiateMcpNavigationProtocolVersion(protocolVersion);
    if (toolName !== MCP_NAVIGATION_TOOL_NAME) throw new McpNavigationAdapterError('unknown_tool', `Unsupported MCP tool: ${toolName}`);
    try {
      return { structuredContent: await this.querySessions(version, parseArguments(input), signal) };
    } catch (error) {
      if (error instanceof McpNavigationAdapterError) throw error;
      if (signal.aborted) throw new McpNavigationAdapterError('cancelled', 'MCP navigation query cancelled.');
      throw error;
    }
  }

  public async querySessions(
    protocolVersion: McpNavigationProtocolVersion,
    input: McpNavigationQueryArguments,
    signal: AbortSignal,
  ): Promise<McpSessionMetadataPage> {
    assertSupportedVersion(protocolVersion);
    throwIfCancelled(signal);
    const query = normalizeQuery(input, this.#allowedSourceIds);
    let cursorState: CursorState | undefined;
    if (query.cursor !== undefined) cursorState = this.readCursor(query.cursor);
    const effectiveQuery = cursorState !== undefined && input.limit === undefined ? { ...query, limit: cursorState.limit } : query;
    const binding = queryBinding(effectiveQuery);
    let snapshotId: string | undefined;
    let sourceId = query.sourceId;
    let offset = 0;
    let previousCursor: string | undefined;
    if (cursorState !== undefined) {
      const state = cursorState;
      if (state.binding !== binding || (query.sourceId !== undefined && state.sourceId !== query.sourceId)) {
        throw new McpNavigationAdapterError('cursor_query_mismatch', 'The continuation cursor is bound to a different query.');
      }
      sourceId = state.sourceId;
      snapshotId = state.snapshotId;
      offset = state.nextOffset;
      previousCursor = query.cursor;
    }
    this.assertSource(sourceId);
    const operationId = `mcp-${this.#cursorFactory()}`;
    let result: NavigationQueryResult;
    try {
      result = await this.#query(operationId, {
        sourceId,
        ...(snapshotId === undefined ? {} : { snapshotId }),
        ...(offset === 0 ? {} : { offset }),
        ...(effectiveQuery.kind === undefined ? {} : { kind: effectiveQuery.kind }),
        ...(effectiveQuery.parentNativeId === undefined ? {} : { parentNativeId: effectiveQuery.parentNativeId }),
        ...(effectiveQuery.text === undefined ? {} : { text: effectiveQuery.text }),
        limit: effectiveQuery.limit,
        budget: {
          maxEntities: effectiveQuery.budget.maxEntities,
          maxRelations: effectiveQuery.budget.maxRelations,
          maxRecords: effectiveQuery.budget.maxRecords,
          maxMilliseconds: effectiveQuery.budget.maxMilliseconds,
        },
      }, signal);
    } catch (error) {
      if (signal.aborted) throw new McpNavigationAdapterError('cancelled', 'MCP navigation query cancelled.');
      if (previousCursor !== undefined && isStaleSnapshotError(error)) {
        this.#cursors.delete(previousCursor);
        throw new McpNavigationAdapterError('stale_cursor', 'The continuation cursor refers to an expired snapshot.');
      }
      throw error;
    }
    if (result.sourceId !== sourceId || (snapshotId !== undefined && result.snapshotId !== snapshotId)) {
      if (previousCursor !== undefined) this.#cursors.delete(previousCursor);
      throw new McpNavigationAdapterError('stale_cursor', 'The continuation cursor snapshot changed.');
    }
    const projected = projectPage(result, effectiveQuery.budget, this.#sourceProviders[sourceId], protocolVersion);
    const hasMore = result.truncated && result.entities.length > 0;
    const response = this.fitResponse(projected, effectiveQuery.budget.maxBytes, hasMore, offset);
    if (previousCursor !== undefined) this.#cursors.delete(previousCursor);
    if (response.nextOffset !== undefined) {
      const cursor = this.writeCursor({
        sourceId,
        snapshotId: result.snapshotId,
        binding,
        limit: effectiveQuery.limit,
        nextOffset: response.nextOffset,
        expiresAt: this.#clock.now() + CURSOR_TTL_MS,
      });
      return { ...response.page, nextCursor: cursor };
    }
    return response.page;
  }

  private assertSource(sourceId: string): void {
    if (!this.#allowedSourceIds.has(sourceId)) throw new McpNavigationAdapterError('source_not_allowlisted', `MCP source is not allowlisted: ${sourceId}`);
  }

  private readCursor(token: string): CursorState {
    const state = this.#cursors.get(token);
    if (state === undefined || state.expiresAt <= this.#clock.now()) {
      this.#cursors.delete(token);
      throw new McpNavigationAdapterError('stale_cursor', 'The continuation cursor is unknown or expired.');
    }
    return state;
  }

  private writeCursor(state: CursorState): string {
    let token = this.#cursorFactory();
    while (this.#cursors.has(token)) token = this.#cursorFactory();
    this.#cursors.set(token, state);
    while (this.#cursors.size > MAX_CURSOR_COUNT) {
      const oldest = this.#cursors.keys().next().value;
      if (oldest === undefined) break;
      this.#cursors.delete(oldest);
    }
    return token;
  }

  private fitResponse(
    projected: McpSessionMetadataPage,
    maxBytes: number,
    hasMore: boolean,
    offset: number,
  ): { page: McpSessionMetadataPage; nextOffset?: number } {
    for (let entityCount = projected.entities.length; entityCount >= 0; entityCount -= 1) {
      const entities = projected.entities.slice(0, entityCount);
      const ids = new Set(entities.map((entity) => entity.id));
      const relations = projected.relations.filter((relation) => ids.has(relation.fromId) || ids.has(relation.toId));
      const page = { ...projected, entities, relations, ...(entityCount < projected.entities.length ? { truncated: true, truncatedReason: 'byte_limit' as const } : {}) };
      if (byteLength(JSON.stringify(page)) <= maxBytes) {
        if (entityCount === 0 && projected.entities.length > 0) {
          throw new McpNavigationAdapterError('response_too_large', 'A single MCP navigation entity exceeds the byte budget.');
        }
        return { page, ...(hasMore || entityCount < projected.entities.length ? { nextOffset: offset + entityCount } : {}) };
      }
    }
    throw new McpNavigationAdapterError('response_too_large', 'MCP navigation response exceeds the byte budget.');
  }
}

function parseArguments(value: unknown): McpNavigationQueryArguments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new McpNavigationAdapterError('invalid_arguments', 'MCP navigation arguments must be an object.');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['sourceId', 'cursor', 'kind', 'parentNativeId', 'text', 'limit', 'budget']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new McpNavigationAdapterError('invalid_arguments', `Unsupported MCP navigation argument: ${key}`);
  const budget = input.budget === undefined ? undefined : parseBudget(input.budget);
  const kind = input.kind === undefined ? undefined : parseKind(input.kind);
  for (const key of ['sourceId', 'cursor', 'parentNativeId', 'text'] as const) if (input[key] !== undefined && typeof input[key] !== 'string') throw new McpNavigationAdapterError('invalid_arguments', `${key} must be a string.`);
  if (input.limit !== undefined && !Number.isSafeInteger(input.limit)) throw new McpNavigationAdapterError('invalid_arguments', 'limit must be an integer.');
  const text = input.text as string | undefined;
  if (text !== undefined && (text.length > 256 || byteLength(text) > 1024)) throw new McpNavigationAdapterError('invalid_arguments', 'text exceeds the bounded query length.');
  return {
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId as string }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }),
    ...(kind === undefined ? {} : { kind }),
    ...(input.parentNativeId === undefined ? {} : { parentNativeId: input.parentNativeId as string }),
    ...(text === undefined ? {} : { text }),
    ...(input.limit === undefined ? {} : { limit: input.limit as number }),
    ...(budget === undefined ? {} : { budget }),
  };
}

function parseBudget(value: unknown): McpNavigationBudget {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new McpNavigationAdapterError('invalid_arguments', 'budget must be an object.');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['maxEntities', 'maxRelations', 'maxRecords', 'maxMilliseconds', 'maxBytes']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new McpNavigationAdapterError('invalid_arguments', `Unsupported MCP budget field: ${key}`);
  for (const key of allowed) {
    const minimum = key === 'maxBytes' ? 128 : 1;
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || (input[key] as number) < minimum || (input[key] as number) > MAX_BUDGET[key as keyof typeof MAX_BUDGET])) throw new McpNavigationAdapterError('invalid_arguments', `${key} is outside the active MCP budget.`);
  }
  return input as McpNavigationBudget;
}

function parseKind(value: unknown): NavigationEntityKind {
  if (typeof value !== 'string' || !NAVIGATION_KINDS.includes(value as NavigationEntityKind)) {
    throw new McpNavigationAdapterError('invalid_arguments', 'kind is not a supported navigation entity kind.');
  }
  return value as NavigationEntityKind;
}

function normalizeQuery(input: McpNavigationQueryArguments, allowed: ReadonlySet<string>): NormalizedQuery {
  const sourceId = input.sourceId ?? (allowed.size === 1 ? allowed.values().next().value : undefined);
  if (sourceId === undefined) throw new McpNavigationAdapterError('source_required', 'MCP navigation requires an explicit sourceId when multiple sources are allowlisted.');
  const limit = input.limit ?? Math.min(MAX_LIMIT, DEFAULT_BUDGET.maxEntities);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new McpNavigationAdapterError('invalid_arguments', `limit must be between 1 and ${String(MAX_LIMIT)}.`);
  const budget = { ...DEFAULT_BUDGET, ...(input.budget === undefined ? {} : parseBudget(input.budget)) };
  return { ...input, sourceId, limit, budget };
}

function queryBinding(query: NormalizedQuery): string {
  return JSON.stringify({ sourceId: query.sourceId, kind: query.kind ?? null, parentNativeId: query.parentNativeId ?? null, text: query.text ?? null, limit: query.limit, budget: query.budget });
}

function projectPage(result: NavigationQueryResult, budget: Required<McpNavigationBudget>, provider: string | undefined, protocolVersion: McpNavigationProtocolVersion): McpSessionMetadataPage {
  const entities = result.entities.slice(0, budget.maxEntities).map((entity) => projectEntity(entity, provider));
  const ids = new Set(entities.map((entity) => entity.id));
  const relations = result.relations.slice(0, budget.maxRelations).filter((relation) => ids.has(relation.fromNativeId) || ids.has(relation.toNativeId)).map((relation) => ({ fromId: relation.fromNativeId, toId: relation.toNativeId, kind: relation.kind }));
  return { protocolVersion, sourceId: result.sourceId, snapshotId: result.snapshotId, entities, relations, truncated: result.truncated, ...(result.truncatedReason === undefined ? {} : { truncatedReason: result.truncatedReason }) };
}

function projectEntity(entity: NavigationEntity, provider: string | undefined): McpSessionMetadata {
  const title = safeTitle(entity.productTitle) ?? safeTitle(entity.vendorTitle) ?? `${provider ?? entity.kind} · ${shortId(entity.nativeId)}`;
  return {
    id: entity.nativeId,
    kind: entity.kind,
    title,
    ...(entity.parentNativeId === undefined ? {} : { parentId: entity.parentNativeId }),
    ...(entity.startedAt === undefined ? {} : { startedAt: entity.startedAt }),
    ...(entity.activityAt === undefined ? {} : { activityAt: entity.activityAt }),
    ...(entity.status === undefined ? {} : { status: entity.status }),
    ...(entity.relationship === undefined ? {} : { relationship: entity.relationship }),
    confidence: entity.confidence,
  };
}

function safeTitle(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 256 || byteLength(value) > 1_024 || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:\/\/)/u.test(value)) return undefined;
  return value;
}

function shortId(value: string): string {
  return value.length <= 16 ? value : value.slice(-16);
}

function assertKnownVersions(values: readonly string[], side: string): void {
  for (const value of values) if (!MCP_NAVIGATION_PROTOCOL_VERSIONS.includes(value as McpNavigationProtocolVersion)) throw new McpNavigationAdapterError('unsupported_protocol_version', `Unknown MCP ${side} protocol version: ${value}`);
}

function assertSupportedVersion(value: string): asserts value is McpNavigationProtocolVersion {
  if (!MCP_NAVIGATION_PROTOCOL_VERSIONS.includes(value as McpNavigationProtocolVersion)) throw new McpNavigationAdapterError('unsupported_protocol_version', `Unknown MCP protocol version: ${value}`);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new McpNavigationAdapterError('cancelled', 'MCP navigation query cancelled.');
}

function isStaleSnapshotError(error: unknown): boolean {
  return error instanceof Error && /unknown navigation snapshot|snapshot changed/i.test(error.message);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function defaultCursorFactory(): string {
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
