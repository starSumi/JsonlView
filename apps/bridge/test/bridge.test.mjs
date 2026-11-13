import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createBridgeServer } from '../dist/index.js';

const servers = new Set();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

async function startServer({ command = process.execPath, args = ['-e', 'process.stdin.pipe(process.stdout)'] } = {}) {
  const server = createBridgeServer({ token: 'test-token', command, args });
  servers.add(server);
  await server.listen();
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('the /mcp route never returns an accepted-looking JSON-RPC success', async () => {
  const { baseUrl } = await startServer();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Not found' });
});

test('the private tunnel has no HTTP MCP or ACP endpoint', async () => {
  const { baseUrl } = await startServer();
  const response = await fetch(`${baseUrl}/rpc-tunnel`);
  assert.equal(response.status, 404);
});

test('the private tunnel rejects missing credentials and a forged Host before process launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsonlview-bridge-auth-'));
  const markerPath = join(directory, 'spawned');
  try {
    const source = `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned');process.stdin.pipe(process.stdout);`;
    const { baseUrl } = await startServer({ args: ['-e', source] });
    for (const headers of [{}, { authorization: 'Bearer test-token', host: 'attacker.example' }]) {
      const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/rpc-tunnel', { headers });
      await new Promise((resolve, reject) => {
        socket.once('error', resolve);
        socket.once('open', () => reject(new Error('unauthorized tunnel connection opened')));
      });
      assert.notEqual(socket.readyState, WebSocket.OPEN);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the authenticated private tunnel forwards JSON-RPC responses as well as requests', async () => {
  const { baseUrl } = await startServer();
  const url = baseUrl.replace('http:', 'ws:') + '/rpc-tunnel';
  const socket = new WebSocket(url, { headers: { authorization: 'Bearer test-token' } });
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const reply = new Promise((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      socket.once('error', reject);
    });
    const response = { jsonrpc: '2.0', id: 42, result: { outcome: 'accepted' } };
    socket.send(JSON.stringify(response));
    assert.deepEqual(await reply, response);
  } finally {
    socket.close();
    if (socket.readyState !== WebSocket.CLOSED) await new Promise((resolve) => socket.once('close', resolve));
  }
});
