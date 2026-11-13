import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createMcpServer } from '../dist/index.js';

const root = resolve(import.meta.dirname, '..');
const executable = resolve(root, 'dist/cli.js');
const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('package manifest exposes the built CLI without exporting its side-effect entrypoint', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { 'jsonlview-mcp': './dist/cli.js' });
  assert.ok(manifest.files.includes('dist'));
  const cliSource = await readFile(executable, 'utf8');
  assert.match(cliSource, /^#!\/usr\/bin\/env node/u);
  assert.equal(manifest.exports['./cli'], undefined);
  // The package root's static library import above must not evaluate cli.js/main().
});

async function sourceFile(contents = '{"actor":"user","content":"sample"}\n') {
  const directory = await mkdtemp(join(tmpdir(), 'jsonlview-mcp-cli-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'events.jsonl');
  await writeFile(path, contents, 'utf8');
  return path;
}

function launch(args) {
  return spawn(process.execPath, [executable, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function lineReader(stream) {
  let buffer = '';
  const pending = [];
  const waiters = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const value = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else pending.push(value);
    }
  });
  return () => pending.length > 0 ? Promise.resolve(pending.shift()) : new Promise((resolveLine) => waiters.push(resolveLine));
}

async function request(child, readLine, id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  return JSON.parse(await readLine());
}

function modern(params = {}) {
  return { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } };
}

test('CLI rejects malformed registration before writing protocol data and keeps paths out of diagnostics', async () => {
  const malformed = launch(['--source', 'not-an-absolute-path']);
  const stdout = [];
  const stderr = [];
  malformed.stdout.on('data', (chunk) => stdout.push(chunk));
  malformed.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code] = await once(malformed, 'close');
  assert.equal(code, 2);
  assert.equal(Buffer.concat(stdout).length, 0);
  assert.match(Buffer.concat(stderr).toString('utf8'), /configuration is invalid/u);

  const privatePath = join(tmpdir(), 'does-not-exist-jsonlview-private.jsonl');
  const missingFile = launch(['--source', `private=${privatePath}`]);
  const missingOut = [];
  const missingErr = [];
  missingFile.stdout.on('data', (chunk) => missingOut.push(chunk));
  missingFile.stderr.on('data', (chunk) => missingErr.push(chunk));
  const [missingCode] = await once(missingFile, 'close');
  assert.equal(missingCode, 2);
  assert.equal(Buffer.concat(missingOut).length, 0);
  assert.doesNotMatch(Buffer.concat(missingErr).toString('utf8'), /does-not-exist-jsonlview-private/u);
});

test('built executable serves modern protocol, enforces source IDs, and exposes no source path', async () => {
  const path = await sourceFile();
  const child = launch(['--source', `local=${path}`, '--budget-ms', '5000', '--max-concurrency', '1']);
  const readLine = lineReader(child.stdout);
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    const discovery = await request(child, readLine, 1, 'server/discover', modern());
    assert.equal(discovery.result?.ttlMs, 0);
    const listed = await request(child, readLine, 2, 'tools/list', modern());
    assert.deepEqual(listed.result?.tools?.map((tool) => tool.name), ['jsonlview_query_records', 'jsonlview_query_trajectory_slice']);
    const records = await request(child, readLine, 3, 'tools/call', modern({ name: 'jsonlview_query_records', arguments: { sourceId: 'local', limit: 10 } }));
    assert.equal(records.error, undefined);
    assert.match(JSON.stringify(records.result), /sample/u);
    assert.ok(!JSON.stringify({ discovery, listed, records }).includes(path));

    const denied = await request(child, readLine, 4, 'tools/call', modern({ name: 'jsonlview_query_records', arguments: { sourceId: 'unknown' } }));
    assert.ok(denied.error);
    const pathAttempt = await request(child, readLine, 5, 'tools/call', modern({ name: 'jsonlview_query_records', arguments: { sourceId: 'local', sourcePath: path } }));
    assert.ok(pathAttempt.error);
    assert.ok(!JSON.stringify({ denied, pathAttempt }).includes(path));
  } finally {
    child.stdin.end();
    await once(child, 'close');
  }
  assert.equal(Buffer.concat(stderr).length, 0);
});

test('built executable retains legacy initialize/tools compatibility and stops on EOF', async () => {
  const path = await sourceFile();
  const child = launch(['--source', `legacy=${path}`]);
  const readLine = lineReader(child.stdout);
  try {
    const initialized = await request(child, readLine, 1, 'initialize', { protocolVersion: '2025-11-25' });
    assert.equal(initialized.result?.protocolVersion, '2025-11-25');
    const listed = await request(child, readLine, 2, 'tools/list');
    assert.deepEqual(listed.result?.tools?.map((tool) => tool.name), ['jsonlview_query_records', 'jsonlview_query_trajectory_slice']);
    const records = await request(child, readLine, 3, 'tools/call', { name: 'jsonlview_query_records', arguments: { sourceId: 'legacy', limit: 1 } });
    assert.equal(records.error, undefined);
    assert.match(JSON.stringify(records.result), /sample/u);
  } finally {
    child.stdin.end();
    await once(child, 'close');
  }
});

test('built executable accepts the older legacy protocol version', async () => {
  const path = await sourceFile();
  const child = launch(['--source', `legacy=${path}`]);
  const readLine = lineReader(child.stdout);
  try {
    const initialized = await request(child, readLine, 1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(initialized.result?.protocolVersion, '2025-06-18');
    const listed = await request(child, readLine, 2, 'tools/list');
    assert.deepEqual(listed.result?.tools?.map((tool) => tool.name), ['jsonlview_query_records', 'jsonlview_query_trajectory_slice']);
  } finally {
    child.stdin.end();
    await once(child, 'close');
  }
});

test('package root exports the standalone library runtime and validates explicit source grants', async () => {
  const path = await sourceFile();
  const input = new PassThrough();
  const output = new PassThrough();
  const server = await createMcpServer({ sources: [{ sourceId: 'library', sourcePath: path }], input, output });
  server.start();
  assert.equal(server.started, true);
  server.stop();
  assert.equal(server.started, false);
  input.destroy();
  output.destroy();
  await assert.rejects(createMcpServer({ sources: [{ sourceId: '../path', sourcePath: path }], input: new PassThrough(), output: new PassThrough() }), /valid source ID/u);
});

test('library rejects a closed stdio stream before attaching a dead server', async () => {
  const path = await sourceFile();
  const input = new PassThrough();
  input.destroy();
  await assert.rejects(createMcpServer({ sources: [{ sourceId: 'closed', sourcePath: path }], input, output: new PassThrough() }), /stdio streams must be open/u);
});

test('built executable cooperatively cancels requests and continues serving after cancellation', async () => {
  const path = await sourceFile(Array.from({ length: 200 }, (_, index) => JSON.stringify({ actor: 'user', content: `row-${index}` })).join('\n') + '\n');
  const child = launch(['--source', `local=${path}`]);
  const readLine = lineReader(child.stdout);
  try {
    await request(child, readLine, 1, 'server/discover', modern());
    child.stdin.write([
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: modern({ name: 'jsonlview_query_records', arguments: { sourceId: 'local', limit: 200 } }) }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }),
    ].join('\n') + '\n');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const ping = await request(child, readLine, 3, 'ping', modern());
    assert.equal(ping.result?.resultType, 'complete');
  } finally {
    child.stdin.end();
    await once(child, 'close');
  }
});

test('SIGTERM stops the server and closes the standalone CLI process', async () => {
  const path = await sourceFile();
  const child = launch(['--source', `local=${path}`]);
  try {
    await new Promise((resolveReady) => setTimeout(resolveReady, 30));
    child.kill('SIGTERM');
    const [code] = await once(child, 'close');
    assert.ok(code === 143 || code === null, `unexpected signal exit status: ${String(code)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
