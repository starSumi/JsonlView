import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { loadRustQueryBridge, createMcpRustQueryHandler } from '@extension/rust-query-bridge';
import { McpReadOnlyServer } from '@extension/mcp/read-only-server';
import { createMcpStdioTransport } from '@extension/mcp/stdio-transport';
import { parseMcpServerLimits, type McpServerLimits } from '@extension/mcp/server-config';
import { createMcpTrajectoryHandlers } from '@extension/mcp/trajectory-tools';

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
    const sources = new Map([[sourceId, sourcePath]]);
    const transport = createMcpStdioTransport(process.stdin, process.stdout, () => server.stop());
    const server = new McpReadOnlyServer({
      transport,
      cancellationMode: 'cooperative',
      budgetMs: limits.budgetMs,
      maxConcurrency: limits.maxConcurrency,
      maxQueuedRequests: 8,
      ...createMcpTrajectoryHandlers({ sources, allowedRoots: [resolve(sourcePath, '..')],
        legacyQuery: createMcpRustQueryHandler(bridge, sources, { preferPortable: true }) }),
    });
    server.start();
  }
}
