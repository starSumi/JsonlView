import { parseTrajectoryRequest, serializeTrajectoryResult, trajectoryError } from './contracts/trajectory-slice.js';
import { MCP_READ_ONLY_TOOL, MCP_READ_ONLY_TOOL_NAME, McpReadOnlyServerError,
  type McpReadOnlyQuery, type McpReadOnlyServerOptions } from './mcp-read-only-server.js';
import { MCP_TRAJECTORY_TOOL, MCP_TRAJECTORY_TOOL_NAME, MCP_TRAJECTORY_SPINE_TEMPLATE, sourceIdFromSpineUri } from './mcp-trajectory-contract.js';
import { TrajectorySliceQuery, type TrajectoryQueryOptions } from './trajectory-slice-query.js';
import { parseTrajectorySpineRequest, queryTrajectorySpine, serializeTrajectorySpineResult,
  TRAJECTORY_SPINE_REQUEST_SCHEMA, TRAJECTORY_SPINE_RESULT_SCHEMA, type TrajectorySpineResult } from './trajectory-spine.js';

export { MCP_TRAJECTORY_TOOL, MCP_TRAJECTORY_TOOL_NAME, MCP_TRAJECTORY_SPINE_TEMPLATE, sourceIdFromSpineUri };

type TrajectoryHandlers = Pick<McpReadOnlyServerOptions, 'tools' | 'query' | 'resourceTemplates' | 'readResource' | 'toolBudgetMs'>;

/** Production routing shares the same scanner/locator for slice and spine, never a second source authority. */
export function createMcpTrajectoryHandlers(options: TrajectoryQueryOptions & { readonly legacyQuery: McpReadOnlyQuery }): TrajectoryHandlers {
  const sources = new Map(options.sources);
  const query = new TrajectorySliceQuery({ ...options, sources });
  let resourceSequence = 0;
  return {
    tools: [MCP_READ_ONLY_TOOL, MCP_TRAJECTORY_TOOL],
    resourceTemplates: [MCP_TRAJECTORY_SPINE_TEMPLATE],
    toolBudgetMs: (name, args) => name === MCP_TRAJECTORY_TOOL_NAME ? parseTrajectoryRequest(args)?.deadlineMs : undefined,
    query: async (request) => {
      if (request.toolName === MCP_READ_ONLY_TOOL_NAME) return options.legacyQuery(request);
      if (request.toolName !== MCP_TRAJECTORY_TOOL_NAME) throw new McpReadOnlyServerError('unknown_tool', 'Unsupported MCP tool.');
      const normalized = parseTrajectoryRequest(request.arguments);
      const requestId = typeof request.arguments.requestId === 'string' ? request.arguments.requestId : 'invalid-request';
      try {
        const result = normalized === undefined ? trajectoryError(requestId, 'INVALID_ARGUMENT') : await query.query(normalized, request.signal);
        const text = serializeTrajectoryResult(result);
        // Both MCP representations derive from the sole contract serializer.
        return { structuredContent: JSON.parse(text) as unknown, content: [{ type: 'text', text }], ...(result.status === 'error' ? { isError: true } : {}) };
      } catch {
        const text = serializeTrajectoryResult(trajectoryError(requestId, 'INTERNAL'));
        return { structuredContent: JSON.parse(text) as unknown, content: [{ type: 'text', text }], isError: true };
      }
    },
    readResource: async (request) => {
      const sourceId = sourceIdFromSpineUri(request.uri);
      if (sourceId === undefined || !sources.has(sourceId)) throw new McpReadOnlyServerError('invalid_params', 'Resource is not authorized.');
      const requestId = `mcp-spine-${++resourceSequence}`;
      const normalized = parseTrajectorySpineRequest({ schema: TRAJECTORY_SPINE_REQUEST_SCHEMA, requestId, sourceId });
      if (normalized === undefined) throw new McpReadOnlyServerError('invalid_params', 'Resource is not authorized.');
      let result: TrajectorySpineResult;
      try { result = await queryTrajectorySpine(query, normalized, request.signal); }
      catch { result = { schema: TRAJECTORY_SPINE_RESULT_SCHEMA, requestId, status: 'error', error: { code: 'INTERNAL', recoverable: false } }; }
      return { contents: [{ uri: request.uri, mimeType: 'application/json', text: serializeTrajectorySpineResult(result) }] };
    },
  };
}


