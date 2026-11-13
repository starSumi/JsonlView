import { describe, expect, it } from 'vitest';
import { isTreemapMetadataV1 } from '../../src/shared/transport';
import type { TreemapMetadataV1, TreemapNodeV1 } from '../../src/shared/contracts/treemap';

const identity = {
  sourceId: 'codex-local',
  documentId: 'document-1',
  generation: 'generation-1',
  fingerprint: 'sha256:abc:1024',
};

function dto(): TreemapMetadataV1 {
  return {
    version: 1,
    ...identity,
    metric: 'bytes',
    scope: 'session',
    root: {
      id: 'source', label: 'Source', value: '900719925474099312345',
      children: [{ id: 'session-1', label: 'Session 1', value: '900719925474099312345' }],
    },
    truncated: false,
  };
}

describe('Treemap metadata transport contract', () => {
  it('accepts bounded metadata only when source, document, generation and fingerprint match current identity', () => {
    expect(isTreemapMetadataV1(dto(), identity)).toBe(true);
    expect(isTreemapMetadataV1(dto(), { ...identity, generation: 'retired-generation' })).toBe(false);
    for (const key of ['sourceId', 'documentId', 'fingerprint'] as const) {
      expect(isTreemapMetadataV1(dto(), { ...identity, [key]: 'other' })).toBe(false);
    }
    expect(isTreemapMetadataV1({ ...dto(), documentId: '' }, identity)).toBe(false);
    expect(isTreemapMetadataV1(dto(), undefined)).toBe(false);
  });

  it('rejects unsafe counts, raw payloads, arbitrary path fields and oversized trees', () => {
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, value: '-1' } }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, value: Number.MAX_SAFE_INTEGER + 1 } }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, value: '9'.repeat(1025) } }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), rawContent: 'private prompt' }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, path: 'C:/private/session.jsonl' } }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), sourceId: 'C:/private/source' }, { ...identity, sourceId: 'C:/private/source' })).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), metric: 'disk' }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), scope: 'directory' }, identity)).toBe(false);

    let deep: Record<string, unknown> = { id: 'leaf', label: 'Leaf', value: '1' };
    for (let index = 0; index < 500; index += 1) {
      deep = { id: `node-${String(index)}`, label: 'Node', value: '1', children: [deep] };
    }
    expect(isTreemapMetadataV1({ ...dto(), root: deep }, identity)).toBe(false);
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, children: Array.from({ length: 500 }, (_, index) => ({
      id: `node-${String(index)}`, label: 'Node', value: '1',
    })) } }, identity)).toBe(false);
  });

  it('accepts exactly 500 nodes and levels, both metrics and explicit truncation', () => {
    let root: TreemapNodeV1 = { id: 'leaf', label: 'Leaf', value: '1' };
    for (let index = 1; index < 500; index += 1) {
      root = { id: `node-${String(index)}`, label: 'Node', value: '1', children: [root] };
    }
    expect(isTreemapMetadataV1({ ...dto(), root, metric: 'records', truncated: true }, identity)).toBe(true);
    expect(isTreemapMetadataV1({ ...dto(), root: { id: 'root', label: 'Root', value: '499', children:
      Array.from({ length: 499 }, (_, index) => ({ id: `n-${String(index)}`, label: 'Node', value: '1' })),
    } }, identity)).toBe(true);
  });

  it('requires opaque node identifiers instead of absolute paths or UNC names', () => {
    for (const id of ['C:/private/session.jsonl', 'C:\\private\\session.jsonl', '/private/session.jsonl', '\\\\server\\share\\session.jsonl', '//server/share/session.jsonl']) {
      expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, id } }, identity)).toBe(false);
      expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, children: [{ id, label: 'Session', value: '1' }] } }, identity)).toBe(false);
    }
    expect(isTreemapMetadataV1({ ...dto(), root: { id: 'session:opaque-1', label: 'Session', value: '1' } }, identity)).toBe(true);
  });

  it('rejects sparse children and explicit missing child values without weakening the node budget', () => {
    const leaf = { id: 'leaf', label: 'Leaf', value: '1' };
    for (const children of [Array(1), Object.assign(Array(2), { 1: leaf }), [undefined], [null]]) {
      expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, children } }, identity)).toBe(false);
    }
    const inherited = Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: leaf }));
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, children: inherited } }, identity)).toBe(false);
    const children = Array.from({ length: 499 }, (_, index) => ({ ...leaf, id: `leaf-${String(index)}` }));
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, children } }, identity)).toBe(true);
    children.push(leaf);
    expect(isTreemapMetadataV1({ ...dto(), root: { ...dto().root, children } }, identity)).toBe(false);
  });
});
