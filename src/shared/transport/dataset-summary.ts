import { DATASET_ANALYSIS_LIMITS as LIMITS, type DatasetRecordSummary } from '../dataset-analysis';

const scenes = ['pretraining', 'instruction', 'qa', 'preference', 'conversation', 'classification', 'tokenized', 'unknown'];
const targets = ['present', 'empty', 'missing', 'not-applicable', 'unknown'];
const roles = ['user', 'assistant', 'system', 'tool', 'function', 'unknown'];
const weights = ['specified', 'zero', 'positive', 'negative', 'invalid', 'array'];
const issues = ['invalid-record', 'unknown-scene', 'missing-target', 'empty-target', 'incomplete-preference', 'invalid-message', 'unknown-role', 'invalid-loss-weight', 'invalid-token-id', 'invalid-declared-count', 'token-count-mismatch', 'token-length-mismatch', 'inspection-truncated'];
const sequenceFields = ['tokens', 'input_ids', 'labels', 'attention_mask'];
const declaredFields = ['token_count', 'num_tokens'];
const categoryFields = ['label', 'category', 'split', 'language'];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const member = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const array = (value: unknown, limit: number, guard: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= limit && value.every(guard);
const counters = (value: unknown, keys: readonly string[]): value is Record<string, number> => object(value) && exact(value, keys) && keys.every((key) => count(value[key]));

function path(value: unknown): boolean {
  return object(value) && exact(value, ['tokens']) && array(value.tokens, 12, (token) => object(token)
    && exact(token, ['kind', 'value'])
    && (token.kind === 'key' ? typeof token.value === 'string' && token.value.length <= LIMITS.categoryLength
      : token.kind === 'index' && count(token.value)));
}

function sequence(value: unknown): boolean {
  return object(value) && exact(value, ['path', 'field', 'length', 'inspected', 'nonInteger', 'negative100', 'truncated'])
    && path(value.path) && member(value.field, sequenceFields)
    && count(value.length) && count(value.inspected) && value.inspected <= Math.min(value.length, LIMITS.tokenValues)
    && count(value.nonInteger) && value.nonInteger <= value.inspected
    && count(value.negative100) && value.negative100 <= value.inspected && typeof value.truncated === 'boolean';
}

/** Reject malformed additive observations before they reach aggregation or rendering. */
export function isDatasetRecordSummary(value: unknown): value is DatasetRecordSummary {
  if (!object(value) || !exact(value, ['version', 'valid', 'scene', 'target', 'evidence', 'messages', 'tokens', 'media', 'categories', 'issues', 'truncated'])) return false;
  if (value.version !== 1 || typeof value.valid !== 'boolean' || !member(value.scene, scenes) || !member(value.target, targets)
    || !array(value.evidence, LIMITS.evidence, path) || typeof value.truncated !== 'boolean') return false;
  const messages = value.messages;
  if (!object(messages) || !exact(messages, ['total', 'observed', 'roles', 'lossWeights', 'truncated'])
    || !count(messages.total) || !count(messages.observed) || messages.observed > Math.min(messages.total, LIMITS.messages)
    || !counters(messages.roles, roles) || !counters(messages.lossWeights, weights) || typeof messages.truncated !== 'boolean'
    || roles.reduce((sum, role) => sum + (messages.roles as Record<string, number>)[role]!, 0) > messages.observed
    || messages.lossWeights.specified! > messages.observed
    || weights.filter((key) => key !== 'specified').reduce((sum, key) => sum + (messages.lossWeights as Record<string, number>)[key]!, 0) !== messages.lossWeights.specified) return false;
  const tokens = value.tokens;
  return object(tokens) && exact(tokens, ['sequences', 'declared', 'mismatch'])
    && array(tokens.sequences, sequenceFields.length, sequence)
    && array(tokens.declared, declaredFields.length, (item) => object(item) && exact(item, ['path', 'field', 'value'])
      && path(item.path) && member(item.field, declaredFields) && count(item.value))
    && typeof tokens.mismatch === 'boolean' && counters(value.media, ['image', 'audio', 'video'])
    && array(value.categories, categoryFields.length, (item) => object(item) && exact(item, ['field', 'value'])
      && member(item.field, categoryFields) && typeof item.value === 'string' && item.value.length <= LIMITS.categoryLength)
    && array(value.issues, issues.length, (item) => member(item, issues));
}
