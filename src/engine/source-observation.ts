import { stat, type FileHandle } from 'node:fs/promises';
import { JsonlEngineError } from './errors';
import type { GetRowsOptions } from './jsonl-engine-types';
import type { ReadWaitObserver } from './snapshot-fingerprint';

interface ObservedSource {
  filePath: string;
  handle: FileHandle;
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isInvalidated(): boolean;
}

/** Stat-only observation; never establishes content equality or starts a hash. */
export async function validateSourceObservation(source: ObservedSource, guard: () => void): Promise<boolean> {
  try {
    guard();
    if (source.isInvalidated() || source.device === 0n || source.inode === 0n) return false;
    const states = await Promise.all([
      stat(source.filePath, { bigint: true }), source.handle.stat({ bigint: true }),
    ]);
    guard();
    return !source.isInvalidated() && states.every((state) => state.isFile()
      && state.dev === source.device && state.ino === source.inode
      && state.size === source.size && state.mtimeNs === source.mtimeNs && state.ctimeNs === source.ctimeNs);
  } catch { return false; }
}

/** Restrict this opt-in path to physical forward pages with a caller-owned deadline. */
export function observedRowQueryGuard(options: GetRowsOptions, guard: () => void): () => void {
  const deadline = options.scanBudget?.deadlineEpochMs;
  if (options.direction !== 'forward' || options.sortOffset !== undefined
    || (options.sort !== undefined && (options.sort.columnId !== '__ordinal' || options.sort.direction !== 'asc'))
    || deadline === undefined || !Number.isSafeInteger(deadline) || deadline < 0) {
    throw new JsonlEngineError('INVALID_ARGUMENT', 'Observed background rows require a physical forward page and an absolute deadline.');
  }
  return () => {
    guard();
    if (Date.now() >= deadline) throw new JsonlEngineError('ABORTED', 'The observed background query deadline elapsed.');
  };
}

export async function assertSourceObservation(observe: () => Promise<boolean>, guard: () => void): Promise<void> {
  guard();
  const unchanged = await observe();
  guard();
  if (!unchanged) throw new JsonlEngineError('SOURCE_CHANGED', 'The source metadata changed before the bounded background query settled.');
}

/** Precharge requested bytes across index reconstruction, windows and hydration. */
export function observedReadAllowance(
  options: GetRowsOptions, guard: () => void, observer?: ReadWaitObserver,
): ReadWaitObserver {
  let remaining: bigint;
  try { remaining = BigInt(options.scanBudget?.maxExaminedBytes ?? 0); }
  catch { throw new JsonlEngineError('INVALID_ARGUMENT', 'Observed background rows require a positive byte allowance.'); }
  if (remaining <= 0n) throw new JsonlEngineError('INVALID_ARGUMENT', 'Observed background rows require a positive byte allowance.');
  return Object.assign((elapsedMs: number, bytesRead: number) => observer?.(elapsedMs, bytesRead), {
    limitRead(requestedLength: number): number {
      guard();
      if (remaining === 0n) throw new JsonlEngineError('READ_BUDGET_EXCEEDED', 'The bounded background query exhausted its content-read allowance.');
      const allowed = Number(remaining < BigInt(requestedLength) ? remaining : BigInt(requestedLength));
      remaining -= BigInt(allowed);
      try { options.onObservedReadRequest?.(allowed); } catch { /* Metadata observers cannot change the read allowance. */ }
      return allowed;
    },
  });
}
