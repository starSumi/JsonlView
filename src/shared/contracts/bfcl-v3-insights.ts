// Sample aggregation is a legacy view model; only record summaries enter RowProjection.
import type { BfclV3SampleSummary } from '../bfcl-v3-insights';

export const BFCL_V3_ADAPTER_ID = 'bfcl-v3' as const;
export const BFCL_V3_ADAPTER_VERSION = '1.0.0' as const;

export const BFCL_V3_LIMITS: Readonly<{
  records: number;
  jsonCharacters: number;
  nodes: number;
  depth: number;
  arrayEntries: number;
  objectKeys: number;
  categoryLength: number;
  distributionValues: number;
}> = Object.freeze({
  records: 256,
  jsonCharacters: 65_536,
  nodes: 1_024,
  depth: 8,
  arrayEntries: 256,
  objectKeys: 256,
  categoryLength: 80,
  distributionValues: 32,
});

export type BfclV3ParseState = 'missing' | 'empty' | 'valid' | 'malformed' | 'type-mismatch' | 'over-budget';
export type BfclV3Issue = 'invalid-record' | 'not-bfcl' | 'missing-field' | 'malformed-json' | 'over-budget'
  | 'type-mismatch' | 'invalid-definition' | 'invalid-turn' | 'multi-turn-mismatch';
export type BfclV3ScalarState = 'true' | 'false' | 'missing' | 'invalid';
export type BfclV3Role = 'system' | 'user' | 'assistant' | 'tool' | 'function' | 'other';

export interface BfclV3DefinitionStats {
  state: BfclV3ParseState;
  definitions: number;
  validDefinitions: number;
  parameterObjects: number;
  requiredParameters: number;
}
export interface BfclV3CallStats { state: BfclV3ParseState; groups: number; calls: number; objects: number }
export interface BfclV3TurnStats {
  state: BfclV3ParseState;
  turns: number;
  messages: number;
  roles: Record<BfclV3Role, number>;
  invalidTurns: number;
}
export interface BfclV3ConfigStats { state: BfclV3ParseState; keys: number; objects: number }
export interface BfclV3ClassStats { state: BfclV3ParseState; values: number; distinctValues: number }
export interface BfclV3CategoryValues { language?: string; testCategory?: string; subset?: string }

export interface BfclV3RecordSummary {
  version: 1;
  adapterId: typeof BFCL_V3_ADAPTER_ID;
  adapterVersion: typeof BFCL_V3_ADAPTER_VERSION;
  recognized: boolean;
  valid: boolean;
  multiTurn: BfclV3ScalarState;
  functions: BfclV3DefinitionStats;
  tools: BfclV3DefinitionStats;
  missedFunctions: BfclV3CallStats;
  initialConfig: BfclV3ConfigStats;
  turns: BfclV3TurnStats;
  groundTruth: BfclV3CallStats;
  involvedClasses: BfclV3ClassStats;
  categories: BfclV3CategoryValues;
  issues: BfclV3Issue[];
  truncated: boolean;
}

const STATES = new Set(['missing', 'empty', 'valid', 'malformed', 'type-mismatch', 'over-budget']);
const ROLES = ['system', 'user', 'assistant', 'tool', 'function', 'other'];
const ISSUES = new Set(['invalid-record', 'not-bfcl', 'missing-field', 'malformed-json', 'over-budget', 'type-mismatch', 'invalid-definition', 'invalid-turn', 'multi-turn-mismatch']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const keysOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const state = (value: unknown): boolean => typeof value === 'string' && STATES.has(value);
const roles = (value: unknown): boolean => object(value) && exact(value, ROLES) && ROLES.every((role) => count(value[role]));

export function isBfclV3RecordSummary(value: unknown): value is BfclV3RecordSummary {
  if (!object(value) || !exact(value, ['version', 'adapterId', 'adapterVersion', 'recognized', 'valid', 'multiTurn', 'functions', 'tools', 'missedFunctions', 'initialConfig', 'turns', 'groundTruth', 'involvedClasses', 'categories', 'issues', 'truncated'])) return false;
  return value.version === 1 && value.adapterId === BFCL_V3_ADAPTER_ID && value.adapterVersion === BFCL_V3_ADAPTER_VERSION
    && typeof value.recognized === 'boolean' && typeof value.valid === 'boolean' && ['true', 'false', 'missing', 'invalid'].includes(String(value.multiTurn))
    && definition(value.functions) && definition(value.tools) && calls(value.missedFunctions) && config(value.initialConfig)
    && turns(value.turns) && calls(value.groundTruth) && classes(value.involvedClasses)
    && categories(value.categories) && Array.isArray(value.issues) && value.issues.length <= ISSUES.size && value.issues.every((item) => typeof item === 'string' && ISSUES.has(item))
    && typeof value.truncated === 'boolean';
}

export function isBfclV3SampleSummary(value: unknown): value is BfclV3SampleSummary {
  if (!object(value) || !exact(value, ['version', 'adapterId', 'adapterVersion', 'coverage', 'multiTurn', 'functions', 'tools', 'turns', 'missedFunctions', 'initialConfig', 'groundTruth', 'involvedClasses', 'distributions', 'issues', 'truncated'])) return false;
  const coverage = value.coverage;
  return value.version === 1 && value.adapterId === BFCL_V3_ADAPTER_ID && value.adapterVersion === BFCL_V3_ADAPTER_VERSION
    && object(coverage) && exact(coverage, ['requestedRecords', 'sampledRecords', 'recognizedRecords', 'validRecords', 'invalidRecords', 'partial'])
    && count(coverage.requestedRecords) && count(coverage.sampledRecords) && coverage.sampledRecords <= Math.min(coverage.requestedRecords, BFCL_V3_LIMITS.records)
    && count(coverage.recognizedRecords) && coverage.recognizedRecords <= coverage.sampledRecords && count(coverage.validRecords) && coverage.validRecords <= coverage.recognizedRecords
    && count(coverage.invalidRecords) && coverage.validRecords + coverage.invalidRecords <= coverage.sampledRecords && typeof coverage.partial === 'boolean'
    && multiTurn(value.multiTurn)
    && totals(value.functions) && totals(value.tools) && turnTotals(value.turns) && callTotals(value.missedFunctions) && configTotals(value.initialConfig)
    && callTotals(value.groundTruth) && classTotals(value.involvedClasses) && Array.isArray(value.distributions) && value.distributions.length <= 3
    && value.distributions.every(distribution) && object(value.issues) && keysOnly(value.issues, [...ISSUES]) && Object.values(value.issues).every(count)
    && typeof value.truncated === 'boolean';
}

function definition(value: unknown): boolean { return object(value) && exact(value, ['state', 'definitions', 'validDefinitions', 'parameterObjects', 'requiredParameters']) && state(value.state) && count(value.definitions) && count(value.validDefinitions) && value.validDefinitions <= value.definitions && count(value.parameterObjects) && value.parameterObjects <= value.validDefinitions && count(value.requiredParameters); }
function multiTurn(value: unknown): boolean { return object(value) && exact(value, ['true', 'false', 'missing', 'invalid']) && ['true', 'false', 'missing', 'invalid'].every((key) => count(value[key])); }
function calls(value: unknown): boolean { return object(value) && exact(value, ['state', 'groups', 'calls', 'objects']) && state(value.state) && count(value.groups) && count(value.calls) && count(value.objects); }
function config(value: unknown): boolean { return object(value) && exact(value, ['state', 'keys', 'objects']) && state(value.state) && count(value.keys) && count(value.objects); }
function classes(value: unknown): boolean { return object(value) && exact(value, ['state', 'values', 'distinctValues']) && state(value.state) && count(value.values) && count(value.distinctValues) && value.distinctValues <= value.values; }
function turns(value: unknown): boolean { return object(value) && exact(value, ['state', 'turns', 'messages', 'roles', 'invalidTurns']) && state(value.state) && count(value.turns) && count(value.messages) && roles(value.roles) && count(value.invalidTurns); }
function categories(value: unknown): boolean { return object(value) && keysOnly(value, ['language', 'testCategory', 'subset']) && Object.values(value).every((item) => typeof item === 'string' && item.length <= BFCL_V3_LIMITS.categoryLength); }
function totals(value: unknown): boolean { return object(value) && exact(value, ['records', 'definitions', 'validDefinitions', 'parameterObjects', 'requiredParameters']) && Object.values(value).every(count); }
function callTotals(value: unknown): boolean { return object(value) && exact(value, ['records', 'groups', 'calls', 'objects']) && Object.values(value).every(count); }
function configTotals(value: unknown): boolean { return object(value) && exact(value, ['records', 'keys', 'objects']) && Object.values(value).every(count); }
function classTotals(value: unknown): boolean { return object(value) && exact(value, ['records', 'values', 'distinctValues']) && Object.values(value).every(count); }
function turnTotals(value: unknown): boolean { return object(value) && exact(value, ['records', 'turns', 'messages', 'roles', 'invalidTurns']) && count(value.records) && count(value.turns) && count(value.messages) && roles(value.roles) && count(value.invalidTurns); }
function distribution(value: unknown): boolean { return object(value) && exact(value, ['field', 'values', 'otherObservations']) && ['language', 'testCategory', 'subset'].includes(String(value.field)) && Array.isArray(value.values) && value.values.length <= BFCL_V3_LIMITS.distributionValues && value.values.every((item) => object(item) && exact(item, ['value', 'count']) && typeof item.value === 'string' && item.value.length <= BFCL_V3_LIMITS.categoryLength && count(item.count)) && count(value.otherObservations); }
