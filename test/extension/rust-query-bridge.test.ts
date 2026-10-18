import { describe, expect, it } from 'vitest';
import { RUST_QUERY_SCHEMA, RustQueryAuthorizationError, RustQueryBridge } from '../../src/extension/rust-query-bridge';

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
});
