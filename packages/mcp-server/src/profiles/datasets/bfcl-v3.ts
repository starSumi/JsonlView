import type {
  BfclV3CallStats,
  BfclV3CategoryValues,
  BfclV3ClassStats,
  BfclV3ConfigStats,
  BfclV3DefinitionStats,
  BfclV3Issue,
  BfclV3ParseState,
  BfclV3RecordSummary,
  BfclV3Role,
  BfclV3SampleSummary,
  BfclV3ScalarState,
  BfclV3TurnStats,
} from '../../contracts/bfcl-v3-insights.js';
import {
  BFCL_V3_ADAPTER_ID,
  BFCL_V3_ADAPTER_VERSION,
  BFCL_V3_LIMITS,
} from '../../contracts/bfcl-v3-insights.js';

// These are the fields needed to identify a BFCL row and report a bounded
// summary. The Hugging Face schema also exposes the annotation fields below;
// exporters may omit them, so their absence is represented as `missing`.
const REQUIRED_FIELDS = ['id', 'multi_turn', 'functions', 'tools', 'turns', 'language', 'test_category', 'subset', 'ground_truth'] as const;
export const BFCL_V3_OPTIONAL_FIELDS = ['missed_functions', 'initial_config', 'involved_classes'] as const;
const BFCL_CATEGORY_FIELDS = ['language', 'test_category', 'subset'] as const;
const ROLES: readonly BfclV3Role[] = ['system', 'user', 'assistant', 'tool', 'function', 'other'];

type ObjectValue = Record<string, unknown>;
type JsonExpectation = 'array' | 'object';

interface BoundedJson {
  state: BfclV3ParseState;
  value?: unknown;
  truncated: boolean;
}

/**
 * Parses only BFCL metadata. The parsed value never leaves this module and is
 * reduced to bounded counters before the caller receives a result.
 */
export function summarizeBfclV3Record(value: unknown): BfclV3RecordSummary {
  const base = emptyRecord();
  if (!isObject(value)) {
    base.issues = ['invalid-record'];
    return base;
  }
  base.recognized = isBfclV3Candidate(value);
  if (!base.recognized) {
    base.issues = ['not-bfcl'];
    return base;
  }
  base.valid = true;
  for (const field of REQUIRED_FIELDS) {
    if (!has(value, field)) pushIssue(base, 'missing-field');
  }
  base.multiTurn = scalarState(value.multi_turn);
  if (base.multiTurn === 'invalid') pushIssue(base, 'type-mismatch');

  base.functions = definitionStats(value.functions, 'array', base);
  base.tools = definitionStats(value.tools, 'array', base);
  base.missedFunctions = callStats(value.missed_functions, 'object', base);
  base.initialConfig = configStats(value.initial_config, base);
  base.turns = turnStats(value.turns, base);
  base.groundTruth = callStats(value.ground_truth, 'array-or-object', base);
  base.involvedClasses = classStats(value.involved_classes, base);
  base.categories = categories(value, base);
  if (base.multiTurn === 'true' && base.turns.state === 'valid' && base.turns.turns < 2) pushIssue(base, 'multi-turn-mismatch');
  base.truncated = base.truncated || hasBudgetIssue(base);
  base.valid = base.issues.length === 0;
  return base;
}

export function aggregateBfclV3Summaries(
  records: readonly BfclV3RecordSummary[],
  options: { partial?: boolean; requestedRecords?: number } = {},
): BfclV3SampleSummary {
  const count = Math.min(records.length, BFCL_V3_LIMITS.records);
  const requestedRecords = Math.max(count, options.requestedRecords ?? records.length);
  const result = emptySample(requestedRecords, count, options.partial === true || count < records.length || count < requestedRecords);
  const distributions = new Map<'language' | 'testCategory' | 'subset', Map<string, number>>();
  const distributionOverflow = new Map<'language' | 'testCategory' | 'subset', number>();
  for (let index = 0; index < count; index += 1) {
    const record = records[index]!;
    if (record.recognized) result.coverage.recognizedRecords += 1;
    if (record.valid) result.coverage.validRecords += 1; else result.coverage.invalidRecords += 1;
    result.truncated ||= record.truncated;
    result.coverage.partial ||= record.truncated;
    result.multiTurn[record.multiTurn] += 1;
    addDefinition(result.functions, record.functions);
    addDefinition(result.tools, record.tools);
    addTurns(result.turns, record.turns);
    addCalls(result.missedFunctions, record.missedFunctions);
    addConfig(result.initialConfig, record.initialConfig);
    addCalls(result.groundTruth, record.groundTruth);
    addClasses(result.involvedClasses, record.involvedClasses);
    for (const issue of record.issues) result.issues[issue] = (result.issues[issue] ?? 0) + 1;
    for (const field of ['language', 'testCategory', 'subset'] as const) {
      const value = record.categories[field];
      if (value === undefined) continue;
      let values = distributions.get(field);
      if (values === undefined) { values = new Map(); distributions.set(field, values); }
      if (values.has(value)) values.set(value, values.get(value)! + 1);
      else if (values.size < BFCL_V3_LIMITS.distributionValues) values.set(value, 1);
      else distributionOverflow.set(field, (distributionOverflow.get(field) ?? 0) + 1);
    }
  }
  result.coverage.partial ||= count < records.length || count < requestedRecords;
  result.distributions = (['language', 'testCategory', 'subset'] as const).flatMap((field) => {
    const values = distributions.get(field);
    if (values === undefined) return [];
    const entries = [...values.entries()].map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
    return [{ field, values: entries, otherObservations: distributionOverflow.get(field) ?? 0 }];
  });
  return result;
}

export function isBfclV3Candidate(value: unknown): value is ObjectValue {
  if (!isObject(value)) return false;
  if (!(has(value, 'functions') || has(value, 'tools'))
    || !(has(value, 'turns') || has(value, 'ground_truth'))) return false;

  let categoryFields = 0;
  for (const field of BFCL_CATEGORY_FIELDS) if (has(value, field)) categoryFields += 1;
  if (categoryFields === BFCL_CATEGORY_FIELDS.length) return true;

  // Preserve malformed-row diagnostics when the BFCL category is encoded in its ID.
  const id = value.id;
  const testCategory = value.test_category;
  if (typeof id === 'string' && typeof testCategory === 'string' && testCategory.length > 0 && id.startsWith(`${testCategory}_`)) return true;

  let annotationFields = 0;
  for (const field of BFCL_V3_OPTIONAL_FIELDS) {
    if (has(value, field) && ++annotationFields === 2) return true;
  }
  return false;
}

function emptyRecord(): BfclV3RecordSummary {
  return {
    version: 1, adapterId: BFCL_V3_ADAPTER_ID, adapterVersion: BFCL_V3_ADAPTER_VERSION,
    recognized: false, valid: false, multiTurn: 'missing',
    functions: emptyDefinitions(), tools: emptyDefinitions(), missedFunctions: emptyCalls(),
    initialConfig: emptyConfig(), turns: emptyTurns(), groundTruth: emptyCalls(), involvedClasses: emptyClasses(),
    categories: {}, issues: [], truncated: false,
  };
}

function emptySample(requestedRecords: number, sampledRecords: number, partial: boolean): BfclV3SampleSummary {
  return {
    version: 1, adapterId: BFCL_V3_ADAPTER_ID, adapterVersion: BFCL_V3_ADAPTER_VERSION,
    coverage: { requestedRecords, sampledRecords, recognizedRecords: 0, validRecords: 0, invalidRecords: 0, partial },
    multiTurn: { true: 0, false: 0, missing: 0, invalid: 0 },
    functions: { records: 0, definitions: 0, validDefinitions: 0, parameterObjects: 0, requiredParameters: 0 },
    tools: { records: 0, definitions: 0, validDefinitions: 0, parameterObjects: 0, requiredParameters: 0 },
    turns: { records: 0, turns: 0, messages: 0, roles: emptyRoles(), invalidTurns: 0 },
    missedFunctions: { records: 0, groups: 0, calls: 0, objects: 0 },
    initialConfig: { records: 0, keys: 0, objects: 0 },
    groundTruth: { records: 0, groups: 0, calls: 0, objects: 0 },
    involvedClasses: { records: 0, values: 0, distinctValues: 0 },
    distributions: [], issues: {}, truncated: false,
  };
}

function definitionStats(raw: unknown, expectation: JsonExpectation, result: BfclV3RecordSummary): BfclV3DefinitionStats {
  const parsed = boundedJson(raw, expectation);
  const output = emptyDefinitions(parsed.state);
  result.truncated ||= parsed.truncated;
  stateIssue(result, parsed.state);
  if (parsed.state !== 'valid' || !Array.isArray(parsed.value)) return output;
  output.definitions = parsed.value.length;
  for (const definition of parsed.value) {
    const candidate = isObject(definition) && isObject(definition.function) ? definition.function : definition;
    if (!isObject(candidate) || typeof candidate.name !== 'string') { pushIssue(result, 'invalid-definition'); continue; }
    output.validDefinitions += 1;
    const parameters = candidate.parameters;
    if (isObject(parameters)) {
      output.parameterObjects += 1;
      if (Array.isArray(parameters.required)) output.requiredParameters += Math.min(parameters.required.length, BFCL_V3_LIMITS.arrayEntries);
    }
  }
  return output;
}

function turnStats(raw: unknown, result: BfclV3RecordSummary): BfclV3TurnStats {
  const parsed = boundedJson(raw, 'array');
  const output = emptyTurns(parsed.state);
  result.truncated ||= parsed.truncated;
  stateIssue(result, parsed.state);
  if (parsed.state !== 'valid' || !Array.isArray(parsed.value)) return output;
  output.turns = parsed.value.length;
  for (const turn of parsed.value) {
    if (!Array.isArray(turn)) { output.invalidTurns += 1; pushIssue(result, 'invalid-turn'); continue; }
    for (const message of turn) {
      if (!isObject(message) || typeof message.role !== 'string') { output.invalidTurns += 1; pushIssue(result, 'invalid-turn'); continue; }
      output.messages += 1;
      const role = ROLES.includes(message.role.toLowerCase() as BfclV3Role) ? message.role.toLowerCase() as BfclV3Role : 'other';
      output.roles[role] += 1;
    }
  }
  return output;
}

function callStats(raw: unknown, expectation: JsonExpectation | 'array-or-object', result: BfclV3RecordSummary): BfclV3CallStats {
  const parsed = boundedJson(raw, expectation);
  const output = emptyCalls(parsed.state);
  result.truncated ||= parsed.truncated;
  stateIssue(result, parsed.state);
  if (parsed.state !== 'valid') return output;
  output.groups = Array.isArray(parsed.value) ? parsed.value.length : isObject(parsed.value) ? Object.keys(parsed.value).length : 0;
  output.calls = countCallLeaves(parsed.value);
  output.objects = countObjects(parsed.value);
  return output;
}

function configStats(raw: unknown, result: BfclV3RecordSummary): BfclV3ConfigStats {
  const parsed = boundedJson(raw, 'object');
  const output = emptyConfig(parsed.state);
  result.truncated ||= parsed.truncated;
  stateIssue(result, parsed.state);
  if (parsed.state === 'valid' && isObject(parsed.value)) {
    output.keys = Object.keys(parsed.value).length;
    output.objects = countObjects(parsed.value);
  }
  return output;
}

function classStats(raw: unknown, result: BfclV3RecordSummary): BfclV3ClassStats {
  const parsed = Array.isArray(raw)
    ? {
      state: raw.length > BFCL_V3_LIMITS.arrayEntries ? 'over-budget' as const : raw.length === 0 ? 'empty' as const : 'valid' as const,
      value: raw,
      truncated: raw.length > BFCL_V3_LIMITS.arrayEntries,
    }
    : boundedJson(raw, 'array');
  const output = emptyClasses(parsed.state);
  result.truncated ||= parsed.truncated;
  stateIssue(result, parsed.state);
  if (!['valid', 'over-budget'].includes(parsed.state) || !Array.isArray(parsed.value)) return output;
  const boundedValues = parsed.value.slice(0, BFCL_V3_LIMITS.arrayEntries);
  const values = boundedValues.filter((item): item is string => typeof item === 'string' && item.length <= BFCL_V3_LIMITS.categoryLength);
  if (values.length !== boundedValues.length) pushIssue(result, 'type-mismatch');
  output.values = values.length;
  output.distinctValues = new Set(values).size;
  return output;
}

function categories(value: ObjectValue, result: BfclV3RecordSummary): BfclV3CategoryValues {
  const output: BfclV3CategoryValues = {};
  for (const [input, field] of [['language', 'language'], ['test_category', 'testCategory'], ['subset', 'subset']] as const) {
    const candidate = value[input];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string') { pushIssue(result, 'type-mismatch'); continue; }
    if (candidate.length === 0 || candidate.length > BFCL_V3_LIMITS.categoryLength) { pushIssue(result, 'over-budget'); continue; }
    output[field] = candidate;
  }
  return output;
}

function boundedJson(raw: unknown, expectation: JsonExpectation | 'array-or-object'): BoundedJson {
  if (raw === undefined) return { state: 'missing', truncated: false };
  if (typeof raw !== 'string') return { state: 'type-mismatch', truncated: false };
  if (raw.length === 0) return { state: 'empty', truncated: false };
  if (raw.length > BFCL_V3_LIMITS.jsonCharacters) return { state: 'over-budget', truncated: true };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { state: 'malformed', truncated: false }; }
  const budget = { nodes: 0, truncated: false };
  inspectJson(value, 0, budget);
  if (budget.truncated) return { state: 'over-budget', truncated: true };
  if ((expectation === 'array' && !Array.isArray(value)) || (expectation === 'object' && !isObject(value))
    || (expectation === 'array-or-object' && !Array.isArray(value) && !isObject(value))) return { state: 'type-mismatch', truncated: false };
  if ((Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0)) return { state: 'empty', value, truncated: false };
  return { state: 'valid', value, truncated: false };
}

function inspectJson(value: unknown, depth: number, budget: { nodes: number; truncated: boolean }): void {
  budget.nodes += 1;
  if (budget.nodes > BFCL_V3_LIMITS.nodes || depth > BFCL_V3_LIMITS.depth) { budget.truncated = true; return; }
  if (Array.isArray(value)) {
    if (value.length > BFCL_V3_LIMITS.arrayEntries) { budget.truncated = true; return; }
    for (const item of value) inspectJson(item, depth + 1, budget);
  } else if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > BFCL_V3_LIMITS.objectKeys) { budget.truncated = true; return; }
    for (const key of keys) inspectJson(value[key], depth + 1, budget);
  }
}

function countCallLeaves(value: unknown): number {
  if (typeof value === 'string') return value.length > 0 ? 1 : 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countCallLeaves(item), 0);
  if (isObject(value)) return Object.values(value).reduce<number>((sum, item) => sum + countCallLeaves(item), 0);
  return 0;
}

function countObjects(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countObjects(item), 0);
  if (!isObject(value)) return 0;
  return 1 + Object.values(value).reduce<number>((sum, item) => sum + countObjects(item), 0);
}

function scalarState(value: unknown): BfclV3ScalarState {
  return typeof value === 'boolean' ? String(value) as 'true' | 'false' : value === undefined ? 'missing' : 'invalid';
}

function emptyDefinitions(state: BfclV3ParseState = 'missing'): BfclV3DefinitionStats {
  return { state, definitions: 0, validDefinitions: 0, parameterObjects: 0, requiredParameters: 0 };
}
function emptyCalls(state: BfclV3ParseState = 'missing'): BfclV3CallStats { return { state, groups: 0, calls: 0, objects: 0 }; }
function emptyConfig(state: BfclV3ParseState = 'missing'): BfclV3ConfigStats { return { state, keys: 0, objects: 0 }; }
function emptyClasses(state: BfclV3ParseState = 'missing'): BfclV3ClassStats { return { state, values: 0, distinctValues: 0 }; }
function emptyRoles(): Record<BfclV3Role, number> { return { system: 0, user: 0, assistant: 0, tool: 0, function: 0, other: 0 }; }
function emptyTurns(state: BfclV3ParseState = 'missing'): BfclV3TurnStats { return { state, turns: 0, messages: 0, roles: emptyRoles(), invalidTurns: 0 }; }

function addDefinition(target: BfclV3SampleSummary['functions'], source: BfclV3DefinitionStats): void {
  target.records += source.state === 'missing' ? 0 : 1; target.definitions += source.definitions;
  target.validDefinitions += source.validDefinitions; target.parameterObjects += source.parameterObjects; target.requiredParameters += source.requiredParameters;
}
function addTurns(target: BfclV3SampleSummary['turns'], source: BfclV3TurnStats): void {
  target.records += source.state === 'missing' ? 0 : 1; target.turns += source.turns; target.messages += source.messages; target.invalidTurns += source.invalidTurns;
  for (const role of ROLES) target.roles[role] += source.roles[role];
}
function addCalls(target: BfclV3SampleSummary['missedFunctions'], source: BfclV3CallStats): void { target.records += source.state === 'missing' ? 0 : 1; target.groups += source.groups; target.calls += source.calls; target.objects += source.objects; }
function addConfig(target: BfclV3SampleSummary['initialConfig'], source: BfclV3ConfigStats): void { target.records += source.state === 'missing' ? 0 : 1; target.keys += source.keys; target.objects += source.objects; }
function addClasses(target: BfclV3SampleSummary['involvedClasses'], source: BfclV3ClassStats): void { target.records += source.state === 'missing' ? 0 : 1; target.values += source.values; target.distinctValues += source.distinctValues; }

function hasBudgetIssue(record: BfclV3RecordSummary): boolean {
  return [record.functions, record.tools, record.missedFunctions, record.initialConfig, record.turns, record.groundTruth, record.involvedClasses].some((item) => item.state === 'over-budget');
}
function pushIssue(record: BfclV3RecordSummary, issue: BfclV3Issue): void { if (!record.issues.includes(issue)) record.issues.push(issue); }
function stateIssue(record: BfclV3RecordSummary, state: BfclV3ParseState): void {
  if (state === 'malformed') pushIssue(record, 'malformed-json');
  if (state === 'over-budget') pushIssue(record, 'over-budget');
  if (state === 'type-mismatch') pushIssue(record, 'type-mismatch');
}
function isObject(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(value: ObjectValue, key: string): boolean { return Object.hasOwn(value, key); }
