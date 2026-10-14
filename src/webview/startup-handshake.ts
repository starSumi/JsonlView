const READY_RETRY_MS = 2500;
const MAX_READY_ATTEMPTS = 3;
const MAX_STAGE_ID_LENGTH = 128;
const MAX_STAGE_ROWS = 500;

export type StartupStage = 'opened-accepted' | 'page-committed' | 'startup-error';

export function createStartupStageReceipt(
  stage: StartupStage,
  session: { documentId: string; generation: string; startupId: string; epoch?: number },
  rows?: number,
): { type: 'JSONLVIEW_STARTUP_STAGE'; stage: StartupStage; documentId: string; generation: string; startupId: string; epoch?: number; rows?: number } | undefined {
  if (!session.documentId || session.documentId.length > MAX_STAGE_ID_LENGTH
    || !session.generation || session.generation.length > MAX_STAGE_ID_LENGTH
    || !session.startupId || session.startupId.length > MAX_STAGE_ID_LENGTH) return undefined;
  if (session.epoch !== undefined && (!Number.isSafeInteger(session.epoch) || session.epoch < 0)) return undefined;
  if (stage === 'page-committed' && (rows === undefined || !Number.isSafeInteger(rows) || rows < 0 || rows > MAX_STAGE_ROWS)) {
    return undefined;
  }
  const base = {
    type: 'JSONLVIEW_STARTUP_STAGE' as const,
    stage,
    documentId: session.documentId,
    generation: session.generation,
    startupId: session.startupId,
    ...(session.epoch === undefined ? {} : { epoch: session.epoch }),
  };
  if (stage === 'page-committed' && rows !== undefined) return { ...base, rows };
  return base;
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
