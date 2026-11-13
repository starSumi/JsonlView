import {
  isStartupStageReceipt,
  type StartupStageReceipt as ContractStartupStageReceipt,
} from '@shared/contracts/errors';
import {
  EXECUTION_IDENTITY,
  executionIdentitiesEqual,
  isExecutionIdentity,
  isRuntimeExecutionIdentity,
  runtimeExecutionIdentitiesEqual,
  UNKNOWN_RUNTIME_IDENTITY,
  type ExecutionIdentity,
  type RuntimeExecutionIdentity,
} from '@shared/execution-identity';

/**
 * Extension adapter for startup receipts. The shared contract validates only
 * serializable shape; the host identity checks here bind the receipt to this
 * extension execution. The document/session match remains at the panel owner.
 */
export function parseStartupStageReceipt(
  value: unknown,
  expectedIdentity: ExecutionIdentity = EXECUTION_IDENTITY,
  expectedRuntime: RuntimeExecutionIdentity = UNKNOWN_RUNTIME_IDENTITY,
): ContractStartupStageReceipt | undefined {
  if (!isStartupStageReceipt(value)
    || !isExecutionIdentity(value.executionIdentity)
    || !executionIdentitiesEqual(value.executionIdentity, expectedIdentity)
    || !isRuntimeExecutionIdentity(value.runtimeIdentity)
    || !runtimeExecutionIdentitiesEqual(value.runtimeIdentity, expectedRuntime)) return undefined;
  return {
    ...value,
    executionIdentity: Object.freeze({ ...value.executionIdentity }),
    runtimeIdentity: Object.freeze({ ...value.runtimeIdentity }),
  };
}

export type { StartupStage, StartupStageReceipt } from '@shared/contracts/errors';
