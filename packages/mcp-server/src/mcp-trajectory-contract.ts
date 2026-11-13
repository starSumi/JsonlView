import { TRAJECTORY_REQUEST_SCHEMA } from './contracts/trajectory-slice.js';
import { MCP_READ_ONLY_TOOL, type McpReadOnlyToolDefinition } from './mcp-read-only-server.js';

export const MCP_TRAJECTORY_TOOL_NAME = 'jsonlview_query_trajectory_slice' as const;
export const MCP_TRAJECTORY_SPINE_TEMPLATE = Object.freeze({
  uriTemplate: 'jsonlview://source/{sourceId}/spine',
  name: 'jsonlview_trajectory_spine',
  description: 'Bounded initial trajectory spine for an authorized opaque source ID, with profile, observed-metadata snapshot and omission counts. Encode sourceId as one URI segment.',
  mimeType: 'application/json',
});

export const MCP_TRAJECTORY_TOOL: McpReadOnlyToolDefinition = Object.freeze<McpReadOnlyToolDefinition>({
  name: MCP_TRAJECTORY_TOOL_NAME,
  description: 'Read a bounded semantic trajectory slice from an explicitly authorized source. Supply actor and/or hasError; preserve partial cursors for continuation. The effective arrival-to-finish deadline is min(deadlineMs, server budget), including queue wait. Stdio server budget defaults to 3000ms; JSONLVIEW_MCP_BUDGET_MS raises that cap. Errors use the versioned structured result and matching JSON text.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    required: ['schema', 'requestId', 'sourceId', 'predicate'],
    properties: {
      schema: { type: 'string', const: TRAJECTORY_REQUEST_SCHEMA },
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
      sourceId: { type: 'string', minLength: 1, maxLength: 256 },
      predicate: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        actor: { type: 'string', enum: ['user', 'assistant', 'tool', 'system'] }, hasError: { type: 'boolean' },
      } },
      limit: { type: 'integer', minimum: 1, maximum: 128, default: 50 },
      maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 1_048_576, default: 262_144 },
      maxExaminedBytes: { type: 'integer', minimum: 1024, maximum: 67_108_864, default: 8_388_608 },
      deadlineMs: { type: 'integer', minimum: 100, maximum: 30_000, default: 5000 },
      cursor: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[A-Za-z0-9_-]+$' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
});

/** URI parsing never normalizes filesystem syntax and performs exactly one percent decode. */
export function sourceIdFromSpineUri(uri: string): string | undefined {
  const match = /^jsonlview:\/\/source\/((?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+)\/spine$/u.exec(uri);
  if (match === null) return undefined;
  try {
    const sourceId = decodeURIComponent(match[1]!);
    return sourceId.length >= 1 && sourceId.length <= 256 ? sourceId : undefined;
  } catch { return undefined; }
}

export { MCP_READ_ONLY_TOOL };
