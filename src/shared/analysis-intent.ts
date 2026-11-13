import type { AnalysisIntentV1, Predicate } from './types';

export function normalizePredicate(predicate: Predicate): Predicate {
  switch (predicate.op) {
    case 'and':
    case 'or': {
      const op = predicate.op;
      const normalized = predicate.args.flatMap((argument) => {
        const value = normalizePredicate(argument);
        return value.op === op ? value.args : [value];
      }).sort((left, right) => compareKeys(stablePredicateKey(left), stablePredicateKey(right)));
      return normalized.length === 1 ? normalized[0] ?? { op, args: [] } : { op, args: normalized };
    }
    case 'not':
      return { op: 'not', arg: normalizePredicate(predicate.arg) };
    case 'text_search':
      return predicate.paths === undefined ? { ...predicate } : {
        ...predicate,
        paths: [...predicate.paths].sort((left, right) => compareKeys(stableJson(left), stableJson(right))),
      };
    default:
      return structuredClone(predicate);
  }
}

export function analysisIntentEquals(left: AnalysisIntentV1, right: AnalysisIntentV1): boolean {
  return stableJson(left) === stableJson(right);
}

/** Failed semantic work stays failed across request-number changes. */
export function analysisConditionsEqual(left: AnalysisIntentV1, right: AnalysisIntentV1): boolean {
  return analysisIntentEquals({ ...left, intentRevision: 0 }, { ...right, intentRevision: 0 });
}

function stablePredicateKey(predicate: Predicate): string {
  return stableJson(predicate);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
