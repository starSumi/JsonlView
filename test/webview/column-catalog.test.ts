import { describe, expect, it } from 'vitest';
import { keyPath, type ColumnSpec, type FieldPath, type FieldStats } from '../../src/shared/types';
import { buildColumnCatalog, fieldColumnReason, rowTypeSources } from '../../src/webview/features/record-query';

function field(path: FieldPath, examples = ['ok'], kinds: FieldStats['kinds'] = { string: '10' }): FieldStats {
  return { path, displayPath: JSON.stringify(path.tokens), examples, kinds, seenRecords: '10',
    validRecordsObserved: '10', missingRecords: '0', nullRecords: '0', firstSeenOrdinal: '0',
    lastSeenOrdinal: '9', confidence: 'sampled' };
}
function column(item: FieldStats): ColumnSpec {
  return { id: JSON.stringify(item.path.tokens), label: item.displayPath, source: 'record', path: item.path };
}

describe('table column catalog and row discriminators', () => {
  it('offers short stable payload leaves and type fields, while keeping content paths advanced', () => {
    const stable = field(keyPath('payload', 'permission_profile'));
    const type = field(keyPath('payload', 'type'));
    const rate = field(keyPath('rate_limits', 'remaining'), ['12'], { number: '10' });
    const long = field(keyPath('payload', 'text'), ['x'.repeat(121)]);
    const object = field(keyPath('rate_limits'), ['{}'], { object: '10' });
    const arrayItem = field({ tokens: [...keyPath('payload', 'output').tokens,
      { kind: 'index', value: 1 }, { kind: 'key', value: 'type' }] });
    const sparse = { ...field(keyPath('rare')), seenRecords: '1' };
    const schema = [stable, type, rate, long, object, arrayItem, sparse];
    const event: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const catalog = buildColumnCatalog([column(long), ...schema.filter((item) => item !== long).map(column), event],
      schema, new Set([column(long).id, column(arrayItem).id]));
    expect(catalog.common.map((item) => item.id)).toEqual(['__ordinal', 'eventKind']);
    expect(catalog.fields.map((item) => item.id)).toEqual([stable, type, rate].map((item) => column(item).id));
    expect(catalog.configured.map((item) => item.id)).toEqual([long, arrayItem].map((item) => column(item).id));
    expect(catalog.advanced.map((item) => item.id)).toEqual([object, sparse].map((item) => column(item).id));
    expect(fieldColumnReason(column(long), schema)).toContain('Long content');
    expect(fieldColumnReason(column(arrayItem), schema)).toContain('Array item');
  });

  it('keeps multiline and truncated samples out of the short-scalar list', () => {
    for (const example of ['line\nline', 'truncated…']) {
      const item = field(keyPath('body'), [example]);
      expect(fieldColumnReason(column(item), [item])).toContain('Long content');
    }
  });

  it('limits raw row types to the top-level discriminator and exposes profile Event separately', () => {
    const raw = field(keyPath('type'), ['response_item', 'event_msg']);
    const nested = field({ tokens: [...keyPath('payload', 'output').tokens,
      { kind: 'index', value: 0 }, { kind: 'key', value: 'type' }] }, ['output_text']);
    const event: ColumnSpec = { id: 'eventKind', label: 'Event', source: 'profile' };
    const sources = rowTypeSources([event], [raw, nested], []);
    expect(sources.map((item) => item.column.label)).toEqual(['Record type ($.type)', 'Event category (profile)']);
    expect(sources[0]?.values).toEqual(['response_item', 'event_msg']);
    expect(sources[1]?.values).toContain('tool_call');
    expect(sources.flatMap((item) => item.values)).not.toContain('output_text');
    expect(rowTypeSources([], [nested], [])).toEqual([]);
  });
});
