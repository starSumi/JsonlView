import { describe, expect, it, vi } from 'vitest';
import {
  MCP_READ_ONLY_PROTOCOL_VERSIONS,
  MCP_READ_ONLY_TOOL_NAME,
  McpReadOnlyServer,
  McpReadOnlyServerError,
  type McpLineTransport,
} from '../../src/extension/mcp-read-only-server';

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

  it('returns standard errors for protocol, method, and argument failures', async () => {
    const host = transport();
    const server = new McpReadOnlyServer({ transport: host, query: vi.fn(async () => null) });
    server.start();
    const beforeInit = await request(server, 1, 'tools/list');
    expect(beforeInit.error).toMatchObject({ code: -32002, data: { code: 'not_initialized' } });
    const unsupported = await request(server, 2, 'initialize', { protocolVersion: '2024-10-01' });
    expect(unsupported.error).toMatchObject({ code: -32602, data: { code: 'unsupported_protocol_version' } });
    const initialized = await request(server, 3, 'initialize', { protocolVersion: '2025-11-25' });
    expect(initialized.result).toMatchObject({ protocolVersion: '2025-11-25' });
    const unknownMethod = await request(server, 4, 'unknown/method');
    expect(unknownMethod.error).toMatchObject({ code: -32601, data: { code: 'method_not_found' } });
    const unknownTool = await request(server, 5, 'tools/call', { name: 'jsonlview_write_file', arguments: {} });
    expect(unknownTool.error).toMatchObject({ code: -32601, data: { code: 'unknown_tool' } });
    const invalid = await request(server, 6, 'tools/call', { name: MCP_READ_ONLY_TOOL_NAME, arguments: { limit: 0 } });
    expect(invalid.error).toMatchObject({ code: -32602, data: { code: 'invalid_params' } });
  });

  it('enforces query timeout and response byte budgets', async () => {
    const host = transport();
    const server = new McpReadOnlyServer({
      transport: host,
      requestTimeoutMs: 5,
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
