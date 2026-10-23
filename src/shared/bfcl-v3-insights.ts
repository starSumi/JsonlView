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

export type BfclV3Field =
  | 'functions'
  | 'tools'
  | 'missed_functions'
  | 'initial_config'
  | 'turns'
  | 'ground_truth'
  | 'involved_classes';

export type BfclV3ParseState =
  | 'missing'
  | 'empty'
  | 'valid'
  | 'malformed'
  | 'type-mismatch'
  | 'over-budget';

export type BfclV3Issue =
  | 'invalid-record'
  | 'not-bfcl'
  | 'missing-field'
  | 'malformed-json'
  | 'over-budget'
  | 'type-mismatch'
  | 'invalid-definition'
  | 'invalid-turn'
  | 'multi-turn-mismatch';

export type BfclV3ScalarState = 'true' | 'false' | 'missing' | 'invalid';
export type BfclV3Role = 'system' | 'user' | 'assistant' | 'tool' | 'function' | 'other';

export interface BfclV3DefinitionStats {
  state: BfclV3ParseState;
  definitions: number;
  validDefinitions: number;
  parameterObjects: number;
  requiredParameters: number;
}

export interface BfclV3CallStats {
  state: BfclV3ParseState;
  groups: number;
  calls: number;
  objects: number;
}

export interface BfclV3TurnStats {
  state: BfclV3ParseState;
  turns: number;
  messages: number;
  roles: Record<BfclV3Role, number>;
  invalidTurns: number;
}

export interface BfclV3ConfigStats {
  state: BfclV3ParseState;
  keys: number;
  objects: number;
}

export interface BfclV3ClassStats {
  state: BfclV3ParseState;
  values: number;
  distinctValues: number;
}

export interface BfclV3CategoryValues {
  language?: string;
  testCategory?: string;
  subset?: string;
}

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

export interface BfclV3NumericTotals {
  records: number;
  definitions: number;
  validDefinitions: number;
  parameterObjects: number;
  requiredParameters: number;
}

export interface BfclV3TurnTotals {
  records: number;
  turns: number;
  messages: number;
  roles: Record<BfclV3Role, number>;
  invalidTurns: number;
}

export interface BfclV3CallTotals {
  records: number;
  groups: number;
  calls: number;
  objects: number;
}

export interface BfclV3ConfigTotals {
  records: number;
  keys: number;
  objects: number;
}

export interface BfclV3ClassTotals {
  records: number;
  values: number;
  distinctValues: number;
}

export interface BfclV3Distribution {
  field: 'language' | 'testCategory' | 'subset';
  values: Array<{ value: string; count: number }>;
  otherObservations: number;
}

export interface BfclV3SampleSummary {
  version: 1;
  adapterId: typeof BFCL_V3_ADAPTER_ID;
  adapterVersion: typeof BFCL_V3_ADAPTER_VERSION;
  coverage: {
    requestedRecords: number;
    sampledRecords: number;
    recognizedRecords: number;
    validRecords: number;
    invalidRecords: number;
    partial: boolean;
  };
  multiTurn: { true: number; false: number; missing: number; invalid: number };
  functions: BfclV3NumericTotals;
  tools: BfclV3NumericTotals;
  turns: BfclV3TurnTotals;
  missedFunctions: BfclV3CallTotals;
  initialConfig: BfclV3ConfigTotals;
  groundTruth: BfclV3CallTotals;
  involvedClasses: BfclV3ClassTotals;
  distributions: BfclV3Distribution[];
  issues: Partial<Record<BfclV3Issue, number>>;
  truncated: boolean;
}
