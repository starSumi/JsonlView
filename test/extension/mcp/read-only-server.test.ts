import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_READ_ONLY_PROTOCOL_VERSIONS,
  MCP_READ_ONLY_TOOL_NAME,
  McpReadOnlyServer,
  McpReadOnlyServerError,
  type McpLineTransport,
  type McpReadOnlyQueryRequest,
} from '../../../src/extension/mcp/read-only-server';
import { createMcpRustQueryHandler, RustQueryBridge, RUST_QUERY_SCHEMA } from '../../../src/extension/rust-query-bridge';

function transport(): McpLineTransport & { lines: string[]; emit(line: string): void } {
  const lines: string[] = [];
  let listener: ((line: string) => void) | undefined;
  return {
    lines,
    sendLine(line) { lines.push(line); },
    onLine(next) { listener = next; return () => { listener = undefined; }; },
    emit(line) { listener?.(line); },
  };
}

async function request(server: McpReadOnlyServer, id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
  const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
  expect(line).toBeTypeOf('string');
  return JSON.parse(line!) as Record<string, unknown>;
}

function modernParams(params: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } };
}

describe('MCP read-only JSON-RPC server', () => {
  it('does not subscribe until explicitly started and disconnects cleanly', async () => {
    const host = transport();
    const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => ({ ok: true })) });
    await expect(server.handleLine('{}')).rejects.toMatchObject({ code: 'server_stopped' });
    expect(server.started).toBe(false);
    server.start();
    expect(server.started).toBe(true);
    server.stop();
    expect(server.started).toBe(false);
    expect(() => server.start()).toThrow(/cannot be restarted/u);
  });

  it('negotiates legacy protocol revisions and exposes only read-only tools', async () => {
    expect(MCP_READ_ONLY_PROTOCOL_VERSIONS).toEqual(['2026-07-28', '2025-11-25', '2025-06-18']);
    for (const [index, protocolVersion] of ['2025-11-25', '2025-06-18'].entries()) {
      const host = transport();
      const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => ({ records: [] })) });
      server.start();
      const initialized = await request(server, index + 1, 'initialize', { protocolVersion });
      expect(initialized.result).toMatchObject({ protocolVersion, capabilities: { tools: {} } });
      const listed = await request(server, index + 10, 'tools/list');
      expect(listed.result).toMatchObject({ tools: [{ name: MCP_READ_ONLY_TOOL_NAME, annotations: { readOnlyHint: true, destructiveHint: false } }] });
      expect(listed.result).not.toHaveProperty('resultType');
    }
  });

  it('falls back to the newest legacy version during initialize', async () => {
    for (const protocolVersion of ['2024-10-01', '2026-07-28', '2099-01-01']) {
      const server = new McpReadOnlyServer({ transport: transport(), query: vi.fn(async () => null) });
      server.start();
      const initialized = await request(server, 1, 'initialize', { protocolVersion });
      expect(initialized.result).toMatchObject({ protocolVersion: '2025-11-25' });
    }

    const configured = new McpReadOnlyServer({
      transport: transport(),
      protocolVersions: ['2025-06-18', '2025-11-25'],
      query: vi.fn(async () => null),
    });
    configured.start();
    const initialized = await request(configured, 1, 'initialize', { protocolVersion: '2099-01-01' });
    expect(initialized.result).toMatchObject({ protocolVersion: '2025-11-25' });
  });

  it('serves modern discovery, tools and ping without initialize or optional clientInfo', async () => {
    const query = vi.fn(async () => ({ records: [] }));
    const server = new McpReadOnlyServer({ transport: transport(), query });
    server.start();
    const discovered = await request(server, 1, 'server/discover', modernParams());
    expect(discovered.result).toEqual({
      resultType: 'complete',
      supportedVersions: [...MCP_READ_ONLY_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'JsonlView', version: '0.1.0' } },
      ttlMs: 0,
      cacheScope: 'private',
    });
    const listed = await request(server, 2, 'tools/list', modernParams());
    expect(listed.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [{ name: MCP_READ_ONLY_TOOL_NAME }] });
    const called = await request(server, 3, 'tools/call', modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    expect(called.result).toMatchObject({ resultType: 'complete', structuredContent: { records: [] } });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: '2026-07-28' }));
    expect((await request(server, 4, 'ping', modernParams())).result).toEqual({ resultType: 'complete' });
    expect(server.initialized).toBe(false);
    expect(server.protocolVersion).toBeUndefined();
    expect((await request(server, 5, 'tools/list')).error).toMatchObject({ code: -32602 });
  });

  it.each([
    undefined,
    {},
    { _meta: null },
    { _meta: { 'io.modelcontextprotocol/clientCapabilities': {} } },
    { _meta: { 'io.modelcontextprotocol/protocolVersion': 2026, 'io.modelcontextprotocol/clientCapabilities': {} } },
    { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': [] } },
  ])('rejects missing or malformed modern metadata without invoking the adapter (%#)', async (params) => {
    const query = vi.fn(async () => null);
    const server = new McpReadOnlyServer({ transport: transport(), query });
    server.start();
    const response = await request(server, 1, 'tools/list', params);
    expect(response.error).toMatchObject({ code: -32602, data: { code: 'invalid_params' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unsupported per-request versions with the normative modern error shape', async () => {
    const server = new McpReadOnlyServer({ transport: transport(), query: vi.fn(async () => null) });
    server.start();
    const response = await request(server, 1, 'server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {} },
    });
    expect(response.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: [...MCP_READ_ONLY_PROTOCOL_VERSIONS], requested: '2099-01-01' } });
    expect((await request(server, 2, 'server/discover', modernParams())).result).toHaveProperty('resultType', 'complete');
  });

  it('does not let per-request metadata bypass the legacy handshake', async () => {
    const query = vi.fn(async () => null);
    const server = new McpReadOnlyServer({ transport: transport(), query });
    server.start();
    const response = await request(server, 1, 'tools/call', {
      ...modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }),
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25', 'io.modelcontextprotocol/clientCapabilities': {} },
    });
    expect(response.error).toMatchObject({ data: { code: 'not_initialized' } });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([1, 2])('keeps queued and concurrent modern and legacy versions isolated with %i active slots', async (maxConcurrency) => {
    const releases: Array<() => void> = [];
    const query = vi.fn(async ({ protocolVersion }: McpReadOnlyQueryRequest) => new Promise((resolve) => releases.push(() => resolve({ version: protocolVersion }))));
    const server = new McpReadOnlyServer({ transport: transport(), query, maxConcurrency });
    server.start();
    const first = request(server, 1, 'tools/call', modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    const queuedModern = request(server, 2, 'tools/call', modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    await request(server, 3, 'initialize', { protocolVersion: '2025-06-18' });
    const queuedLegacy = request(server, 4, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(query).toHaveBeenCalledTimes(maxConcurrency);
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(query.mock.calls.length).toBeGreaterThanOrEqual(index + 1));
      releases[index]!();
    }
    const [firstResult, modernResult, legacyResult] = await Promise.all([first, queuedModern, queuedLegacy]);
    expect(query.mock.calls.map(([call]) => call.protocolVersion)).toEqual(['2026-07-28', '2026-07-28', '2025-06-18']);
    expect(firstResult.result).toHaveProperty('resultType', 'complete');
    expect(modernResult.result).toMatchObject({ resultType: 'complete', structuredContent: { version: '2026-07-28' } });
    expect(legacyResult.result).toMatchObject({ structuredContent: { version: '2025-06-18' } });
    expect(legacyResult.result).not.toHaveProperty('resultType');
    expect(server.protocolVersion).toBe('2025-06-18');
    expect((await request(server, 5, 'tools/list', modernParams())).result).toHaveProperty('resultType', 'complete');
    const missingCapabilities = await request(server, 6, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    expect(missingCapabilities.error).toMatchObject({ code: -32602 });
    expect((await request(server, 7, 'tools/list')).result).not.toHaveProperty('resultType');
  });

  it('keeps modern-only and legacy-only configuration behavior explicit', async () => {
    const modern = new McpReadOnlyServer({ transport: transport(), protocolVersions: ['2026-07-28'], query: vi.fn(async () => null) });
    modern.start();
    const rejectedInitialize = await request(modern, 1, 'initialize', { protocolVersion: '2025-11-25' });
    expect(rejectedInitialize.error).toMatchObject({ code: -32601, message: expect.stringContaining('2026-07-28') });
    const unsupported = await request(modern, 2, 'server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25', 'io.modelcontextprotocol/clientCapabilities': {} } });
    expect(unsupported.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2025-11-25' } });
    expect((await request(modern, 3, 'server/discover', modernParams())).result).toHaveProperty('supportedVersions', ['2026-07-28']);
    const legacy = new McpReadOnlyServer({ transport: transport(), protocolVersions: ['2025-06-18'], query: vi.fn(async () => null) });
    legacy.start();
    expect((await request(legacy, 1, 'tools/list')).error).toMatchObject({ data: { code: 'not_initialized' } });
    expect((await request(legacy, 2, 'initialize', { protocolVersion: '2025-11-25' })).result).toHaveProperty('protocolVersion', '2025-06-18');
    expect((await request(legacy, 3, 'tools/list')).result).not.toHaveProperty('resultType');
  });

  it('redacts modern query failures and keeps serving after modern cancellation', async () => {
    const query = vi.fn(async ({ signal }: McpReadOnlyQueryRequest) => {
      if (query.mock.calls.length === 1) throw new Error('synthetic-private-content at C:/private/source.jsonl');
      if (query.mock.calls.length > 2) return { ok: true };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic-private-content')), { once: true }));
    });
    const server = new McpReadOnlyServer({ transport: transport(), query, cancellationMode: 'cooperative' });
    server.start();
    const failed = await request(server, 1, 'tools/call', modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    expect(failed.error).toEqual({ code: -32000, message: 'MCP query failed.', data: { code: 'query_failed' } });
    const pending = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }) }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }));
    expect(await pending).toBeUndefined();
    const afterCancel = await request(server, 3, 'tools/call', modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }));
    expect(afterCancel.result).toMatchObject({ resultType: 'complete', structuredContent: { ok: true } });
    expect(query.mock.calls.every(([call]) => call.protocolVersion === '2026-07-28')).toBe(true);
  });

  it('validates the read-only boundary before invoking the query function', async () => {
    const host = transport();
    const query = vi.fn(async () => ({ rows: [{ ordinal: 0 }] }));
    const server = new McpReadOnlyServer({ transport: host, query, allowedSourceIds: ['local'] });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const accepted = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local', limit: 2 } });
    expect(accepted.result).toMatchObject({ structuredContent: { rows: [{ ordinal: 0 }] } });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ toolName: MCP_READ_ONLY_TOOL_NAME, protocolVersion: '2025-11-25', arguments: { sourceId: 'local', limit: 2 }, signal: expect.any(AbortSignal) }));
    const unknownSource = await request(server, 3, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'private' } });
    expect(unknownSource.error).toMatchObject({ data: { code: 'invalid_params' } });
    const pathAttempt = await request(server, 4, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local', path: 'C:/secret.jsonl' } });
    expect(pathAttempt.error).toMatchObject({ data: { code: 'invalid_params' } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns standard errors for method and argument failures', async () => {
    const host = transport();
    const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => null) });
    server.start();
    const beforeInit = await request(server, 1, 'tools/list');
    expect(beforeInit.error).toMatchObject({ code: -32602, data: { code: 'invalid_params' } });
    const initialized = await request(server, 2, 'initialize', { protocolVersion: '2025-11-25' });
    expect(initialized.result).toMatchObject({ protocolVersion: '2025-11-25' });
    const unknownMethod = await request(server, 3, 'unknown/method');
    expect(unknownMethod.error).toMatchObject({ code: -32601, data: { code: 'method_not_found' } });
    const unknownTool = await request(server, 4, 'tools/call', { name: 'jsonlview_write_file', arguments: {} });
    expect(unknownTool.error).toMatchObject({ code: -32601, data: { code: 'unknown_tool' } });
    const invalid = await request(server, 5, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { limit: 0 } });
    expect(invalid.error).toMatchObject({ code: -32602, data: { code: 'invalid_params' } });
  });

  it('enforces query timeout and response byte budgets', async () => {
    const host = transport();
    const server = new McpReadOnlyServer({
      transport: host,
      requestTimeoutMs: 5,
      cancellationMode: 'cooperative',
      maxResponseBytes: 256,
      query: vi.fn(async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const timeout = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(timeout.error).toMatchObject({ data: { code: 'request_timeout' } });

    const oversized = new McpReadOnlyServer({ transport: transport(), maxResponseBytes: 256, query: vi.fn(async () => ({ text: 'x'.repeat(2_000) })) });
    oversized.start();
    await request(oversized, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const result = await request(oversized, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(result.error).toMatchObject({ data: { code: 'response_too_large' } });
  });

  it('uses modern internal-error mapping while retaining the legacy timeout code', async () => {
    const modern = new McpReadOnlyServer({
      transport: transport(), requestTimeoutMs: 5, cancellationMode: 'cooperative',
      query: vi.fn(async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    modern.start();
    const modernTimeout = await modern.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }) }));
    expect(JSON.parse(modernTimeout!).error).toMatchObject({ code: -32603, data: { code: 'request_timeout' } });

    const legacy = new McpReadOnlyServer({
      transport: transport(), requestTimeoutMs: 5, cancellationMode: 'cooperative',
      query: vi.fn(async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    });
    legacy.start();
    await request(legacy, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const legacyTimeout = await request(legacy, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(legacyTimeout.error).toMatchObject({ code: -32002, data: { code: 'request_timeout' } });
  });

  it('rejects null request IDs and bounds every error response, including arbitrary version strings', async () => {
    const server = new McpReadOnlyServer({ transport: transport(), maxResponseBytes: 256, query: vi.fn(async () => null) });
    server.start();
    const nullId = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping', params: modernParams() }));
    expect(JSON.parse(nullId!).error).toMatchObject({ code: -32600 });
    const hugeVersion = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '9'.repeat(10_000), 'io.modelcontextprotocol/clientCapabilities': {},
    } } }));
    expect(new TextEncoder().encode(hugeVersion!).byteLength).toBeLessThanOrEqual(256);
    expect(JSON.parse(hugeVersion!).error).toMatchObject({ code: -32022, message: 'Unsupported protocol version' });
    expect(JSON.parse(hugeVersion!).error).not.toHaveProperty('data');
    const hugeMethod = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'm'.repeat(10_000), params: modernParams() }));
    expect(new TextEncoder().encode(hugeMethod!).byteLength).toBeLessThanOrEqual(256);
    expect(JSON.parse(hugeMethod!).error).toMatchObject({ code: -32601, message: 'Unsupported MCP method.' });
    const hugeId = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'i'.repeat(10_000), method: 'ping', params: modernParams() }));
    expect(new TextEncoder().encode(hugeId!).byteLength).toBeLessThanOrEqual(256);
    expect(JSON.parse(hugeId!)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('cancels a pending tools/call through notifications/cancelled', async () => {
    const host = transport();
    const query = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative' });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const pending = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } }));
    expect(await pending).toBeUndefined();
  });

  it('bounds active tool queries and starts queued work as slots are released', async () => {
    const host = transport();
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const query = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise((resolve) => releases.push(() => { active -= 1; resolve({ ok: true }); }));
    });
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative', maxConcurrency: 2, maxQueuedRequests: 2 });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });

    const calls = [2, 3, 4].map((id) => server.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } })));
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    releases[0]!();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(3));
    releases[1]!();
    releases[2]!();
    const responses = await Promise.all(calls);
    expect(responses.every((line) => line !== undefined)).toBe(true);
    expect(maximumActive).toBe(2);
  });

  it('rejects requests beyond the bounded waiting queue without starting extra work', async () => {
    const host = transport();
    const releases: Array<() => void> = [];
    const query = vi.fn(async ({ arguments: args }: { arguments: Readonly<Record<string, unknown>> }) => {
      if (args.limit === 1 || args.limit === 2) return new Promise((resolve) => releases.push(() => resolve({ ok: true })));
      return { ok: true };
    });
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative', maxConcurrency: 1, maxQueuedRequests: 1 });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });

    const first = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: { limit: 1 } } }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const second = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: { limit: 2 } } }));
    const overflow = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: { limit: 3 } } }));
    releases[0]!();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    releases[1]!();
    const [firstLine, secondLine, overflowLine] = await Promise.all([first, second, overflow]);

    expect(firstLine).toContain('"result"');
    expect(secondLine).toContain('"result"');
    expect(JSON.parse(overflowLine!).error).toMatchObject({ data: { code: 'server_busy' } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('uses the total arrival-to-finish budget while a request waits in the queue', async () => {
    const host = transport();
    let releaseFirst: (() => void) | undefined;
    const query = vi.fn(async () => {
      if (query.mock.calls.length > 1) return { ok: true };
      return new Promise((resolve) => { releaseFirst = () => resolve({ ok: true }); });
    });
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative', maxConcurrency: 1, budgetMs: 5 });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });

    const active = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    const queued = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await expect(active).resolves.toContain('request_timeout');
    await expect(queued).resolves.toContain('request_timeout');
    expect(query).toHaveBeenCalledTimes(1);

    releaseFirst!();
    await vi.waitFor(() => expect(active).resolves.toContain('request_timeout'));
    const afterTimeout = await request(server, 4, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(afterTimeout.result).toBeDefined();
  });

  it('removes cancelled queued work and keeps serving after active cancellation', async () => {
    const host = transport();
    const query = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      if (query.mock.calls.length > 1) return { ok: 'later' };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative', maxConcurrency: 1 });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });

    const active = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const queued = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }));
    await expect(queued).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();

    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }));
    await expect(active).resolves.toBeUndefined();
    const afterCancel = await request(server, 4, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(afterCancel.result).toMatchObject({ structuredContent: { ok: 'later' } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate request IDs while the first request is still pending', async () => {
    const host = transport();
    const query = vi.fn(async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5)));
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative' });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const first = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    const duplicate = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(duplicate.error).toMatchObject({ data: { code: 'invalid_request' } });
    await expect(first).resolves.toContain('"result"');
    expect(query).toHaveBeenCalledOnce();
  });

  it('aborts active and queued calls when the server stops', async () => {
    const host = transport();
    const query = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative', maxConcurrency: 1 });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const active = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    const queued = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    server.stop();
    await expect(active).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });

  it('reports oversized records as a sanitized query failure through the Rust-to-MCP production adapter', async () => {
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2,
      capabilities: () => 4,
      queryRecords: () => { throw new Error('jsonl-query:record-exceeds-max-bytes'); },
    } });
    const query = createMcpRustQueryHandler(bridge, new Map([['local', 'C:/authorized/data.jsonl']]));
    const server = new McpReadOnlyServer({ transport: transport(), allowedSourceIds: ['local'], query });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const response = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local', maxBytes: 4 } });
    expect(response.error).toMatchObject({ data: { code: 'query_failed' } });
    expect(response.error).toMatchObject({ message: 'MCP query failed.' });
  });

  it.each([
    new Error('synthetic-private-content at C:/private/source.jsonl'),
    new McpReadOnlyServerError('query_failed', 'synthetic-private-content at C:/private/source.jsonl', { content: 'synthetic-private-content' }),
    'synthetic-private-content at C:/private/source.jsonl',
  ])('does not expose query adapter diagnostics in protocol errors (%#)', async (failure) => {
    const server = new McpReadOnlyServer({ transport: transport(), query: vi.fn(async () => { throw failure; }) });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const response = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(response.error).toEqual({ code: -32000, message: 'MCP query failed.', data: { code: 'query_failed' } });
    expect(JSON.stringify(response)).not.toContain('synthetic-private-content');
    expect(JSON.stringify(response)).not.toContain('private/source.jsonl');
  });

  it('preserves typed adapter error codes without their message or data', async () => {
    const server = new McpReadOnlyServer({
      transport: transport(),
      query: vi.fn(async () => { throw new McpReadOnlyServerError('invalid_params', 'synthetic-private-content', { content: 'synthetic-private-content' }); }),
    });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const response = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(response.error).toEqual({ code: -32602, message: 'MCP query failed.', data: { code: 'invalid_params' } });
  });

  it.each([
    new Error('synthetic-private-content at C:/private/source.jsonl'),
    new McpReadOnlyServerError('query_failed', 'synthetic-private-content at C:/private/source.jsonl'),
  ])('does not expose response serialization diagnostics (%#)', async (failure) => {
    const server = new McpReadOnlyServer({
      transport: transport(),
      query: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'bounded' }],
        structuredContent: { toJSON() { throw failure; } },
      })),
    });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const response = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(response.error).toEqual({ code: -32000, message: 'MCP result is not JSON serializable.', data: { code: 'query_failed' } });
    expect(JSON.stringify(response)).not.toContain('synthetic-private-content');
  });

  it('drops an over-budget synchronous native result even though the native call cannot be interrupted', async () => {
    const nativeQuery = vi.fn(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      return JSON.stringify({
        schema: RUST_QUERY_SCHEMA,
        snapshot: { sizeBytes: '3', modifiedUnixMillis: '1' },
        records: [{ ordinal: '0', startByte: '0', endByte: '3', raw: 'row' }],
        nextOrdinal: null,
        truncated: false,
        truncationReason: null,
      });
    });
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2,
      capabilities: () => 4,
      queryRecords: nativeQuery,
    } });
    const query = vi.fn(createMcpRustQueryHandler(bridge, new Map([['local', 'C:/authorized/data.jsonl']])));
    const server = new McpReadOnlyServer({
      transport: transport(),
      allowedSourceIds: ['local'],
      requestTimeoutMs: 1,
      query,
    });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
    const response = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local' } });
    expect(response.error).toMatchObject({ data: { code: 'request_timeout' } });
    expect(nativeQuery).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ cancellationSupported: false, signal: expect.any(AbortSignal) }));
  });

  it('forwards stdio cancellation to the portable MCP query adapter and suppresses its response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-mcp-stdio-cancel-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, '{"ok":true}\n', 'utf8');
    let enterQuery!: () => void;
    let releaseQuery!: () => void;
    const entered = new Promise<void>((resolve) => { enterQuery = resolve; });
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const nativeQuery = vi.fn(() => { throw new Error('portable stdio must not call native synchronously'); });
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2,
      capabilities: () => 4,
      queryRecords: nativeQuery,
    } });
    const portable = createMcpRustQueryHandler(bridge, new Map([['local', file]]), { preferPortable: true });
    const query = vi.fn(async (request: Parameters<typeof portable>[0]) => {
      enterQuery();
      await gate;
      return portable(request);
    });
    const server = new McpReadOnlyServer({
      transport: transport(),
      allowedSourceIds: ['local'],
      cancellationMode: 'cooperative',
      budgetMs: 1_000,
      query,
    });
    server.start();
    try {
      await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
      const call = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local' } } }));
      await entered;
      await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }));
      await expect(call).resolves.toBeUndefined();
      releaseQuery();
      await vi.waitFor(() => expect(nativeQuery).not.toHaveBeenCalled());
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ cancellationSupported: true, signal: expect.any(AbortSignal) }));
    } finally {
      releaseQuery();
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces the packaged portable query budget and aborts its signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-mcp-stdio-budget-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, '{"ok":true}\n', 'utf8');
    let enterQuery!: () => void;
    let releaseQuery!: () => void;
    const entered = new Promise<void>((resolve) => { enterQuery = resolve; });
    const gate = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const nativeQuery = vi.fn(() => { throw new Error('portable stdio must not call native synchronously'); });
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2,
      capabilities: () => 4,
      queryRecords: nativeQuery,
    } });
    const portable = createMcpRustQueryHandler(bridge, new Map([['local', file]]), { preferPortable: true });
    const query = vi.fn(async (request: Parameters<typeof portable>[0]) => {
      enterQuery();
      await gate;
      return portable(request);
    });
    const server = new McpReadOnlyServer({
      transport: transport(),
      allowedSourceIds: ['local'],
      cancellationMode: 'cooperative',
      budgetMs: 10,
      query,
    });
    server.start();
    try {
      await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' });
      const call = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local' } } }));
      await entered;
      const response = await call;
      expect(JSON.parse(response!).error).toMatchObject({ data: { code: 'request_timeout' } });
      releaseQuery();
      await vi.waitFor(() => expect(nativeQuery).not.toHaveBeenCalled());
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ cancellationSupported: true, signal: expect.any(AbortSignal) }));
      expect(query.mock.calls[0]?.[0].signal.aborted).toBe(true);
    } finally {
      releaseQuery();
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('writes responses through the line transport and ignores notifications (modern: %s)', async (modern) => {
    const host = transport();
    const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => ({ rows: [] })) });
    server.start();
    host.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, method: modern ? 'server/discover' : 'initialize', params: modern ? modernParams() : { protocolVersion: '2025-11-25' } }));
    await vi.waitFor(() => expect(host.lines).toHaveLength(1));
    host.emit(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    host.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', ...(modern ? { params: modernParams() } : {}) }));
    await vi.waitFor(() => expect(host.lines).toHaveLength(2));
    expect(JSON.parse(host.lines[1]!).result.tools).toHaveLength(1);
  });

  it('keeps its error type available to host integrations', () => {
    const error = new McpReadOnlyServerError('query_cancelled', 'cancelled');
    expect(error).toMatchObject({ name: 'McpReadOnlyServerError', code: 'query_cancelled', rpcCode: -32002 });
  });
  it('stops and cancels active reads when an asynchronous response delivery fails', async () => {
    const host = transport(); let signal: AbortSignal | undefined;
    const failed = new Error('synthetic closed output');
    const server = new McpReadOnlyServer({ transport: { ...host, sendLine: async () => { throw failed; } },
      query: async (request) => { signal = request.signal; return new Promise(() => {}); } });
    server.start();
    host.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: modernParams({ name: MCP_READ_ONLY_TOOL_NAME, arguments: {} }) }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    host.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping', params: modernParams() }));
    await vi.waitFor(() => expect(server.started).toBe(false)); expect(signal?.aborted).toBe(true); server.stop();
  });
});
