import type { ParseState, FieldPath } from '../contracts/types.js';
import type { DatasetIssue, DatasetNumericSummary, DatasetRecordSummary, DatasetRole, DatasetSampleSummary, DatasetScene, DatasetTargetState } from '../shared-dataset-analysis.js';
import { isObject, own } from './utils.js';
import { DATASET_ANALYSIS_LIMITS } from '../shared-dataset-analysis.js';
export { DATASET_ANALYSIS_LIMITS } from '../shared-dataset-analysis.js';

const MESSAGE_FIELDS = ['messages', 'conversations', 'chosen_messages', 'rejected_messages'] as const;
const TOKEN_FIELDS = ['tokens', 'input_ids', 'labels', 'attention_mask'] as const;
const CATEGORY_FIELDS = ['label', 'category', 'split', 'language'] as const;

function path(...keys: Array<string | number>): FieldPath {
  return { tokens: keys.map((key) => typeof key === 'number' ? { kind: 'index', value: key } : { kind: 'key', value: key }) };
}

function emptySummary(): DatasetRecordSummary {
  return {
    version: 1, valid: false, scene: 'unknown', target: 'unknown', evidence: [],
    messages: { total: 0, observed: 0, roles: { user: 0, assistant: 0, system: 0, tool: 0, function: 0, unknown: 0 }, lossWeights: { specified: 0, zero: 0, positive: 0, negative: 0, invalid: 0, array: 0 }, truncated: false },
    tokens: { sequences: [], declared: [], mismatch: false },
    media: { image: 0, audio: 0, video: 0 }, categories: [], issues: [], truncated: false,
  };
}

function issue(result: DatasetRecordSummary, code: DatasetIssue): void {
  if (!result.issues.includes(code)) result.issues.push(code);
}

function evidence(result: DatasetRecordSummary, ...keys: Array<string | number>): void {
  if (result.evidence.length < DATASET_ANALYSIS_LIMITS.evidence) result.evidence.push(path(...keys));
}

function roleOf(value: unknown): DatasetRole {
  if (typeof value !== 'string' || value.length > 32) return 'unknown';
  switch (value.toLowerCase()) {
    case 'human': case 'user': return 'user';
    case 'gpt': case 'model': case 'bot': case 'assistant': return 'assistant';
    case 'system': case 'developer': return 'system';
    case 'tool': case 'observation': return 'tool';
    case 'function': case 'function_call': return 'function';
    default: return 'unknown';
  }
}

/** Presence is structural, not a judgment of training correctness. */
function contentState(value: unknown, depth = 0): 'present' | 'empty' | 'missing' {
  if (value === undefined || value === null) return 'missing';
  if (typeof value === 'string') return value.length === 0 ? 'empty' : 'present';
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : 'present';
  if (isObject(value) && depth < 2) {
    const content = own(value, 'content') ?? own(value, 'value') ?? own(value, 'text');
    return content === undefined ? 'present' : contentState(content, depth + 1);
  }
  return 'present';
}

function inspectMediaBlock(value: unknown, result: DatasetRecordSummary): void {
  if (!isObject(value)) return;
  const type = own(value, 'type');
  if (typeof type !== 'string') return;
  if (['image', 'image_url', 'input_image'].includes(type)) result.media.image += 1;
  else if (['audio', 'audio_url', 'input_audio'].includes(type)) result.media.audio += 1;
  else if (['video', 'video_url', 'input_video'].includes(type)) result.media.video += 1;
}

function inspectMessages(value: Record<string, unknown>, result: DatasetRecordSummary): DatasetTargetState {
  let assistant = 0;
  let nonemptyAssistant = 0;
  let emptyAssistant = 0;
  for (const field of MESSAGE_FIELDS) {
    const messages = own(value, field);
    if (!Array.isArray(messages)) continue;
    result.messages.total += messages.length;
    evidence(result, field);
    const remaining = Math.max(0, DATASET_ANALYSIS_LIMITS.messages - result.messages.observed);
    const count = Math.min(messages.length, remaining);
    if (count < messages.length) result.messages.truncated = result.truncated = true;
    for (let index = 0; index < count; index += 1) {
      result.messages.observed += 1;
      const message = messages[index];
      if (!isObject(message)) { issue(result, 'invalid-message'); continue; }
      const role = roleOf(own(message, 'role') ?? own(message, 'from') ?? own(message, 'speaker'));
      result.messages.roles[role] += 1;
      if (role === 'unknown') issue(result, 'unknown-role');
      const content = own(message, 'content') ?? own(message, 'value') ?? own(message, 'text');
      if (role === 'assistant') {
        assistant += 1;
        const state = contentState(content);
        if (state === 'present') nonemptyAssistant += 1;
        else if (state === 'empty') emptyAssistant += 1;
      }
      if (Array.isArray(content)) {
        const blockCount = Math.min(content.length, DATASET_ANALYSIS_LIMITS.blocks);
        if (blockCount < content.length) result.truncated = true;
        for (let block = 0; block < blockCount; block += 1) inspectMediaBlock(content[block], result);
      }
      const weight = own(message, 'loss_weight');
      if (weight === undefined) continue;
      const loss = result.messages.lossWeights;
      loss.specified += 1;
      if (Array.isArray(weight)) { loss.array += 1; continue; }
      if (typeof weight !== 'number' || !Number.isFinite(weight)) { loss.invalid += 1; issue(result, 'invalid-loss-weight'); }
      else if (weight === 0) loss.zero += 1;
      else if (weight > 0) loss.positive += 1;
      else loss.negative += 1;
    }
  }
  return nonemptyAssistant > 0 ? 'present' : result.messages.truncated ? 'unknown' : assistant > 0 && emptyAssistant > 0 ? 'empty' : 'missing';
}

function inspectTokens(value: Record<string, unknown>, result: DatasetRecordSummary): void {
  for (const field of TOKEN_FIELDS) {
    const sequence = own(value, field);
    if (!Array.isArray(sequence)) continue;
    const inspected = Math.min(sequence.length, DATASET_ANALYSIS_LIMITS.tokenValues);
    let nonInteger = 0;
    let negative100 = 0;
    let invalid = 0;
    for (let index = 0; index < inspected; index += 1) {
      const token = sequence[index];
      if (!Number.isSafeInteger(token)) {
        nonInteger += 1;
        // A generic tokens column can contain source token strings. Only ID
        // columns require integers; no tokenizer representation is inferred.
        if (field !== 'tokens' || typeof token !== 'string') invalid += 1;
      }
      if (token === -100) negative100 += 1;
    }
    const truncated = inspected < sequence.length;
    result.tokens.sequences.push({ field, path: path(field), length: sequence.length, inspected, nonInteger, negative100, truncated });
    evidence(result, field);
    if (invalid > 0) issue(result, 'invalid-token-id');
    if (truncated) result.truncated = true;
  }
  for (const field of ['token_count', 'num_tokens'] as const) {
    const count = own(value, field);
    if (count === undefined) continue;
    evidence(result, field);
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) result.tokens.declared.push({ field, path: path(field), value: count });
    else issue(result, 'invalid-declared-count');
  }
  const observed = result.tokens.sequences.filter((sequence) => sequence.field === 'tokens' || sequence.field === 'input_ids');
  if (result.tokens.declared.some((count) => observed.some((sequence) => sequence.length !== count.value))) {
    result.tokens.mismatch = true; issue(result, 'token-count-mismatch');
  }
  const input = result.tokens.sequences.find((sequence) => sequence.field === 'input_ids');
  if (input && result.tokens.sequences.some((sequence) => ['labels', 'attention_mask'].includes(sequence.field) && sequence.length !== input.length)) issue(result, 'token-length-mismatch');
}

function classify(value: Record<string, unknown>, result: DatasetRecordSummary, conversationTarget: DatasetTargetState): void {
  const has = (key: string): boolean => own(value, key) !== undefined;
  const choose = (scene: DatasetScene, target: DatasetTargetState, ...fields: string[]): void => {
    result.scene = scene; result.target = target;
    for (const field of fields) if (has(field)) evidence(result, field);
  };
  if (['chosen', 'rejected', 'chosen_messages', 'rejected_messages'].some(has)) {
    const chosen = contentState(own(value, 'chosen') ?? own(value, 'chosen_messages'));
    const rejected = contentState(own(value, 'rejected') ?? own(value, 'rejected_messages'));
    const target = chosen === 'missing' || rejected === 'missing' ? 'missing' : chosen === 'empty' || rejected === 'empty' ? 'empty' : 'present';
    choose('preference', target, 'chosen', 'rejected', 'chosen_messages', 'rejected_messages');
    if (target !== 'present') issue(result, 'incomplete-preference');
  } else if (MESSAGE_FIELDS.some((key) => Array.isArray(own(value, key)))) choose('conversation', conversationTarget);
  else if (has('instruction') || has('prompt')) {
    const response = own(value, 'output') ?? own(value, 'response') ?? own(value, 'completion');
    choose('instruction', contentState(response), 'instruction', 'prompt', 'output', 'response', 'completion');
  } else if (has('question') || has('answer')) choose('qa', contentState(own(value, 'answer')), 'question', 'answer');
  else if (has('label') && ['text', 'content', 'input'].some(has)) choose('classification', contentState(own(value, 'label')), 'text', 'content', 'input', 'label');
  else if (result.tokens.sequences.length > 0) choose('tokenized', 'not-applicable');
  else if (['text', 'content'].some((key) => typeof own(value, key) === 'string')) choose('pretraining', 'not-applicable', 'text', 'content');
  else issue(result, 'unknown-scene');
  if (result.target === 'missing') issue(result, 'missing-target');
  if (result.target === 'empty') issue(result, 'empty-target');
}

/** Pure, bounded metadata projection; never retains text, token values or media URLs. */
export function summarizeDatasetRecord(value: unknown, parseState?: ParseState): DatasetRecordSummary {
  const result = emptySummary();
  if (!isObject(value) || (parseState !== undefined && parseState !== 'valid' && parseState !== 'unknown')) {
    issue(result, 'invalid-record'); return result;
  }
  result.valid = true;
  const conversationTarget = inspectMessages(value, result);
  inspectTokens(value, result);
  classify(value, result, conversationTarget);
  for (const [field, kind] of [['images', 'image'], ['audios', 'audio'], ['videos', 'video']] as const) {
    const refs = own(value, field);
    if (Array.isArray(refs)) { result.media[kind] += refs.length; evidence(result, field); }
    else if (typeof refs === 'string' && refs.length > 0) { result.media[kind] += 1; evidence(result, field); }
  }
  for (const field of CATEGORY_FIELDS) {
    const category = own(value, field);
    if (typeof category === 'string') {
      if (category.length <= DATASET_ANALYSIS_LIMITS.categoryLength) result.categories.push({ field, value: category });
      else result.truncated = true;
    } else if (typeof category === 'boolean' || (typeof category === 'number' && Number.isFinite(category))) result.categories.push({ field, value: String(category) });
  }
  if (result.truncated) issue(result, 'inspection-truncated');
  return result;
}

function increment<T extends string>(target: Partial<Record<T, number>>, key: T): void { target[key] = (target[key] ?? 0) + 1; }

function addNumber(target: Map<string, DatasetNumericSummary>, key: string, value: number): void {
  const current = target.get(key);
  if (!current) { target.set(key, { count: 1, min: value, max: value, mean: value }); return; }
  current.count += 1; current.min = Math.min(current.min, value); current.max = Math.max(current.max, value);
  current.mean += (value - current.mean) / current.count;
}

/** A head/page observation is never promoted to a whole-file estimate. */
export function aggregateDatasetSummaries(
  records: readonly DatasetRecordSummary[],
  options: { scope: DatasetSampleSummary['scope']; partial?: boolean },
): DatasetSampleSummary {
  const count = Math.min(records.length, DATASET_ANALYSIS_LIMITS.records);
  const empty = emptySummary();
  const result: DatasetSampleSummary = {
    version: 1, scope: options.scope,
    coverage: { requestedRecords: records.length, sampledRecords: count, validRecords: 0, invalidRecords: 0, partial: options.partial === true || count < records.length },
    scenes: {}, targets: {}, issues: {}, messages: empty.messages, media: empty.media, categories: [], tokenLengths: [], declaredTokenCounts: [],
  };
  const categoryMaps = new Map<string, { values: Map<string, number>; otherObservations: number }>();
  const lengths = new Map<string, DatasetNumericSummary>();
  const declared = new Map<string, DatasetNumericSummary>();
  for (let index = 0; index < count; index += 1) {
    const record = records[index]!;
    if (record.valid) result.coverage.validRecords += 1; else result.coverage.invalidRecords += 1;
    increment(result.scenes, record.scene); increment(result.targets, record.target);
    for (const code of record.issues) increment(result.issues, code);
    result.coverage.partial ||= record.truncated;
    result.messages.total += record.messages.total; result.messages.observed += record.messages.observed;
    result.messages.truncated ||= record.messages.truncated;
    for (const role of Object.keys(result.messages.roles) as DatasetRole[]) result.messages.roles[role] += record.messages.roles[role];
    for (const field of Object.keys(result.messages.lossWeights) as Array<keyof DatasetRecordSummary['messages']['lossWeights']>) result.messages.lossWeights[field] += record.messages.lossWeights[field];
    for (const kind of ['image', 'audio', 'video'] as const) result.media[kind] += record.media[kind];
    for (const category of record.categories) {
      let bucket = categoryMaps.get(category.field);
      if (!bucket) { bucket = { values: new Map(), otherObservations: 0 }; categoryMaps.set(category.field, bucket); }
      const existing = bucket.values.get(category.value);
      if (existing !== undefined) bucket.values.set(category.value, existing + 1);
      else if (bucket.values.size < DATASET_ANALYSIS_LIMITS.categories) bucket.values.set(category.value, 1);
      else bucket.otherObservations += 1;
    }
    for (const sequence of record.tokens.sequences) addNumber(lengths, sequence.field, sequence.length);
    for (const declaration of record.tokens.declared) addNumber(declared, declaration.field, declaration.value);
  }
  result.categories = CATEGORY_FIELDS.flatMap((field) => {
    const bucket = categoryMaps.get(field);
    return bucket ? [{ field, values: [...bucket.values].map(([value, observations]) => ({ value, count: observations })).sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)), otherObservations: bucket.otherObservations }] : [];
  });
  result.tokenLengths = TOKEN_FIELDS.flatMap((field) => { const statistics = lengths.get(field); return statistics ? [{ field, statistics }] : []; });
  result.declaredTokenCounts = (['token_count', 'num_tokens'] as const).flatMap((field) => { const statistics = declared.get(field); return statistics ? [{ field, statistics }] : []; });
  return result;
}


