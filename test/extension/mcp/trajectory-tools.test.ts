import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpTrajectoryHandlers, MCP_TRAJECTORY_SPINE_TEMPLATE, MCP_TRAJECTORY_TOOL_NAME, sourceIdFromSpineUri } from '../../../src/extension/mcp/trajectory-tools';
import { MCP_READ_ONLY_TOOL_NAME, McpReadOnlyServer, type McpReadOnlyResourceRequest, type McpReadOnlyServerOptions } from '../../../src/extension/mcp/read-only-server';
import { createMcpRustQueryHandler, RustQueryBridge } from '../../../src/extension/rust-query-bridge';
import { TrajectorySliceQuery } from '../../../src/extension/trajectory/slice-query';
import { TRAJECTORY_REQUEST_SCHEMA, type TrajectorySliceResult } from '../../../src/shared/contracts/trajectory-slice';

const roots: string[] = [];
const servers: McpReadOnlyServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const modern = (params: Record<string, unknown> = {}) => ({ ...params, _meta: {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
} });
const args = (extra: Record<string, unknown> = {}) => ({ schema: TRAJECTORY_REQUEST_SCHEMA, requestId: 'slice-test', sourceId: 'source', predicate: { actor: 'user' }, ...extra });
const call = (server: McpReadOnlyServer, id: number, method: string, params?: unknown) => server.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
const tool = (server: McpReadOnlyServer, id: number, arguments_: Record<string, unknown>) => call(server, id, 'tools/call', modern({ name: MCP_TRAJECTORY_TOOL_NAME, arguments: arguments_ }));
interface Response {
  result?: {
    resultType?: string; capabilities?: object; ttlMs?: number; cacheScope?: string;
    tools?: { name: string; inputSchema: object }[];
    resourceTemplates?: unknown[]; resources?: unknown[];
    structuredContent?: TrajectorySliceResult;
    content?: { text: string }[]; isError?: boolean;
    contents?: { uri: string; mimeType: string; text: string }[];
  };
  error?: { code: number; message: string; data?: { code: string } };
}
function response(line: string | undefined): Response {
  if (line === undefined) throw new Error('Expected JSON-RPC response');
  return JSON.parse(line) as Response;
}
function start(options: Omit<McpReadOnlyServerOptions, 'transport'>): McpReadOnlyServer {
  const server = new McpReadOnlyServer({ ...options, transport: { sendLine() {}, onLine() { return () => {}; } } });
  server.start(); servers.push(server); return server;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jsonlview-mcp-trajectory-')); roots.push(root);
  const path = join(root, 'synthetic.jsonl');
  await writeFile(path, ['first', 'middle', 'last'].map((text, index) => JSON.stringify({
    type: index === 1 ? 'assistant' : 'user', sessionId: 'synthetic', uuid: `synthetic-${index}`,
    message: { role: index === 1 ? 'assistant' : 'user', content: text },
  })).join('\n'));
  const unusualId = 'opaque/id 空%2F';
  const sources = new Map([['source', path], [unusualId, path]]);
  const handlers = createMcpTrajectoryHandlers({ sources, allowedRoots: [root],
    legacyQuery: createMcpRustQueryHandler(new RustQueryBridge(), sources, { preferPortable: true }) });
  return { root, path, unusualId, handlers, server: start({ ...handlers, cancellationMode: 'cooperative' }) };
}

describe('production MCP trajectory routing', () => {
  it.each(['2026-07-28', '2025-11-25'] as const)('serves discovery, raw records, slice cursors and bounded spine through %s JSON-RPC', async (version) => {
    const { server } = await fixture();
    const params = (value: Record<string, unknown> = {}) => version === '2026-07-28' ? modern(value) : value;
    if (version !== '2026-07-28') {
      expect(response(await call(server, 1, 'initialize', { protocolVersion: version })).result).toMatchObject({ capabilities: { tools: {}, resources: {} } });
    } else {
      expect(response(await call(server, 1, 'server/discover', modern())).result).toMatchObject({ capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: 'private' });
    }
    const listed = response(await call(server, 2, 'tools/list', params())).result;
    expect(listed?.tools?.map((item) => item.name)).toEqual([MCP_READ_ONLY_TOOL_NAME, MCP_TRAJECTORY_TOOL_NAME]);
    expect(listed?.tools?.[1]?.inputSchema).toMatchObject({ additionalProperties: false, required: ['schema', 'requestId', 'sourceId', 'predicate'] });
    const raw = response(await call(server, 3, 'tools/call', params({ name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'source', limit: 1 } })));
    expect(raw.error).toBeUndefined();
    expect(raw.result?.isError).toBeUndefined();
    const first = response(await call(server, 4, 'tools/call', params({ name: MCP_TRAJECTORY_TOOL_NAME, arguments: args({ limit: 1 }) }))).result;
    expect(first?.structuredContent).toMatchObject({ status: 'partial', records: [{ ordinal: '0', text: 'first' }], reason: 'record_limit' });
    expect(JSON.parse(first?.content?.[0]?.text ?? 'null')).toEqual(first?.structuredContent);
    const payload = first?.structuredContent;
    if (payload?.status !== 'partial') throw new Error('Expected partial cursor');
    const second = response(await call(server, 5, 'tools/call', params({ name: MCP_TRAJECTORY_TOOL_NAME, arguments: args({ cursor: payload.cursor }) }))).result;
    expect(second?.structuredContent).toMatchObject({ status: 'complete', records: [{ ordinal: '2', text: 'last' }] });
    expect(response(await call(server, 6, 'resources/templates/list', params())).result?.resourceTemplates).toEqual([MCP_TRAJECTORY_SPINE_TEMPLATE]);
    expect(response(await call(server, 7, 'resources/list', params())).result?.resources).toEqual([]);
    const spine = response(await call(server, 8, 'resources/read', params({ uri: 'jsonlview://source/source/spine' }))).result;
    expect(spine?.contents?.[0]).toMatchObject({ uri: 'jsonlview://source/source/spine', mimeType: 'application/json' });
    expect(JSON.parse(spine?.contents?.[0]?.text ?? 'null')).toMatchObject({ schema: 'jsonlview.trajectory-spine.result.v1', status: 'complete',
      entries: [{ ordinal: '0' }, { ordinal: '1' }, { ordinal: '2' }], omitted: { invalidJson: 0, unknownActor: 0, toolPayloads: 0, textTruncated: 0 } });
    expect(spine?.resultType).toBe(version === '2026-07-28' ? 'complete' : undefined);
    expect(spine?.cacheScope).toBe(version === '2026-07-28' ? 'private' : undefined);
  });

  it('decodes a single encoded source segment once and compares the exact opaque binding', async () => {
    const { server, unusualId } = await fixture();
    const uri = `jsonlview://source/${encodeURIComponent(unusualId)}/spine`;
    expect(sourceIdFromSpineUri(uri)).toBe(unusualId);
    expect(response(await call(server, 1, 'resources/read', modern({ uri }))).result?.contents?.[0]?.text).toContain('"status":"complete"');
    for (const denied of ['file:///synthetic.jsonl', 'https://example.com/spine', 'jsonlview://source/source/spine?path=x',
      'jsonlview://source/source/spine#fragment', 'jsonlview://source/source/../spine', 'jsonlview://source/%73ource%252F/spine',
      'jsonlview://source/%252e%252e/spine', 'jsonlview://source/%FF/spine', 'jsonlview://source/C:\\private\\file/spine',
      'jsonlview://source/unknown/spine']) {
      expect(response(await call(server, 2, 'resources/read', modern({ uri: denied }))).error?.code, denied).toBe(-32602);
    }
    expect(response(await call(server, 3, 'resources/read', modern({ uri, path: 'private' }))).error?.code).toBe(-32602);
  });

  it('returns closed safe slice errors with identical structured and text representations', async () => {
    const { server, path } = await fixture();
    for (const [arguments_, code] of [[args({ predicate: {} }), 'INVALID_ARGUMENT'], [args({ predicate: { actor: 'owner' } }), 'INVALID_ARGUMENT'],
      [args({ predicate: { actor: 'user', extra: true } }), 'INVALID_ARGUMENT'], [args({ schema: 'unknown' }), 'INVALID_ARGUMENT'],
      [args({ sourceId: 'unknown' }), 'SOURCE_NOT_AUTHORIZED'], [args({ cursor: 'invalid' }), 'STALE_CURSOR']] as const) {
      const line = await tool(server, 1, arguments_);
      const result = response(line).result;
      expect(result).toMatchObject({ isError: true, structuredContent: { status: 'error', error: { code } } });
      expect(JSON.parse(result?.content?.[0]?.text ?? 'null')).toEqual(result?.structuredContent);
      expect(line).not.toContain(path);
    }
    expect(response(await tool(server, 2, args({ unexpected: 'private' }))).error?.code).toBe(-32602);
    vi.spyOn(TrajectorySliceQuery.prototype, 'query').mockRejectedValueOnce(new Error(`synthetic-private-content ${path}`));
    const failed = await tool(server, 3, args());
    expect(response(failed).result).toMatchObject({ isError: true, structuredContent: { error: { code: 'INTERNAL', recoverable: false } } });
    expect(failed).not.toContain('synthetic-private-content');
    expect(failed).not.toContain(path);
    expect(response(await tool(server, 4, args())).result?.structuredContent?.status).toBe('complete');
  });

  it('caps domain deadlines by the server budget and expires queued work without starting its scanner', async () => {
    const { handlers } = await fixture();
    expect(handlers.toolBudgetMs?.(MCP_TRAJECTORY_TOOL_NAME, args())).toBe(5000);
    const entered: AbortSignal[] = [];
    let release!: () => void;
    const blockingQuery = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
      entered.push(signal); release = () => resolve({ ok: true });
    }));
    const server = start({ ...handlers, query: blockingQuery, budgetMs: 15, maxConcurrency: 1 });
    const active = tool(server, 1, args({ deadlineMs: 30_000 }));
    const queued = tool(server, 2, args({ deadlineMs: 100 }));
    expect(response(await active).error?.data?.code).toBe('request_timeout');
    expect(response(await queued).error?.data?.code).toBe('request_timeout');
    expect(entered.every((signal) => signal.aborted)).toBe(true);
    expect(blockingQuery).toHaveBeenCalledOnce();
    release();
  });
});

describe('resource admission uses the tool execution lifecycle', () => {
  it('shares queue capacity, cancellation and version capture across resource and tool requests', async () => {
    let release!: () => void;
    const readResource = vi.fn(async ({ uri }: McpReadOnlyResourceRequest) => new Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>((resolve) => {
      release = () => resolve({ contents: [{ uri, mimeType: 'application/json', text: '{}' }] });
    }));
    const query = vi.fn(async () => ({ ok: true }));
    const server = start({ query, readResource, maxConcurrency: 1, maxQueuedRequests: 1 });
    const active = call(server, 1, 'resources/read', modern({ uri: 'jsonlview://source/source/spine' }));
    await call(server, 2, 'initialize', { protocolVersion: '2025-11-25' });
    const queued = call(server, 3, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    const overflow = response(await call(server, 4, 'resources/read', modern({ uri: 'jsonlview://source/source/spine' })));
    expect(overflow.error?.data?.code).toBe('server_busy');
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }));
    await expect(queued).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    const legacy = call(server, 5, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    release();
    expect(response(await active).result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' });
    expect(response(await legacy).result?.resultType).toBeUndefined();
    expect(readResource).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });

  it('cancels active resource reads and suppresses their responses before admitting the next tool', async () => {
    let resourceSignal: AbortSignal | undefined;
    const readResource = vi.fn(async ({ signal }: McpReadOnlyResourceRequest) => new Promise<never>((_resolve, reject) => {
      resourceSignal = signal; signal.addEventListener('abort', () => reject(new Error('private resource path')), { once: true });
    }));
    const server = start({ query: async () => ({ ok: true }), readResource, maxConcurrency: 1 });
    const active = call(server, 1, 'resources/read', modern({ uri: 'jsonlview://source/source/spine' }));
    const next = call(server, 2, 'tools/call', modern({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }));
    await expect(active).resolves.toBeUndefined();
    expect(resourceSignal?.aborted).toBe(true);
    expect(response(await next).result?.structuredContent).toEqual({ ok: true });
  });

  it('expires queued resources without entering the resource handler and redacts unexpected failures', async () => {
    let release!: () => void;
    const readResource = vi.fn(async () => { throw new Error('synthetic-private-resource C:/private'); });
    const server = start({ query: async () => new Promise((resolve) => { release = () => resolve({ ok: true }); }), readResource, maxConcurrency: 1, budgetMs: 15 });
    const active = call(server, 1, 'tools/call', modern({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    const queued = call(server, 2, 'resources/read', modern({ uri: 'jsonlview://source/source/spine' }));
    expect(response(await queued).error?.data?.code).toBe('request_timeout');
    expect(readResource).not.toHaveBeenCalled();
    release(); await active;
    const line = await call(server, 3, 'resources/read', modern({ uri: 'jsonlview://source/source/spine' }));
    expect(response(line).error?.data?.code).toBe('query_failed');
    expect(line).not.toContain('private');
  });
});
