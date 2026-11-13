import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as extensionCore from '../../../src/extension/mcp/read-only-server';
import * as packageCore from '../../../packages/mcp-server/src/mcp-read-only-server.js';
import * as extensionStdio from '../../../src/extension/mcp/stdio-transport';
import * as packageStdio from '../../../packages/mcp-server/src/mcp-stdio-transport.js';
import * as extensionConfig from '../../../src/extension/mcp/server-config';
import * as packageConfig from '../../../packages/mcp-server/src/mcp-server-config.js';
import * as extensionTrajectory from '../../../src/extension/mcp/trajectory-tools';
import * as packageTrajectory from '../../../packages/mcp-server/src/mcp-trajectory-tools.js';
import * as sharedTrajectory from '../../../src/shared/contracts/trajectory-slice';
import * as packageTrajectoryContract from '../../../packages/mcp-server/src/contracts/trajectory-slice.js';
import * as extensionSpine from '../../../src/extension/trajectory/spine';
import * as packageSpine from '../../../packages/mcp-server/src/contracts/trajectory-spine.js';
import { createMcpServer } from '../../../packages/mcp-server/src/mcp-server-runtime.js';
import { createMcpRustQueryHandler, RustQueryBridge } from '../../../src/extension/rust-query-bridge';

function transport() {
  return {
    lines: [] as string[],
    sendLine(line: string) { this.lines.push(line); },
    onLine(_listener: (line: string) => void) { return () => {}; },
  };
}

async function exchange(server: InstanceType<typeof extensionCore.McpReadOnlyServer>) {
  server.start();
  const request = (id: number, method: string, params?: unknown) => server.handleLine(JSON.stringify({
    jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }),
  }));
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-11-25' });
  const listed = await request(2, 'tools/list');
  const called = await request(3, 'tools/call', {
    name: extensionCore.MCP_READ_ONLY_TOOL_NAME,
    arguments: { sourceId: 'synthetic-source', limit: 1 },
  });
  const trajectoryCall = await request(4, 'tools/call', {
    name: extensionTrajectory.MCP_TRAJECTORY_TOOL_NAME,
    arguments: { schema: sharedTrajectory.TRAJECTORY_REQUEST_SCHEMA, requestId: 'synthetic-request', sourceId: 'synthetic-source', predicate: { actor: 'user' }, limit: 1 },
  });
  const denied = await request(5, 'tools/call', {
    name: extensionCore.MCP_READ_ONLY_TOOL_NAME,
    arguments: { sourceId: 'unregistered-source', limit: 1 },
  });
  const pathDenied = await request(6, 'tools/call', {
    name: extensionCore.MCP_READ_ONLY_TOOL_NAME,
    arguments: { sourceId: 'synthetic-source', path: 'C:/must-not-be-accepted.jsonl' },
  });
  server.stop();
  return {
    initialized: JSON.parse(initialized!), listed: JSON.parse(listed!), called: JSON.parse(called!),
    trajectoryCall: JSON.parse(trajectoryCall!), denied: JSON.parse(denied!), pathDenied: JSON.parse(pathDenied!),
    stopped: server.started === false,
  };
}

describe('extension and standalone MCP share one protocol implementation', () => {
  it('routes extension facades to the package-owned server, transport, config, schemas, and serializers', () => {
    expect(extensionCore.MCP_READ_ONLY_PROTOCOL_VERSIONS).toEqual(packageCore.MCP_READ_ONLY_PROTOCOL_VERSIONS);
    expect(extensionCore.McpReadOnlyServer).toBe(packageCore.McpReadOnlyServer);
    expect(extensionStdio.createMcpStdioTransport).toBe(packageStdio.createMcpStdioTransport);
    expect(extensionConfig.parseMcpServerLimits).toBe(packageConfig.parseMcpServerLimits);
    expect(extensionTrajectory.MCP_TRAJECTORY_TOOL).toBe(packageTrajectory.MCP_TRAJECTORY_TOOL);
    expect(extensionTrajectory.MCP_TRAJECTORY_TOOL.inputSchema).toEqual(packageTrajectory.MCP_TRAJECTORY_TOOL.inputSchema);
    expect(extensionTrajectory.MCP_TRAJECTORY_SPINE_TEMPLATE).toBe(packageTrajectory.MCP_TRAJECTORY_SPINE_TEMPLATE);
    expect(extensionTrajectory.sourceIdFromSpineUri).toBe(packageTrajectory.sourceIdFromSpineUri);
    expect(sharedTrajectory.parseTrajectoryRequest).toBe(packageTrajectoryContract.parseTrajectoryRequest);
    expect(sharedTrajectory.serializeTrajectoryResult).toBe(packageTrajectoryContract.serializeTrajectoryResult);
    expect(extensionSpine.parseTrajectorySpineRequest).toBe(packageSpine.parseTrajectorySpineRequest);
    expect(extensionSpine.serializeTrajectorySpineResult).toBe(packageSpine.serializeTrajectorySpineResult);
    expect(extensionTrajectory.sourceIdFromSpineUri('jsonlview://source/a%2Fb/spine')).toBe('a/b');
    expect(extensionTrajectory.sourceIdFromSpineUri('jsonlview://source/a%2F%2Fb/spine')).toBe('a//b');
    expect(extensionTrajectory.sourceIdFromSpineUri('jsonlview://source/%ZZ/spine')).toBeUndefined();
  });

  it('returns identical initialize, tools/list, bounded tools/call, and stop results for both surfaces', async () => {
    const query = vi.fn(async (request: { toolName: string; arguments: Readonly<Record<string, unknown>> }) => ({
      structuredContent: {
        schema: request.toolName === extensionTrajectory.MCP_TRAJECTORY_TOOL_NAME ? sharedTrajectory.TRAJECTORY_RESULT_SCHEMA : 'jsonlview.raw-records.v1',
        sourceId: request.arguments.sourceId,
        records: [{ ordinal: '0', text: 'synthetic' }],
      },
      content: [{ type: 'text' as const, text: 'synthetic' }],
    }));
    const createServer = (Server: typeof extensionCore.McpReadOnlyServer) => new Server({
      transport: transport(), query, tools: [extensionCore.MCP_READ_ONLY_TOOL, extensionTrajectory.MCP_TRAJECTORY_TOOL],
      allowedSourceIds: ['synthetic-source'], cancellationMode: 'cooperative',
    });
    const extensionServer = createServer(extensionCore.McpReadOnlyServer);
    const packageServer = createServer(packageCore.McpReadOnlyServer);

    const extensionResult = await exchange(extensionServer);
    const packageResult = await exchange(packageServer);

    expect(extensionResult).toEqual(packageResult);
    expect(extensionResult.initialized.result.protocolVersion).toBe('2025-11-25');
    expect(extensionResult.listed.result.tools).toMatchObject([
      { name: 'jsonlview_query_records', annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: 'jsonlview_query_trajectory_slice', inputSchema: extensionTrajectory.MCP_TRAJECTORY_TOOL.inputSchema },
    ]);
    expect(extensionResult.called.result.structuredContent).toEqual({ schema: 'jsonlview.raw-records.v1', sourceId: 'synthetic-source', records: [{ ordinal: '0', text: 'synthetic' }] });
    expect(extensionResult.trajectoryCall.result.structuredContent).toEqual({
      schema: sharedTrajectory.TRAJECTORY_RESULT_SCHEMA, sourceId: 'synthetic-source', records: [{ ordinal: '0', text: 'synthetic' }],
    });
    expect(extensionResult.denied.error.data.code).toBe('invalid_params');
    expect(extensionResult.denied.error.message).toContain('sourceId is not allowlisted');
    expect(extensionResult.pathDenied.error.data.code).toBe('invalid_params');
    expect(extensionResult.pathDenied.error.message).toContain('path');
    expect(query).toHaveBeenCalledTimes(4);
    expect(extensionResult.stopped).toBe(true);
  });

  it('keeps the distinct source adapters conformant for bounded trajectory reads and rejected grants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonlview-mcp-cross-surface-'));
    const sourcePath = join(root, 'synthetic.jsonl');
    const input = new PassThrough();
    const output = new PassThrough();
    const sources = new Map([['synthetic-source', sourcePath]]);
    let packageServer: Awaited<ReturnType<typeof createMcpServer>> | undefined;
    let extensionServer: extensionCore.McpReadOnlyServer | undefined;
    try {
      await writeFile(sourcePath, ['first', 'middle', 'last'].map((text, index) => JSON.stringify({
        type: index === 1 ? 'assistant' : 'user', sessionId: 'synthetic-session', uuid: `synthetic-${index}`,
        message: { role: index === 1 ? 'assistant' : 'user', content: text },
      })).join('\n'));
      packageServer = await createMcpServer({ sources: [{ sourceId: 'synthetic-source', sourcePath }], input, output });
      extensionServer = new extensionCore.McpReadOnlyServer({
        ...extensionTrajectory.createMcpTrajectoryHandlers({
          sources, allowedRoots: [root],
          legacyQuery: createMcpRustQueryHandler(new RustQueryBridge({ allowedRoots: [root] }), sources, { preferPortable: true }),
        }),
        transport: transport(), allowedSourceIds: ['synthetic-source'], cancellationMode: 'cooperative',
      });
      const request = async (server: extensionCore.McpReadOnlyServer, id: number, method: string, params: unknown) => {
        const response = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        if (response === undefined) throw new Error('Expected synthetic response');
        return JSON.parse(response) as Record<string, unknown>;
      };
      const responses: unknown[][] = [];
      for (const server of [extensionServer, packageServer]) {
        server.start();
        responses.push([
          await request(server, 1, 'initialize', { protocolVersion: '2025-11-25' }),
          await request(server, 2, 'tools/list', {}),
          await request(server, 3, 'tools/call', {
            name: packageTrajectory.MCP_TRAJECTORY_TOOL_NAME,
            arguments: { schema: sharedTrajectory.TRAJECTORY_REQUEST_SCHEMA, requestId: 'synthetic-read', sourceId: 'synthetic-source', predicate: { actor: 'user' }, limit: 1 },
          }),
          await request(server, 4, 'tools/call', {
            name: packageTrajectory.MCP_TRAJECTORY_TOOL_NAME,
            arguments: { schema: sharedTrajectory.TRAJECTORY_REQUEST_SCHEMA, requestId: 'synthetic-denied', sourceId: 'not-registered', predicate: { actor: 'user' } },
          }),
          await request(server, 5, 'tools/call', {
            name: packageTrajectory.MCP_TRAJECTORY_TOOL_NAME,
            arguments: { schema: sharedTrajectory.TRAJECTORY_REQUEST_SCHEMA, requestId: 'synthetic-path', sourceId: 'synthetic-source', predicate: { actor: 'user' }, sourcePath },
          }),
        ]);
        server.stop();
        expect(server.started).toBe(false);
      }
      const extensionResponses = responses[0];
      const packageResponses = responses[1];
      if (extensionResponses === undefined || packageResponses === undefined) throw new Error('Expected paired MCP exchanges');
      expect(extensionResponses.slice(0, 2)).toEqual(packageResponses.slice(0, 2));
      const extensionSlice = (extensionResponses[2] as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      const packageSlice = (packageResponses[2] as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
      const stableFields = ['schema', 'requestId', 'status', 'sourceId', 'profile', 'snapshot', 'records', 'usage', 'reason'] as const;
      expect(Object.fromEntries(stableFields.map((key) => [key, extensionSlice[key]]))).toEqual(
        Object.fromEntries(stableFields.map((key) => [key, packageSlice[key]])));
      expect(extensionSlice).toMatchObject({ records: [{ ordinal: '0', text: 'first' }], status: 'partial' });
      expect(extensionSlice.cursor).toEqual(expect.any(String));
      expect(packageSlice.cursor).toEqual(expect.any(String));
      expect(extensionResponses[3]).toEqual(packageResponses[3]);
      expect(extensionResponses[3]).toMatchObject({ error: { code: -32602, data: { code: 'invalid_params' } } });
      expect(extensionResponses[4]).toEqual(packageResponses[4]);
      expect(extensionResponses[4]).toMatchObject({ error: { code: -32602, data: { code: 'invalid_params' } } });
    } finally {
      extensionServer?.stop(); packageServer?.stop(); input.destroy(); output.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
});
