import type { JsonScalar, RowProjection } from '../shared/types';
import { resolveGroupCapacity, resolveLimits, throwIfAborted } from './limits';
import { selectValue } from './selectors';
import type {
  CategoricalAggregationOptions,
  CategoricalAggregationResult,
  CategoricalGroup,
} from './types';

interface ExactGroup {
  id: string;
  label: string;
  value: JsonScalar;
  count: number;
  firstSeen: number;
}

export class CategoricalAggregator {
  private readonly options: CategoricalAggregationOptions;
  private readonly maxRecords: number;
  private readonly maxKeyLength: number;
  private readonly maxGroups: number;
  private readonly exactCapacity: number;
  private readonly exact = new Map<string, ExactGroup>();
  private processedRecords = 0;
  private truncatedByRecordLimit = false;
  private otherCount = 0;
  private unknownCount = 0;
  private missingCount = 0;

  public constructor(options: CategoricalAggregationOptions) {
    this.options = { ...options, selector: { ...options.selector } };
    const limits = resolveLimits(options);
    this.maxRecords = limits.maxRecords;
    this.maxKeyLength = limits.maxKeyLength;
    this.maxGroups = resolveGroupCapacity(options.maxGroups);
    this.exactCapacity = this.maxGroups - 3;
    throwIfAborted(options.signal);
  }

  public add(row: RowProjection): boolean {
    throwIfAborted(this.options.signal);
    if (this.processedRecords >= this.maxRecords) {
      this.truncatedByRecordLimit = true;
      return false;
    }
    this.processedRecords += 1;

    const selected = selectValue(row, this.options.selector);
    if (selected.state === 'missing') {
      this.missingCount += 1;
      return true;
    }
    if (selected.state === 'unknown') {
      this.unknownCount += 1;
      return true;
    }

    const encoded = encodeValue(selected.value, this.maxKeyLength);
    if (!encoded) {
      this.unknownCount += 1;
      return true;
    }
    const existing = this.exact.get(encoded.key);
    if (existing) {
      existing.count += 1;
      return true;
    }
    if (this.exact.size >= this.exactCapacity) {
      this.otherCount += 1;
      return true;
    }
    this.exact.set(encoded.key, {
      id: `value:${this.processedRecords}`,
      label: encoded.label,
      value: selected.value,
      count: 1,
      firstSeen: this.processedRecords,
    });
    return true;
  }

  public finish(): CategoricalAggregationResult {
    throwIfAborted(this.options.signal);
    const groups: CategoricalGroup[] = [...this.exact.values()]
      .sort((left, right) => right.count - left.count || left.firstSeen - right.firstSeen)
      .map(({ id, label, value, count }) => ({ id, label, value, count, kind: 'value' }));
    if (this.otherCount > 0) groups.push({ id: 'other', label: 'Other', kind: 'other', count: this.otherCount });
    if (this.unknownCount > 0) groups.push({ id: 'unknown', label: 'Unknown', kind: 'unknown', count: this.unknownCount });
    if (this.missingCount > 0) groups.push({ id: 'missing', label: 'Missing', kind: 'missing', count: this.missingCount });

    return {
      kind: 'categorical',
      selector: { ...this.options.selector },
      groups,
      meta: {
        processedRecords: this.processedRecords,
        truncatedByRecordLimit: this.truncatedByRecordLimit,
        capacityReached: this.otherCount > 0,
        maxRecords: this.maxRecords,
        resultCapacity: this.maxGroups,
        retainedValueCapacity: this.exactCapacity,
        strategy: 'first-seen-exact-until-cap',
        selectionIsOrderDependent: true,
        countGuarantee: 'retained and reserved bucket counts are exact; identities merged into Other or Overflow are not retained',
      },
    };
  }
}

export function aggregateCategorical(
  rows: Iterable<RowProjection>,
  options: CategoricalAggregationOptions,
): CategoricalAggregationResult {
  const aggregator = new CategoricalAggregator(options);
  for (const row of rows) {
    if (!aggregator.add(row)) break;
  }
  return aggregator.finish();
}

function encodeValue(value: JsonScalar, maxKeyLength: number): { key: string; label: string } | undefined {
  if (value === null) return undefined;
  const type = typeof value;
  const label = typeof value === 'string' ? value : String(value);
  if (label.length > maxKeyLength) return undefined;
  return { key: `${type}:${label}`, label };
}
