import { EXECUTION_IDENTITY, executionIdentitiesEqual, isExecutionIdentity, isRuntimeExecutionIdentity, runtimeExecutionIdentitiesEqual, UNKNOWN_RUNTIME_IDENTITY, type ExecutionIdentity, type RuntimeExecutionIdentity } from '@shared/execution-identity';

export type StartupStage = 'opened-accepted' | 'page-committed' | 'startup-error';

export interface StartupStageReceipt {
  type: 'JSONLVIEW_STARTUP_STAGE';
  stage: StartupStage;
  documentId: string;
  generation: string;
  startupId: string;
  executionIdentity: ExecutionIdentity;
  runtimeIdentity: RuntimeExecutionIdentity;
  epoch?: number;
  rows?: number;
}

export function parseStartupStageReceipt(
  value: unknown,
  expectedIdentity: ExecutionIdentity = EXECUTION_IDENTITY,
  expectedRuntime: RuntimeExecutionIdentity = UNKNOWN_RUNTIME_IDENTITY,
): StartupStageReceipt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type !== 'JSONLVIEW_STARTUP_STAGE'
    || (message.stage !== 'opened-accepted'
      && message.stage !== 'page-committed'
      && message.stage !== 'startup-error')
    || typeof message.documentId !== 'string' || message.documentId.length === 0 || message.documentId.length > 128
    || typeof message.generation !== 'string' || message.generation.length === 0 || message.generation.length > 128
    || typeof message.startupId !== 'string' || message.startupId.length === 0 || message.startupId.length > 128
    || !isExecutionIdentity(message.executionIdentity)
    || !executionIdentitiesEqual(message.executionIdentity, expectedIdentity)
    || !isRuntimeExecutionIdentity(message.runtimeIdentity)
    || !runtimeExecutionIdentitiesEqual(message.runtimeIdentity, expectedRuntime)
    || (message.epoch !== undefined && (!Number.isSafeInteger(message.epoch) || (message.epoch as number) < 0))) return undefined;
  if (message.stage === 'page-committed') {
    if (!Number.isSafeInteger(message.rows) || (message.rows as number) < 0 || (message.rows as number) > 500) return undefined;
  } else if (message.rows !== undefined) return undefined;
  return {
    type: 'JSONLVIEW_STARTUP_STAGE',
    stage: message.stage,
    documentId: message.documentId,
    generation: message.generation,
    startupId: message.startupId,
    executionIdentity: Object.freeze({ ...message.executionIdentity }),
    runtimeIdentity: Object.freeze({ ...message.runtimeIdentity }),
    ...(message.epoch === undefined ? {} : { epoch: message.epoch as number }),
    ...(message.stage === 'page-committed' ? { rows: message.rows as number } : {}),
  };
}
