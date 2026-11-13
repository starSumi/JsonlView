import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMcpStdioTransport } from '../../../src/extension/mcp/stdio-transport';
import { MCP_READ_ONLY_MAX_LINE_BYTES, McpReadOnlyServer } from '../../../src/extension/mcp/read-only-server';

describe('owned MCP stdio streams', () => {
  it('preserves split UTF-8 and CRLF, ignores empty lines and discards unterminated input on EOF', async () => {
    const input = new PassThrough(); const output = new PassThrough(); const closed = vi.fn(); const lines: string[] = [];
    const transport = createMcpStdioTransport(input, output, closed); const unsubscribe = transport.onLine((line) => lines.push(line));
    const bytes = Buffer.from('{"text":"中文🙂"}\r\n\n'); const split = bytes.indexOf(Buffer.from('中')) + 1;
    input.write(bytes.subarray(0, split)); expect(lines).toEqual([]); input.write(bytes.subarray(split));
    expect(lines).toEqual(['{"text":"中文🙂"}']); input.end('unterminated');
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce()); expect(lines).toHaveLength(1);
    unsubscribe(); input.destroy(); output.destroy();
  });
  it('does not interpret a suffix from an oversized line as another request', () => {
    const input = new PassThrough(); const output = new PassThrough(); const lines: string[] = [];
    const unsubscribe = createMcpStdioTransport(input, output, () => {}).onLine((line) => lines.push(line));
    input.write('x'.repeat(MCP_READ_ONLY_MAX_LINE_BYTES + 1));
    input.write('{"id":"fragment"}'); input.write('\n{"id":"next"}\n');
    expect(lines).toHaveLength(2); expect(Buffer.byteLength(lines[0]!)).toBeGreaterThan(MCP_READ_ONLY_MAX_LINE_BYTES);
    expect(lines[1]).toBe('{"id":"next"}'); unsubscribe(); input.destroy(); output.destroy();
  });
  it('waits for the output write callback and reports pipe failure without an unhandled error', async () => {
    const input = new PassThrough(); let finish!: (error?: Error | null) => void;
    const output = new Writable({ write(_chunk, _encoding, callback) { finish = callback; } }); const closed = vi.fn();
    const transport = createMcpStdioTransport(input, output, closed); let settled = false;
    const first = transport.sendLine('{}'); void Promise.resolve(first).then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); finish(); await first; expect(settled).toBe(true);
    const second = transport.sendLine('{}'); const rejected = expect(second).rejects.toThrow('pipe closed');
    finish(new Error('pipe closed')); await rejected; await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    input.destroy(); output.destroy();
  });
  it('aborts an active query and suppresses publication when the client closes stdin', async () => {
    const input = new PassThrough(); const output = new PassThrough(); let signal: AbortSignal | undefined;
    const transport = createMcpStdioTransport(input, output, () => server.stop());
    const server = new McpReadOnlyServer({ transport, query: async (request) => { signal = request.signal; return new Promise(() => {}); } });
    server.start(); input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'jsonlview_query_records', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } }) + '\n');
    await vi.waitFor(() => expect(signal).toBeDefined()); input.end();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true)); expect(server.started).toBe(false);
    expect(output.readableLength).toBe(0); input.destroy(); output.destroy();
  });
});
