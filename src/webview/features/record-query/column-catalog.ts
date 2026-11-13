import type { ColumnSpec, FieldStats } from '@shared/types';
import { ORDINAL_COLUMN } from '@webview/format';

export interface ColumnCatalog {
  common: ColumnSpec[];
  configured: ColumnSpec[];
  fields: ColumnSpec[];
  advanced: ColumnSpec[];
}

const COMMON_PROFILE = ['eventKind', 'timestamp', 'actor', 'summary', 'status', 'model', 'severity'];
const SHORT_TEXT_LIMIT = 120;

export function fieldColumnReason(column: ColumnSpec, schema: readonly FieldStats[]): string | undefined {
  if (column.source !== 'record') return undefined;
  if (column.path?.tokens.some((token) => token.kind === 'index')) return 'Array item: inspect in record details';
  const field = schema.find((candidate) => JSON.stringify(candidate.path.tokens) === column.id);
  if (field === undefined) return 'Field shape has not been sampled';
  if (Object.keys(field.kinds).some((kind) => kind === 'object' || kind === 'array')) return 'Object or array: inspect in record details';
  if (field.examples.some((example) => example.length > SHORT_TEXT_LIMIT
    || /[\r\n]/.test(example) || example.endsWith('…'))) return 'Long content: inspect in record details';
  if (BigInt(field.validRecordsObserved) > 0n && BigInt(field.seenRecords) * 2n < BigInt(field.validRecordsObserved)) {
    return 'Sparse field in the observed schema';
  }
  return undefined;
}

/** Presentation choices only; explicit configured fields keep their projection. */
export function buildColumnCatalog(
  available: readonly ColumnSpec[], schema: readonly FieldStats[], selectedRecordIds: ReadonlySet<string>,
): ColumnCatalog {
  const profile = available.filter((column) => column.source === 'profile');
  const common = [ORDINAL_COLUMN, ...COMMON_PROFILE.flatMap((id) => profile.filter((column) => column.id === id)),
    ...profile.filter((column) => !COMMON_PROFILE.includes(column.id))];
  const configured: ColumnSpec[] = [];
  const fields: ColumnSpec[] = [];
  const advanced: ColumnSpec[] = [];
  for (const column of available) {
    if (column.source !== 'record') continue;
    if (selectedRecordIds.has(column.id)) configured.push(column);
    else if (fieldColumnReason(column, schema) === undefined) fields.push(column);
    else advanced.push(column);
  }
  return { common, configured, fields, advanced };
}
