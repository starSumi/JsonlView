import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createMcpRustQueryHandler, RustQueryBridge } from './rust-query-bridge.js';
import { createMcpStdioTransport } from './mcp-stdio-transport.js';
import { McpReadOnlyServer } from './mcp-read-only-server.js';
import { createMcpTrajectoryHandlers } from './mcp-trajectory-tools.js';
import type { McpServerLimits } from './mcp-server-config.js';

export interface McpServerSource {
  readonly sourceId: string;
  readonly sourcePath: string;
}

export interface CreateMcpServerOptions {
  readonly sources: readonly McpServerSource[];
  readonly input: Readable;
  readonly output: Writable;
  readonly limits?: Partial<McpServerLimits>;
}

export const DEFAULT_MCP_SERVER_LIMITS: McpServerLimits = Object.freeze({ budgetMs: 3_000, maxConcurrency: 2 });

/** Build the standalone package's portable stdio runtime from explicit process-launch grants. */
export async function createMcpServer(options: CreateMcpServerOptions): Promise<McpReadOnlyServer> {
  const limits = normalizeLimits(options.limits);
  const sources = await canonicalizeSources(options.sources);
  if (options.input.destroyed || options.input.readableEnded || options.output.destroyed || options.output.writableEnded) {
    throw new TypeError('MCP stdio streams must be open.');
  }
  const paths = new Map(sources.map(({ sourceId, sourcePath }) => [sourceId, sourcePath]));
  const roots = [...new Set(sources.map(({ sourcePath }) => dirname(sourcePath)))];
  const bridge = new RustQueryBridge({ allowedRoots: roots });
  let server: McpReadOnlyServer | undefined;
  const transport = createMcpStdioTransport(options.input, options.output, () => server?.stop());
  const handlers = createMcpTrajectoryHandlers({
    sources: paths,
    allowedRoots: roots,
    legacyQuery: createMcpRustQueryHandler(bridge, paths, { preferPortable: true }),
  });
  server = new McpReadOnlyServer({
    ...handlers,
    transport,
    allowedSourceIds: [...paths.keys()],
    cancellationMode: 'cooperative',
    budgetMs: limits.budgetMs,
    maxConcurrency: limits.maxConcurrency,
    maxQueuedRequests: 8,
  });
  return server;
}

async function canonicalizeSources(sources: readonly McpServerSource[]): Promise<McpServerSource[]> {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 64) {
    throw new TypeError('At least one and no more than 64 sources must be explicitly registered.');
  }
  const seen = new Set<string>();
  const result: McpServerSource[] = [];
  for (const source of sources) {
    if (!isRecord(source) || !isSourceId(source.sourceId) || typeof source.sourcePath !== 'string'
      || source.sourcePath.length === 0 || !isAbsolute(source.sourcePath)) {
      throw new TypeError('Each source requires a valid source ID and absolute file path.');
    }
    if (seen.has(source.sourceId)) throw new TypeError('Source IDs must be unique.');
    seen.add(source.sourceId);
    const canonicalPath = await realpath(source.sourcePath);
    const details = await stat(canonicalPath);
    if (!details.isFile()) throw new TypeError('Each registered source must resolve to a regular file.');
    result.push({ sourceId: source.sourceId, sourcePath: canonicalPath });
  }
  return result;
}

function normalizeLimits(limits: CreateMcpServerOptions['limits']): McpServerLimits {
  const budgetMs = limits?.budgetMs ?? DEFAULT_MCP_SERVER_LIMITS.budgetMs;
  const maxConcurrency = limits?.maxConcurrency ?? DEFAULT_MCP_SERVER_LIMITS.maxConcurrency;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000) {
    throw new TypeError('budgetMs must be an integer from 1 through 60000.');
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
    throw new TypeError('maxConcurrency must be an integer from 1 through 8.');
  }
  return { budgetMs, maxConcurrency };
}

export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
