import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMcpRustQueryHandler, RUST_QUERY_SCHEMA, RustQueryAuthorizationError, RustQueryBridge, readPortableRustQuery } from '../../src/extension/rust-query-bridge';

const result = JSON.stringify({
  schema: RUST_QUERY_SCHEMA,
  snapshot: { sizeBytes: '42', modifiedUnixMillis: '1000' },
  records: [{ ordinal: '2', startByte: '8', endByte: '20', raw: '{"ok":true}' }],
  nextOrdinal: '3',
  truncated: true,
  truncationReason: 'page-limit',
});

describe('RustQueryBridge', () => {
  it('validates budgets and returns the bounded native page', () => {
    const calls: unknown[] = [];
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2,
      capabilities: () => 4,
      queryRecords: (...args) => { calls.push(args); return result; },
    } });
    expect(bridge.query({ sourcePath: 'C:/data/events.jsonl', startOrdinal: '2', limit: 1, maxBytes: 1024 })).toMatchObject({ nextOrdinal: '3', records: [{ ordinal: '2' }] });
    expect(calls).toHaveLength(1);
  });

  it('rejects paths outside the host authorization roots', () => {
    const bridge = new RustQueryBridge({ allowedRoots: ['C:/authorized'], binding: {
      abiVersion: () => 2, capabilities: () => 4, queryRecords: () => result,
    } });
    expect(() => bridge.query({ sourcePath: 'C:/other/events.jsonl' })).toThrow(RustQueryAuthorizationError);
  });

  it('rejects malformed native responses', () => {
    const bridge = new RustQueryBridge({ binding: {
      abiVersion: () => 2, capabilities: () => 4, queryRecords: () => '{}',
    } });
    expect(() => bridge.query({ sourcePath: 'C:/data/events.jsonl' })).toThrow(/invalid response schema/);
  });

  it('lets the cancellable stdio adapter prefer portable reads over synchronous native calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-mcp-portable-only-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, '{"origin":"portable"}\n', 'utf8');
    const nativeLine = '{"origin":"native"}';
    const nativeByteLength = Buffer.byteLength(nativeLine, 'utf8');
    const native = vi.fn(() => JSON.stringify({
      schema: RUST_QUERY_SCHEMA,
      snapshot: { sizeBytes: String(nativeByteLength), modifiedUnixMillis: '1000' },
      records: [{ ordinal: '0', startByte: '0', endByte: String(nativeByteLength), raw: nativeLine }],
      nextOrdinal: null,
      truncated: false,
    }));
    const bridge = new RustQueryBridge({ binding: { abiVersion: () => 2, capabilities: () => 4, queryRecords: native } });
    try {
      const query = createMcpRustQueryHandler(bridge, new Map([['local', file]]), { preferPortable: true });
      const result = await query({ arguments: { sourceId: 'local' }, signal: new AbortController().signal });
      expect(result.records).toMatchObject([{ raw: '{"origin":"portable"}' }]);
      expect(native).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves symlinks before checking the authorized root', () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-query-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'jsonlview-query-outside-'));
    const link = join(root, 'linked.jsonl');
    const target = join(outside, 'secret.jsonl');
    mkdirSync(root, { recursive: true });
    writeFileSync(target, '{}\n', 'utf8');
    try {
      symlinkSync(target, link, 'file');
      const bridge = new RustQueryBridge({ allowedRoots: [root], binding: {
        abiVersion: () => 2, capabilities: () => 4, queryRecords: () => result,
      } });
      expect(() => bridge.query({ sourcePath: link })).toThrow(RustQueryAuthorizationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a bounded portable raw page with LF/CRLF byte cursors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-portable-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, '{"a":1}\r\n{"a":2}\n', 'utf8');
    try {
      await expect(readPortableRustQuery({ sourcePath: file, startOrdinal: '0', limit: 1, maxBytes: 100 }, new AbortController().signal))
        .resolves.toMatchObject({
          records: [{ ordinal: '0', startByte: '0', endByte: '7', raw: '{"a":1}' }],
          nextOrdinal: '1', truncated: true, truncationReason: 'page-limit',
        });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid UTF-8 instead of rewriting source bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-invalid-utf8-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, Buffer.from([0xc3, 0x28, 0x0a]));
    try {
      await expect(readPortableRustQuery({ sourcePath: file }, new AbortController().signal))
        .rejects.toThrow('jsonl-query:invalid-utf8');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not open a source when a portable query is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readPortableRustQuery({ sourcePath: join(tmpdir(), 'missing-cancelled-jsonlview-source.jsonl') }, controller.signal))
      .rejects.toThrow('MCP query was cancelled.');
  });

  it('rejects portable raw budgets above the bounded fallback cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsonlview-budget-'));
    const file = join(root, 'events.jsonl');
    writeFileSync(file, '{}\n', 'utf8');
    try {
      await expect(readPortableRustQuery({ sourcePath: file, maxBytes: 64 * 1024 * 1024 + 1 }, new AbortController().signal))
        .rejects.toThrow(/maxBytes.*bounded/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
