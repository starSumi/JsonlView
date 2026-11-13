import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const input = createInterface({ input: process.stdin });

if (process.argv[2] === '--mcp') {
  const sourceId = Reflect.get(process.env, 'JSONLVIEW_MCP_SOURCE_ID');
  const sourcePath = Reflect.get(process.env, 'JSONLVIEW_MCP_SOURCE_PATH');
  input.on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
    else if (request.method === 'tools/list') result = { tools: [{
      name: 'jsonlview_query_records', inputSchema: {
        type: 'object', required: ['sourceId', 'limit'],
        properties: { sourceId: { type: 'string' }, limit: { type: 'integer' } },
      },
    }] };
    else if (request.method === 'tools/call' && request.params?.name === 'jsonlview_query_records') {
      const args = request.params.arguments;
      if (args?.sourceId !== sourceId || args?.limit !== 1 || Object.keys(args).some((key) => !['sourceId', 'limit'].includes(key))) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid synthetic query.' } })}\n`);
        return;
      }
      const row = JSON.parse(readFileSync(sourcePath, 'utf8').trim());
      const structuredContent = { sourceId, rows: [{ text: row.text }] };
      result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, observedArguments: args };
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  });
} else {
  let mcp;
  let mcpLines;
  let mcpId = 1;
  let pendingMcp;
  let sourcePath;
  let trace;

  function write(response) { process.stdout.write(`${JSON.stringify(response)}\n`); }

  function mcpRequest(method, params) {
    const id = mcpId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic MCP response timed out.')), 2_000);
      pendingMcp = { id, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject };
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  input.on('line', async (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.method === 'initialize') write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } });
    if (request.method === 'session/new') {
      try {
        const server = request.params?.mcpServers?.find((candidate) => candidate.name === 'jsonlview');
        if (server === undefined) throw new Error('JsonlView MCP grant missing.');
        const environment = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
        sourcePath = environment.JSONLVIEW_MCP_SOURCE_PATH;
        const fixture = process.argv[1];
        mcp = spawn(process.execPath, [fixture, '--mcp'], { env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'ignore'] });
        mcpLines = createInterface({ input: mcp.stdout });
        mcpLines.on('line', (output) => {
          try {
            const message = JSON.parse(output);
            if (pendingMcp?.id !== message.id) return;
            const pending = pendingMcp;
            pendingMcp = undefined;
            pending.resolve(message);
          } catch { /* Ignore non-protocol output from this bounded fixture. */ }
        });
        const initialized = await mcpRequest('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
        const listed = await mcpRequest('tools/list', {});
        const tool = listed.result.tools[0];
        const toolArguments = { sourceId: environment.JSONLVIEW_MCP_SOURCE_ID, limit: 1 };
        const called = await mcpRequest('tools/call', { name: tool.name, arguments: toolArguments });
        trace = {
          sourceId: environment.JSONLVIEW_MCP_SOURCE_ID,
          sourcePathProvided: typeof sourcePath === 'string' && sourcePath.length > 0,
          sourcePathReadable: typeof called.result?.structuredContent?.rows?.[0]?.text === 'string',
          initialized: initialized.error === undefined,
          toolName: tool.name,
          toolSchemaArgumentNames: Object.keys(tool.inputSchema.properties),
          toolArguments,
          mcpResult: called.result,
        };
        write({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'synthetic-data-classification-session' } });
      } catch {
        write({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Synthetic ACP-to-MCP trace failed.' } });
      }
    }
    if (request.method === 'session/prompt') {
      try {
        if (mcp !== undefined && mcp.exitCode === null) {
          const closed = once(mcp, 'close');
          mcp.stdin.end();
          await closed;
        }
        mcpLines?.close();
        const prompt = request.params?.prompt?.map((part) => part.text ?? '').join('\n') ?? '';
        const recordText = trace.mcpResult.structuredContent.rows[0].text;
        write({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'synthetic-data-classification-session', update: { sessionUpdate: 'agent_message_chunk', text: recordText },
        } });
        write({ jsonrpc: '2.0', id: request.id, result: {
          stopReason: 'end_turn', ...trace,
          promptContainsSourcePath: prompt.includes(sourcePath),
          promptContainsRecord: prompt.includes(recordText),
        } });
      } catch {
        write({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Synthetic ACP response failed.' } });
      }
    }
  });
}
