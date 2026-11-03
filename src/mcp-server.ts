import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { loadRustQueryBridge, createMcpRustQueryHandler } from '@extension/rust-query-bridge';
import { McpReadOnlyServer, MCP_READ_ONLY_MAX_LINE_BYTES, type McpLineTransport } from '@extension/mcp-read-only-server';
import { parseMcpServerLimits, type McpServerLimits } from '@extension/mcp-server-config';

const sourceId = process.env.JSONLVIEW_MCP_SOURCE_ID;
const sourcePath = process.env.JSONLVIEW_MCP_SOURCE_PATH;
if (sourceId === undefined || sourceId.length === 0 || sourcePath === undefined || sourcePath.length === 0) {
  process.stderr.write('JsonlView MCP server requires JSONLVIEW_MCP_SOURCE_ID and JSONLVIEW_MCP_SOURCE_PATH.\n');
  process.exitCode = 2;
} else {
  let limits: McpServerLimits | undefined;
  try {
    limits = parseMcpServerLimits(process.env);
  } catch (error) {
    process.stderr.write(`JsonlView MCP server configuration is invalid: ${error instanceof Error ? error.message : 'invalid limits'}\n`);
    process.exitCode = 2;
  }
  if (limits !== undefined) {
    const extensionRoot = process.env.JSONLVIEW_EXTENSION_PATH ?? resolve(dirname(process.argv[1] ?? process.cwd()), '..');
    const bridge = loadRustQueryBridge(extensionRoot, [resolve(sourcePath, '..')]);
    const transport: McpLineTransport = {
      sendLine: (line) => { process.stdout.write(line + '\n'); },
      onLine: (listener) => {
        let buffer = '';
        const onData = (chunk: Buffer | string): void => {
          buffer += String(chunk);
          const lines = buffer.split(/\r?\n/gu);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.length > 0) listener(line);
          }
          if (Buffer.byteLength(buffer, 'utf8') > MCP_READ_ONLY_MAX_LINE_BYTES) {
            listener(buffer);
            buffer = '';
          }
        };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        return () => process.stdin.off('data', onData);
      },
    };
    const server = new McpReadOnlyServer({
      transport,
      allowedSourceIds: [sourceId],
      cancellationMode: 'cooperative',
      budgetMs: limits.budgetMs,
      maxConcurrency: limits.maxConcurrency,
      maxQueuedRequests: 8,
      query: createMcpRustQueryHandler(bridge, new Map([[sourceId, sourcePath]]), { preferPortable: true }),
    });
    server.start();
  }
}
