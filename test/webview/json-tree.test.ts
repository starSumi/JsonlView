import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildVisibleJsonTree, JsonTree, JSON_TREE_ROOT_ID } from '../../src/webview/json-tree';

describe('bounded interactive JSON tree model', () => {
  it('expands only nodes explicitly present in the expansion set', () => {
    const value = { nested: { answer: 42 }, name: 'session' };
    const rootOnly = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID]));
    const nestedId = rootOnly.rows.find((row) => row.label === 'nested')?.id;

    expect(rootOnly.rows.map((row) => row.label)).toEqual(['$', 'nested', 'name']);
    expect(nestedId).toBeDefined();
    expect(rootOnly.rows.find((row) => row.label === 'nested')?.expanded).toBe(false);

    const withNested = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID, nestedId!]));
    expect(withNested.rows.map((row) => row.label)).toEqual(['$', 'nested', 'answer', 'name']);
    expect(withNested.rows.find((row) => row.label === 'answer')?.preview).toBe('42');
  });

  it('enforces visible node and child budgets', () => {
    const value = { values: Array.from({ length: 1_000 }, (_, index) => ({ index })) };
    const root = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID]));
    const valuesId = root.rows.find((row) => row.label === 'values')!.id;
    const result = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID, valuesId]), {
      maxNodes: 12,
      maxChildren: 5,
    });

    expect(result.rows.length).toBeLessThanOrEqual(12);
    expect(result.rows.filter((row) => /^\[\d+\]$/.test(row.label))).toHaveLength(5);
    expect(result.limited).toBe(true);
  });

  it('stops expansion at the configured depth', () => {
    const value = { one: { two: { three: true } } };
    const first = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID]));
    const oneId = first.rows.find((row) => row.label === 'one')!.id;
    const second = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID, oneId]));
    const twoId = second.rows.find((row) => row.label === 'two')!.id;
    const result = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID, oneId, twoId]), { maxDepth: 2 });
    const two = result.rows.find((row) => row.label === 'two');

    expect(two?.expandable).toBe(false);
    expect(two?.limited).toBe(true);
    expect(two?.preview).toContain('depth limit');
    expect(result.rows.some((row) => row.label === 'three')).toBe(false);
  });

  it('does not recurse through circular values', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    const root = buildVisibleJsonTree(value, new Set([JSON_TREE_ROOT_ID]));
    const self = root.rows.find((row) => row.label === 'self');

    expect(self?.preview).toBe('[Circular]');
    expect(self?.expandable).toBe(false);
  });

  it('renders expandable nodes with tree accessibility state', () => {
    const markup = renderToStaticMarkup(React.createElement(JsonTree, {
      value: { nested: { value: true }, flag: true },
    }));

    expect(markup).toContain('role="tree"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse $"');
    expect(markup).toContain('aria-label="Expand nested"');
    expect(markup).toContain('json-token-key');
    expect(markup).toContain('json-token-boolean');
  });
});
