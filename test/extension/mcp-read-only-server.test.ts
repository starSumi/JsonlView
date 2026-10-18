import { describe, expect, it, vi } from 'vitest';
import {
  MCP_READ_ONLY_PROTOCOL_VERSIONS,
  MCP_READ_ONLY_TOOL_NAME,
  McpReadOnlyServer,
  McpReadOnlyServerError,
  type McpLineTransport,
} from '../../src/extension/mcp-read-only-server';
import { createMcpRustQueryHandler, RustQueryBridge, RUST_QUERY_SCHEMA } from '../../src/extension/rust-query-bridge';

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
  });

  it('negotiates all supported protocol revisions and exposes only read-only tools', async () => {
    expect(MCP_READ_ONLY_PROTOCOL_VERSIONS).toEqual(['2026-07-28', '2025-11-25', '2025-06-18']);
    for (const [index, protocolVersion] of MCP_READ_ONLY_PROTOCOL_VERSIONS.entries()) {
      const host = transport();
      const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => ({ records: [] })) });
      server.start();
      const initialized = await request(server, index + 1, 'initialize', { protocolVersion });
      expect(initialized.result).toMatchObject({ protocolVersion, capabilities: { tools: {} } });
      const listed = await request(server, index + 10, 'tools/list');
      expect(listed.result).toMatchObject({ tools: [{ name: MCP_READ_ONLY_TOOL_NAME, annotations: { readOnlyHint: true, destructiveHint: false } }] });
    }
  });

  it('falls back to the newest server-supported version for unknown and future client versions', async () => {
    for (const protocolVersion of ['2024-10-01', '2099-01-01']) {
      const server = new McpReadOnlyServer({ transport: transport(), query: vi.fn(async () => null) });
      server.start();
      const initialized = await request(server, 1, 'initialize', { protocolVersion });
      expect(initialized.result).toMatchObject({ protocolVersion: '2026-07-28' });
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

  it('validates the read-only boundary before invoking the query function', async () => {
    const host = transport();
    const query = vi.fn(async () => ({ rows: [{ ordinal: 0 }] }));
    const server = new McpReadOnlyServer({ transport: host, query, allowedSourceIds: ['local'] });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2026-07-28' });
    const accepted = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { sourceId: 'local', limit: 2 } });
    expect(accepted.result).toMatchObject({ structuredContent: { rows: [{ ordinal: 0 }] } });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ toolName: MCP_READ_ONLY_TOOL_NAME, protocolVersion: '2026-07-28', arguments: { sourceId: 'local', limit: 2 }, signal: expect.any(AbortSignal) }));
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
    expect(beforeInit.error).toMatchObject({ code: -32002, data: { code: 'not_initialized' } });
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
    await request(server, 1, 'initialize', { protocolVersion: '2026-07-28' });
    const timeout = await request(server, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(timeout.error).toMatchObject({ data: { code: 'request_timeout' } });

    const oversized = new McpReadOnlyServer({ transport: transport(), maxResponseBytes: 256, query: vi.fn(async () => ({ text: 'x'.repeat(2_000) })) });
    oversized.start();
    await request(oversized, 1, 'initialize', { protocolVersion: '2026-07-28' });
    const result = await request(oversized, 2, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} });
    expect(result.error).toMatchObject({ data: { code: 'response_too_large' } });
  });

  it('cancels a pending tools/call through notifications/cancelled', async () => {
    const host = transport();
    const query = vi.fn(async ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const server = new McpReadOnlyServer({ transport: host, query, cancellationMode: 'cooperative' });
    server.start();
    await request(server, 1, 'initialize', { protocolVersion: '2026-07-28' });
    const pending = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: MCP_READ_ONLY_TOOL_NAME, arguments: {} } }));
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user' } }));
    expect(await pending).toBeUndefined();
  });

  it('reports oversized records explicitly through the Rust-to-MCP production adapter', async () => {
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
    expect(response.error).toMatchObject({ message: 'jsonl-query:record-exceeds-max-bytes' });
  });

  it('marks the synchronous Rust adapter non-cancellable and does not report a false timeout', async () => {
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2,
      capabilities: () => 4,
      queryRecords: () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return JSON.stringify({
          schema: RUST_QUERY_SCHEMA,
          snapshot: { sizeBytes: '3', modifiedUnixMillis: '1' },
          records: [{ ordinal: '0', startByte: '0', endByte: '3', raw: 'row' }],
          nextOrdinal: null,
          truncated: false,
          truncationReason: null,
        });
      },
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
    expect(response.result).toMatchObject({ structuredContent: { records: [{ raw: 'row' }] } });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ cancellationSupported: false, signal: expect.any(AbortSignal) }));
  });

  it('writes responses through the injected line transport and ignores notifications', async () => {
    const host = transport();
    const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => ({ rows: [] })) });
    server.start();
    host.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } }));
    await vi.waitFor(() => expect(host.lines).toHaveLength(1));
    host.emit(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    host.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    await vi.waitFor(() => expect(host.lines).toHaveLength(2));
    expect(JSON.parse(host.lines[1]!).result.tools).toHaveLength(1);
  });

  it('keeps its error type available to host integrations', () => {
    const error = new McpReadOnlyServerError('query_cancelled', 'cancelled');
    expect(error).toMatchObject({ name: 'McpReadOnlyServerError', code: 'query_cancelled', rpcCode: -32002 });
  });
});
