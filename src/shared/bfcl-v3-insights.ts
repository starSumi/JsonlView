import {
  BFCL_V3_ADAPTER_ID,
  BFCL_V3_ADAPTER_VERSION,
  BFCL_V3_LIMITS,
} from './contracts/bfcl-v3-insights';
import type {
  BfclV3CallStats,
  BfclV3CategoryValues,
  BfclV3ClassStats,
  BfclV3ConfigStats,
  BfclV3DefinitionStats,
  BfclV3Issue,
  BfclV3ParseState,
  BfclV3Role,
  BfclV3ScalarState,
  BfclV3TurnStats,
} from './contracts/bfcl-v3-insights';

export { BFCL_V3_ADAPTER_ID, BFCL_V3_ADAPTER_VERSION, BFCL_V3_LIMITS } from './contracts/bfcl-v3-insights';
export type {
  BfclV3CallStats,
  BfclV3CategoryValues,
  BfclV3ClassStats,
  BfclV3ConfigStats,
  BfclV3DefinitionStats,
  BfclV3Issue,
  BfclV3ParseState,
  BfclV3RecordSummary,
  BfclV3Role,
  BfclV3ScalarState,
  BfclV3TurnStats,
} from './contracts/bfcl-v3-insights';

export type BfclV3Field =
  | 'functions'
  | 'tools'
  | 'missed_functions'
  | 'initial_config'
  | 'turns'
  | 'ground_truth'
  | 'involved_classes';

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
