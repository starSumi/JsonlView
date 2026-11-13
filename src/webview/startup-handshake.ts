import { EXECUTION_IDENTITY, isRuntimeExecutionIdentity, UNKNOWN_RUNTIME_IDENTITY, type RuntimeExecutionIdentity } from '@shared/execution-identity';
import {
  isStartupStageReceipt,
  JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION,
  MAX_STARTUP_STAGE_ID_LENGTH,
  MAX_STARTUP_STAGE_ROWS,
  type StartupStage as ContractStartupStage,
  type StartupStageReceipt,
} from '@shared/contracts/errors';

const READY_RETRY_MS = 2500;
const MAX_READY_ATTEMPTS = 3;
export type { StartupStage } from '@shared/contracts/errors';

export function createStartupStageReceipt(
  stage: ContractStartupStage,
  session: { documentId: string; generation: string; startupId: string; epoch?: number },
  rows?: number,
  runtimeIdentity: RuntimeExecutionIdentity = readRuntimeExecutionIdentity(),
): StartupStageReceipt | undefined {
  if (!session.documentId || session.documentId.length > MAX_STARTUP_STAGE_ID_LENGTH
    || !session.generation || session.generation.length > MAX_STARTUP_STAGE_ID_LENGTH
    || !session.startupId || session.startupId.length > MAX_STARTUP_STAGE_ID_LENGTH) return undefined;
  if (session.epoch !== undefined && (!Number.isSafeInteger(session.epoch) || session.epoch < 0)) return undefined;
  if (!isRuntimeExecutionIdentity(runtimeIdentity)) return undefined;
  if (stage === 'page-committed' && (rows === undefined || !Number.isSafeInteger(rows) || rows < 0 || rows > MAX_STARTUP_STAGE_ROWS)) {
    return undefined;
  }
  const base = {
    type: 'JSONLVIEW_STARTUP_STAGE' as const,
    startupStageProtocolVersion: JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION,
    stage,
    documentId: session.documentId,
    generation: session.generation,
    startupId: session.startupId,
    executionIdentity: EXECUTION_IDENTITY,
    runtimeIdentity: Object.freeze({ ...runtimeIdentity }),
    ...(session.epoch === undefined ? {} : { epoch: session.epoch }),
  };
  const receipt = stage === 'page-committed' && rows !== undefined ? { ...base, rows } : base;
  return isStartupStageReceipt(receipt) ? receipt : undefined;
}

export function startStartupHandshake(
  sendReady: () => void,
  isSettled: () => boolean,
  onTimeout: () => void,
): () => void {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const stop = (): void => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const attempt = (): void => {
    if (!active) return;
    if (isSettled()) { stop(); return; }
    if (attempts === MAX_READY_ATTEMPTS) {
      stop();
      onTimeout();
      return;
    }
    attempts += 1;
    sendReady();
    if (active && !isSettled()) timer = setTimeout(attempt, READY_RETRY_MS);
  };
  attempt();
  return stop;
}

export function readRuntimeExecutionIdentity(): Readonly<RuntimeExecutionIdentity> {
  if (typeof document === 'undefined') return UNKNOWN_RUNTIME_IDENTITY;
  const serialized = document.body?.dataset.runtimeIdentity;
  if (serialized === undefined || serialized.length > 1024) return UNKNOWN_RUNTIME_IDENTITY;
  try {
    const runtime: unknown = JSON.parse(serialized);
    return isRuntimeExecutionIdentity(runtime) ? Object.freeze({ ...runtime }) : UNKNOWN_RUNTIME_IDENTITY;
  } catch {
    return UNKNOWN_RUNTIME_IDENTITY;
  }
}
