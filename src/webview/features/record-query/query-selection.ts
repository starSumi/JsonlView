import type { ColumnSpec, FieldStats, Predicate, RowFilter, RowProjection } from '../../../shared/types';
import { predicateForFilter } from '../../query';

export const MAX_FIELD_FILTERS = 16;
export const MAX_ROW_TYPES = 32;

/** One row discriminator; alternatives match ANY, independently of visible columns. */
export interface RowTypeSelection {
  column: ColumnSpec;
  values: string[];
}

export interface RowTypeSource {
  column: ColumnSpec;
  values: string[];
  sampled: boolean;
}

const EVENT_KINDS = [
  'session', 'turn', 'message', 'log', 'span', 'task', 'action', 'observation',
  'patch', 'test', 'result', 'reasoning', 'tool_call', 'tool_result', 'subagent',
  'approval', 'usage', 'error', 'checkpoint', 'other',
];

export function rowTypeSources(
  columns: readonly ColumnSpec[], schema: readonly FieldStats[], rows: readonly RowProjection[],
  selection?: RowTypeSelection,
): RowTypeSource[] {
  const sources: RowTypeSource[] = [];
  // Only the top-level record discriminator is a raw row type. Array item
  // types and payload fields describe content inside a record, not its row.
  const raw = schema.find((field) => field.path.tokens.length === 1
    && field.path.tokens[0]?.kind === 'key' && field.path.tokens[0].value === 'type'
    && field.kinds.string !== undefined);
  if (raw !== undefined) {
    const column: ColumnSpec = { id: JSON.stringify(raw.path.tokens), label: 'Record type ($.type)',
      source: 'record', path: raw.path };
    sources.push({ column, sampled: true,
      values: raw.examples.filter((value) => value.length > 0 && value.length <= 128
        && !value.endsWith('…') && !/[\r\n]/.test(value)) });
  }
  const event = columns.find((column) => column.source === 'profile' && column.id === 'eventKind');
  if (event !== undefined) sources.push({ column: { ...event, label: 'Event category (profile)' },
    sampled: false, values: [...new Set([...EVENT_KINDS, ...rows.flatMap((row) => row.profile?.eventKind ?? [])])] });
  if (selection !== undefined) {
    const current = sources.find((source) => source.column.id === selection.column.id
      && source.column.source === selection.column.source);
    if (current !== undefined) current.values = [...new Set([...selection.values, ...current.values])];
    else sources.unshift({ column: selection.column, values: [...selection.values], sampled: true });
  }
  return sources;
}

export function rowTypePredicate(selection: RowTypeSelection | undefined): Predicate | undefined {
  if (selection === undefined || selection.values.length === 0) return undefined;
  const { column } = selection;
  const args = selection.values.map((value) => predicateForFilter({
    columnId: column.id, operator: 'eq', value,
    ...(column.source === 'profile' ? { source: 'profile' as const }
      : { source: 'record' as const, ...(column.path === undefined ? {} : { path: column.path }) }),
  }, [column])).filter((predicate): predicate is Predicate => predicate !== undefined);
  if (args.length === 0) return undefined;
  return args.length === 1 ? args[0] : { op: 'or', args };
}

export function describeFieldFilter(filter: RowFilter, columns: readonly ColumnSpec[]): string {
  const field = columns.find((column) => column.id === filter.columnId)?.label ?? filter.columnId;
  const operator = filter.operator.replaceAll('_', ' ');
  return `${field} ${operator}${filter.value === undefined ? '' : ` ${JSON.stringify(filter.value)}`}`;
}
