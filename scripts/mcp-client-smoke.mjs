import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const serverPath = resolve(repositoryRoot, 'dist', 'mcp-server.cjs');
const tempRoot = await mkdtemp(join(tmpdir(), 'jsonlview-mcp-sdk-'));
const sourcePath = join(tempRoot, 'source.jsonl');
await writeFile(sourcePath, `${JSON.stringify({ message: 'jsonlview-mcp-sdk-smoke' })}\n`, 'utf8');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: repositoryRoot,
  env: {
    ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    JSONLVIEW_EXTENSION_PATH: repositoryRoot,
    JSONLVIEW_MCP_SOURCE_ID: 'smoke-source',
    JSONLVIEW_MCP_SOURCE_PATH: sourcePath,
  },
});
const client = new Client({ name: 'jsonlview-mcp-interop-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'jsonlview_query_records'));
  assert.ok(tools.some((tool) => tool.name === 'jsonlview_query_trajectory_slice'));

  const result = await client.callTool({
    name: 'jsonlview_query_records',
    arguments: { sourceId: 'smoke-source', startOrdinal: '0', limit: 1, maxBytes: 4096 },
  });
  assert.notEqual(result.isError, true);
  assert.ok(result.content.some((item) => item.type === 'text' && item.text.includes('jsonlview-mcp-sdk-smoke')));
  process.stdout.write('MCP SDK v1.32.2 initialize/tools/list/tools/call passed.\n');
} finally {
  await client.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
