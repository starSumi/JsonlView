import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { displayFieldPath, keyPath, type ColumnSpec, type FieldPath } from '../../src/shared/types';
import { buildFieldTree, matchingFieldTree, type FieldTreeNode } from '../../src/webview/features/record-query/field-tree';
import { FieldTree, FIELD_TREE_PAGE_SIZE } from '../../src/webview/features/record-query/FieldTree';
import { recordColumnForPath, schemaRecordColumns } from '../../src/webview/format';

function column(path: FieldPath): ColumnSpec {
  return { id: JSON.stringify(path.tokens), label: displayFieldPath(path), source: 'record', path };
}

describe('field tree presentation', () => {
  it('groups exact array paths under an expandable [] branch without inventing a wildcard path', () => {
    const type = column(keyPath('type'));
    const first = column({ tokens: [...type.path!.tokens, { kind: 'index', value: 0 }, { kind: 'key', value: 'name' }] });
    const second = column({ tokens: [...type.path!.tokens, { kind: 'index', value: 1 }, { kind: 'key', value: 'name' }] });
    const tree = buildFieldTree([type, first, second]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.label).toBe('$.type');
    expect(tree[0]?.column).toBe(type);
    const array = tree[0]?.children[0];
    expect(array?.label).toBe('$.type[]');
    expect(array?.column).toBeUndefined();
    expect(array?.children.map((node) => node.label)).toEqual(['$.type[0]', '$.type[1]']);
    expect(array?.children.map((node) => node.children[0]?.column)).toEqual([first, second]);
    expect(first.path?.tokens[1]).toEqual({ kind: 'index', value: 0 });
  });

  it('preserves quoted keys and matching ancestors while searching nested paths and row values', () => {
    const nested = column(keyPath('payload', 'key.with.dot'));
    const other = column(keyPath('other'));
    const source = { column: column(keyPath('type')), values: ['response_item'], sampled: true };
    const tree = buildFieldTree([nested, other], [source]);
    const match = matchingFieldTree(tree, 'key.with.dot');
    expect(match.map((node) => node.label)).toEqual(['$.payload']);
    expect(match[0]?.children[0]?.column).toBe(nested);
    expect(matchingFieldTree(tree, 'response_item')[0]?.rowTypes).toBe(source);
    expect(matchingFieldTree(tree, 'missing')).toEqual([]);
  });

  it('mounts row controls only inside opened branches and retains the selected values', () => {
    const source = { column: column(keyPath('type')), values: ['response_item'], sampled: true };
    const onChange = vi.fn();
    const selection = { column: source.column, values: ['response_item'] };
    const render = (expanded: boolean) => renderToStaticMarkup(<FieldTree nodes={buildFieldTree([source.column], [source])}
      expanded={expanded} renderColumn={() => <span>column</span>}
      rowTypes={{ sources: [source], selection, disabled: false, onChange }} />);
    const closed = render(false);
    expect(closed).toContain('<summary title="$.type">$.type</summary>');
    expect(closed).not.toContain('row-type-filter-fields');
    expect(closed).not.toContain('<span>column</span>');
    expect(closed).not.toContain('<details open=""');
    const opened = render(true);
    expect(opened).toContain('Match row values (1)');
    expect(opened).toContain('type="checkbox" checked=""');
    expect(opened).toContain('aria-label="Add exact record type"');
    expect(opened).not.toContain('role="tree"');
  });

  it('pages wide levels explicitly and keeps every remaining field in the tree and search', () => {
    const columns = Array.from({ length: 250 }, (_, index) => column(keyPath(`field${index}`)));
    const nodes = buildFieldTree(columns);
    const markup = renderToStaticMarkup(<FieldTree nodes={nodes} expanded={false}
      renderColumn={(item) => <span>{item.label}</span>} />);
    expect(markup.match(/<span>/g)).toHaveLength(FIELD_TREE_PAGE_SIZE);
    expect(markup).toContain('Show 24 more (226 remaining)');
    expect(nodes).toHaveLength(250);
    expect(matchingFieldTree(nodes, '$.field249')[0]?.column).toBe(columns[249]);
  });

  it('searches extreme depth without recursive calls and initially mounts only the root disclosure', () => {
    let node: FieldTreeNode = { id: 'leaf', label: 'needle', children: [] };
    for (let index = 0; index < 10_000; index += 1) node = { id: String(index), label: 'branch', children: [node] };
    const matches = matchingFieldTree([node], 'needle');
    let depth = 0;
    for (let current = matches[0]; current?.children.length; current = current.children[0]) depth += 1;
    expect(depth).toBe(10_000);
    const markup = renderToStaticMarkup(<FieldTree nodes={matches} expanded={false} renderColumn={() => null} />);
    expect(markup.match(/<details/g)).toHaveLength(1);
    expect(markup).not.toContain('needle');
  });

  it('uses the same sampled and saved field path limits as the column model', () => {
    expect(recordColumnForPath({ tokens: Array.from({ length: 33 }, () => ({ kind: 'index', value: 0 })) })).toBeUndefined();
    expect(recordColumnForPath(keyPath('x'.repeat(257)))).toBeUndefined();
    const fields = Array.from({ length: 300 }, (_, index) => ({ path: keyPath(`f${index}`), displayPath: `$.f${index}`,
      seenRecords: '1', validRecordsObserved: '1', kinds: { string: '1' }, missingRecords: '0', nullRecords: '0',
      examples: ['value'], firstSeenOrdinal: '0', lastSeenOrdinal: '0', confidence: 'sampled' as const }));
    expect(schemaRecordColumns(fields, 300)).toHaveLength(250);
  });
});
