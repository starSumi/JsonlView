import { describe, expect, it } from 'vitest';
import type * as Facade from '../../src/engine';
import type * as Legacy from '../../src/engine/jsonl-engine';
import type * as Owned from '../../src/engine/jsonl-engine-types';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;

type ContractCompatibility = [
  Assert<Equal<Facade.BackgroundIndexHandle, Owned.BackgroundIndexHandle>>,
  Assert<Equal<Facade.EngineDiagnostics, Owned.EngineDiagnostics>>,
  Assert<Equal<Facade.GetDetailOptions, Owned.GetDetailOptions>>,
  Assert<Equal<Facade.GetProblemsOptions, Owned.GetProblemsOptions>>,
  Assert<Equal<Facade.GetRowsOptions, Owned.GetRowsOptions>>,
  Assert<Equal<Facade.IndexMoreOptions, Owned.IndexMoreOptions>>,
  Assert<Equal<Facade.InspectRowsOptions, Owned.InspectRowsOptions>>,
  Assert<Equal<Facade.JsonlEngineOptions, Owned.JsonlEngineOptions>>,
  Assert<Equal<Facade.JsonlOperationContext, Owned.JsonlOperationContext>>,
  Assert<Equal<Facade.NativeNewlineScannerSetting, Owned.NativeNewlineScannerSetting>>,
  Assert<Equal<Facade.RowEnricher, Owned.RowEnricher>>,
  Assert<Equal<Facade.RowInspectionPage, Owned.RowInspectionPage>>,
  Assert<Equal<Facade.SourceRefreshKind, Owned.SourceRefreshKind>>,
  Assert<Equal<Facade.SourceRefreshResult, Owned.SourceRefreshResult>>,
  Assert<Equal<Legacy.JsonlEngineQueueOperation, Owned.JsonlEngineQueueOperation>>,
  Assert<Equal<Legacy.JsonlQueryTiming, Owned.JsonlQueryTiming>>,
];

const contractCompatibility: ContractCompatibility = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

describe('JSONL engine type facade', () => {
  it('keeps the existing engine and package entrypoints identical to the contract owner', () => {
    expect(contractCompatibility.every(Boolean)).toBe(true);
  });
});
