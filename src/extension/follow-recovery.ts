import type { DocumentSummary } from '../shared/types';
import type { SourceRefreshKind } from '../engine';

/**
 * The identity used by follow recovery is deliberately smaller than a full
 * snapshot. A generation is included so a recovery run cannot publish over a
 * newer manual rebuild; device/inode are required when the host can observe
 * them because a path alone is not a file identity.
 */
export interface FollowRecoveryIdentity {
  documentId: string;
  uri: string;
  generation: string;
  /** Size of the snapshot that became unknown. Used to reject truncation. */
  sizeBytes: string;
  device?: string;
  inode?: string;
}

export type FollowRecoveryProbe =
  | {
      kind: 'present';
      identity: FollowRecoveryIdentity;
      sizeBytes: bigint;
      mtimeNs: bigint;
    }
  | { kind: 'missing' }
  | { kind: 'not_file' }
  | { kind: 'error'; message?: string; retryable?: boolean };

export interface FollowRecoveryHost {
  /** Return the snapshot identity that must remain current for this run. */
  getExpectedIdentity(): FollowRecoveryIdentity;
  /** Re-check that no other rebuild or document close superseded the run. */
  isExpectedIdentityCurrent(expected: FollowRecoveryIdentity): boolean;
  /** Probe the path without mutating the current engine/generation. */
  probe(signal: AbortSignal): Promise<FollowRecoveryProbe>;
  /** Open and validate a candidate generation before it can be adopted. */
  rebuildStable(
    expected: FollowRecoveryIdentity,
    signal: AbortSignal,
  ): Promise<DocumentSummary>;
  /** Publish only after rebuildStable has atomically adopted the candidate. */
  publish(summary: DocumentSummary): Promise<void>;
  /** Keep the old page visible but tell the UI that automatic follow stopped. */
  invalidate(reason: 'truncate' | 'replace' | 'delete' | 'unknown'): Promise<void>;
  /** Explain why a bounded recovery run stopped and what the user can do. */
  report(message: string): Promise<void>;
  /** Let the existing watcher/reconcile loop consume events queued meanwhile. */
  scheduleReconcile?(): void;
}

/**
 * Refresh classifications that should be re-probed while follow mode is on.
 * Delete/replace are included because an atomic-save rename can expose a
 * short-lived ENOENT or non-file path; truncate remains terminal.
 */
export function shouldNotifyFollowRecovery(
  followMode: boolean,
  recoveryRunning: boolean,
  kind: SourceRefreshKind,
): boolean {
  if (!followMode) return false;
  if (kind === 'delete' || kind === 'replace' || kind === 'unknown') return true;
  return recoveryRunning && kind === 'append';
}

/**
 * The small portion of a VS Code webview needed by the extension fanout.
 * Keeping this structural lets the recovery tests exercise delivery failures
 * without loading the VS Code host module.
 */
export interface FollowRecoveryMessageSender<TMessage = unknown> {
  postMessage(message: TMessage): PromiseLike<boolean> | boolean;
}

/**
 * Deliver one message to every sender without allowing a disposed panel to
 * poison the document's generation/recovery state. A callback preserves
 * per-panel diagnostics while keeping delivery best effort.
 */
export async function postMessageBestEffort<TMessage>(
  senders: readonly FollowRecoveryMessageSender<TMessage>[],
  message: TMessage,
  onFailure?: (error: unknown, index: number) => void,
): Promise<void> {
  const outcomes = await Promise.allSettled(
    senders.map((sender) => Promise.resolve().then(() => sender.postMessage(message))),
  );
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      notifyMessageFailure(onFailure, outcome.reason, index);
    } else if (outcome.value === false) {
      notifyMessageFailure(onFailure, new Error('Webview declined the message.'), index);
    }
  });
}

function notifyMessageFailure(
  onFailure: ((error: unknown, index: number) => void) | undefined,
  error: unknown,
  index: number,
): void {
  if (onFailure === undefined) return;
  try {
    onFailure(error, index);
  } catch {
    // Diagnostics must never turn best-effort delivery into a failed rebuild.
  }
}

export interface FollowRecoveryOptions {
  /** Quiet interval required between two identical source probes. */
  quietPeriodMs?: number;
  /** Initial debounce before the first probe. */
  initialDelayMs?: number;
  /** Maximum delay between retries. */
  maxDelayMs?: number;
  /** Hard wall-clock budget for one recovery run. */
  maxWindowMs?: number;
  /** Maximum candidate attempts in one run. */
  maxAttempts?: number;
  /** Optional deterministic jitter source, returning a value in [0, 1). */
  jitter?: () => number;
}

export const DEFAULT_FOLLOW_RECOVERY_OPTIONS: Required<FollowRecoveryOptions> = {
  quietPeriodMs: 500,
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  maxWindowMs: 30_000,
  maxAttempts: 8,
  jitter: () => 0.5,
};

export type FollowRecoveryState = 'idle' | 'waiting' | 'recovering' | 'exhausted';

type FollowRecoveryGap = 'missing' | 'not_file';

export interface FollowRecoveryTimerApi {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  now(): number;
}

const realTimerApi: FollowRecoveryTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
};

/**
 * A bounded state machine for recovering a large-file follow after the engine
 * could not establish an exact open-time fingerprint. It intentionally does
 * not classify an unknown source as append. The only successful path is:
 * same identity -> quiet metadata -> stable candidate generation.
 */
export class FollowRecoveryCoordinator {
  private readonly options: Required<FollowRecoveryOptions>;
  private readonly timers: FollowRecoveryTimerApi;
  private state: FollowRecoveryState = 'idle';
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private expected: FollowRecoveryIdentity | undefined;
  private startedAt = 0;
  private attempts = 0;
  private pendingEvent = false;
  private deadlineReached = false;
  /** Consecutive path gaps observed across delayed probes. */
  private gap: FollowRecoveryGap | undefined;
  private gapCount = 0;

  public constructor(
    private readonly host: FollowRecoveryHost,
    options: FollowRecoveryOptions = {},
    timers: FollowRecoveryTimerApi = realTimerApi,
  ) {
    this.options = normalizeOptions(options);
    this.timers = timers;
  }

  public get recoveryState(): FollowRecoveryState {
    return this.state;
  }

  public get attemptCount(): number {
    return this.attempts;
  }

  public get isRunning(): boolean {
    return this.controller !== undefined;
  }

  /** Start a run for an unknown classification, or coalesce another event. */
  public notifyUnknown(): void {
    if (this.disposed || this.state === 'exhausted') return;
    if (this.controller !== undefined) {
      this.pendingEvent = true;
      return;
    }
    this.expected = this.host.getExpectedIdentity();
    this.startedAt = this.timers.now();
    this.attempts = 0;
    this.pendingEvent = false;
    this.deadlineReached = false;
    this.resetGap();
    this.controller = new AbortController();
    this.state = 'waiting';
    this.deadlineTimer = this.timers.setTimeout(() => {
      this.deadlineReached = true;
      this.controller?.abort();
      // A deadline can fire while the next retry timer is still queued. Clear
      // it and finish the run here; otherwise its top-level abort check would
      // incorrectly return the coordinator to idle without invalidating.
      this.clearAttemptTimer();
      if (this.controller !== undefined) {
        void this.exhaust('Follow recovery stopped after its time budget; use Rebuild when the writer is quiet.');
      }
    }, this.options.maxWindowMs);
    this.schedule(this.options.initialDelayMs);
  }

  /** Cancel the current run but keep the exhausted/manual boundary intact. */
  public cancel(): void {
    this.clearTimers();
    this.controller?.abort();
    this.controller = undefined;
    this.expected = undefined;
    this.pendingEvent = false;
    this.deadlineReached = false;
    this.resetGap();
    if (!this.disposed && this.state !== 'exhausted') this.state = 'idle';
  }

  /** Explicit rebuild/follow toggle reset. This is the only way past exhaustion. */
  public reset(): void {
    this.cancel();
    if (!this.disposed) this.state = 'idle';
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.state = 'exhausted';
  }

  private schedule(delayMs: number): void {
    this.clearAttemptTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.runAttempt().catch((error: unknown) => {
        void this.fail(error instanceof Error ? error.message : String(error));
      });
    }, Math.max(0, Math.round(delayMs)));
  }

  private async runAttempt(): Promise<void> {
    const expected = this.expected;
    const controller = this.controller;
    if (
      this.disposed
      || expected === undefined
      || controller === undefined
      || controller.signal.aborted
    ) {
      this.finishCancelled();
      return;
    }
    if (this.deadlineReached || this.timers.now() - this.startedAt >= this.options.maxWindowMs) {
      await this.exhaust('Follow recovery stopped after its time budget; use Rebuild when the writer is quiet.');
      return;
    }
    if (this.attempts >= this.options.maxAttempts) {
      await this.exhaust('Follow recovery stopped after its retry budget; use Rebuild when the writer is quiet.');
      return;
    }

    this.attempts += 1;
    this.state = 'recovering';
    try {
      const first = await this.host.probe(controller.signal);
      if (controller.signal.aborted) {
        this.finishCancelled();
        return;
      }
      if (!this.host.isExpectedIdentityCurrent(expected)) {
        this.finishCancelled();
        return;
      }
      const firstDisposition = this.dispositionForProbe(expected, first);
      if (firstDisposition.kind === 'terminal') {
        await this.terminate(firstDisposition.reason);
        return;
      }
      if (firstDisposition.kind === 'gap') {
        await this.handleGap(firstDisposition.gap);
        return;
      }
      if (firstDisposition.kind === 'unverifiable') {
        this.resetGap();
        await this.exhaust(firstDisposition.message);
        return;
      }
      if (firstDisposition.kind === 'retry') {
        if (first.kind === 'error') this.resetGap();
        await this.retry();
        return;
      }

      // A present probe breaks a prior missing/not-file streak. It is still
      // required to pass the normal quiet, same-identity growth check below.
      this.resetGap();

      await this.wait(this.options.quietPeriodMs, controller.signal);
      const second = await this.host.probe(controller.signal);
      if (controller.signal.aborted) {
        this.finishCancelled();
        return;
      }
      if (!this.host.isExpectedIdentityCurrent(expected)) {
        this.finishCancelled();
        return;
      }
      const secondDisposition = this.dispositionForProbe(expected, second);
      if (secondDisposition.kind === 'terminal') {
        await this.terminate(secondDisposition.reason);
        return;
      }
      if (secondDisposition.kind === 'gap') {
        await this.handleGap(secondDisposition.gap);
        return;
      }
      if (secondDisposition.kind === 'unverifiable') {
        this.resetGap();
        await this.exhaust(secondDisposition.message);
        return;
      }
      if (secondDisposition.kind === 'retry' || !sameProbe(first, second)) {
        if (second.kind === 'error') this.resetGap();
        await this.retry();
        return;
      }
      if (!this.host.isExpectedIdentityCurrent(expected)) {
        this.finishCancelled();
        return;
      }

      const summary = await this.host.rebuildStable(expected, controller.signal);
      if (controller.signal.aborted) {
        this.finishCancelled();
        return;
      }
      await this.host.publish(summary);
      // Delivery may outlive the recovery window (or an explicit cancel).
      // Never let a late panel acknowledgement turn a retired/cancelled run
      // back into a successful idle state.
      if (
        controller.signal.aborted
        || this.controller !== controller
        || this.isRunRetired()
      ) return;
      this.finishSuccess();
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.deadlineReached) {
          await this.exhaust('Follow recovery stopped after its time budget; use Rebuild when the writer is quiet.');
        } else {
          this.finishCancelled();
        }
        return;
      }
      if (isTerminalRecoveryError(error)) {
        await this.terminate(error.reason);
        return;
      }
      if (isTransientRecoveryError(error)) {
        // Candidate opening is allowed to fail while the writer is still
        // moving. Keep the old generation and retry within the hard bounds.
        await this.retry();
        return;
      }
      this.resetGap();
      await this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private dispositionForProbe(
    expected: FollowRecoveryIdentity,
    probe: FollowRecoveryProbe,
  ):
    | { kind: 'ok'; probe: Extract<FollowRecoveryProbe, { kind: 'present' }> }
    | { kind: 'retry' }
    | { kind: 'gap'; gap: FollowRecoveryGap }
    | { kind: 'terminal'; reason: 'delete' | 'replace' | 'truncate' }
    | { kind: 'unverifiable'; message: string } {
    if (probe.kind === 'missing') return { kind: 'gap', gap: 'missing' };
    if (probe.kind === 'not_file') return { kind: 'gap', gap: 'not_file' };
    if (probe.kind === 'error') {
      return probe.retryable === false
        ? {
            kind: 'unverifiable',
            message: probe.message ?? 'Follow paused because the source could not be inspected; use Rebuild to retry manually.',
          }
        : { kind: 'retry' };
    }
    const identity = compareIdentity(expected, probe.identity);
    if (identity === 'changed') return { kind: 'terminal', reason: 'replace' };
    if (identity === 'unverifiable') {
      return {
        kind: 'unverifiable',
        message: 'Follow paused because the filesystem cannot prove that the path is the same file; use Rebuild to confirm it manually.',
      };
    }
    let expectedSize: bigint;
    try {
      expectedSize = BigInt(expected.sizeBytes);
    } catch {
      return {
        kind: 'unverifiable',
        message: 'Follow paused because the snapshot size is invalid; use Rebuild to confirm it manually.',
      };
    }
    if (probe.sizeBytes < expectedSize) {
      return { kind: 'terminal', reason: 'truncate' };
    }
    if (probe.sizeBytes === expectedSize) {
      return {
        kind: 'unverifiable',
        message: 'Follow paused because the source changed without verified growth; use Rebuild to inspect the replacement safely.',
      };
    }
    return { kind: 'ok', probe };
  }

  /**
   * Atomic-save writers can remove the old path before renaming the stable
   * temporary file into place. One gap is therefore only a retry signal. A
   * second gap after a delayed retry is confirmation; otherwise the bounded
   * retry/deadline path will retire it with the corresponding reason.
   */
  private async handleGap(gap: FollowRecoveryGap): Promise<void> {
    if (this.gap === undefined) {
      this.gap = gap;
      this.gapCount = 1;
    } else {
      this.gapCount += 1;
      // Seeing a non-file at any point is stronger evidence of replacement
      // than a preceding ENOENT. Preserve that reason for mixed transitions.
      if (gap === 'not_file') this.gap = 'not_file';
    }
    if (this.gapCount >= 2) {
      await this.terminate(this.gap === 'missing' ? 'delete' : 'replace');
      return;
    }
    await this.retry(this.options.quietPeriodMs);
  }

  private async retry(minDelayMs = 0): Promise<void> {
    const elapsed = this.timers.now() - this.startedAt;
    if (
      this.disposed
      || this.controller === undefined
      || this.controller.signal.aborted
      || this.attempts >= this.options.maxAttempts
      || elapsed >= this.options.maxWindowMs
    ) {
      await this.exhaust('Follow recovery stopped after its retry budget; use Rebuild when the writer is quiet.');
      return;
    }
    const exponent = Math.max(0, this.attempts - 1);
    const backoff = Math.min(
      this.options.maxDelayMs,
      Math.max(minDelayMs, this.options.initialDelayMs * (2 ** exponent)),
    );
    const jitter = Math.min(1, Math.max(0, this.options.jitter()));
    const delay = minDelayMs > 0
      ? Math.min(this.options.maxDelayMs, Math.max(minDelayMs, Math.round(backoff * (0.75 + 0.5 * jitter))))
      : Math.round(backoff * jitter);
    this.state = 'waiting';
    this.schedule(delay);
  }

  private async wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('follow recovery cancelled');
    await new Promise<void>((resolve, reject) => {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        if (handle !== undefined) this.timers.clearTimeout(handle);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('follow recovery cancelled'));
      };
      handle = this.timers.setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, Math.round(delayMs)));
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async terminate(reason: 'delete' | 'replace' | 'truncate'): Promise<void> {
    this.clearTimers();
    this.controller?.abort();
    this.controller = undefined;
    this.expected = undefined;
    this.pendingEvent = false;
    this.resetGap();
    this.state = 'exhausted';
    try {
      await this.host.invalidate(reason);
    } catch {
      // The source transition is terminal even if all panels were disposed.
    }
  }

  private async exhaust(message: string): Promise<void> {
    if (this.state === 'exhausted' || this.disposed) {
      this.finishCancelled();
      return;
    }
    const gap = this.gap;
    this.clearTimers();
    this.controller?.abort();
    this.controller = undefined;
    this.expected = undefined;
    this.pendingEvent = false;
    this.resetGap();
    this.state = 'exhausted';
    try {
      await this.host.invalidate(gap === undefined
        ? 'unknown'
        : (gap === 'missing' ? 'delete' : 'replace'));
    } catch {
      // Keep the recovery state terminal even if the UI has gone away.
    }
    try {
      await this.host.report(message);
    } catch {
      // Reporting is best effort and must not restart recovery.
    }
  }

  private finishSuccess(): void {
    this.clearTimers();
    this.controller = undefined;
    this.expected = undefined;
    this.gap = undefined;
    this.attempts = 0;
    this.state = 'idle';
    const hadPendingEvent = this.pendingEvent;
    this.pendingEvent = false;
    if (hadPendingEvent) {
      try {
        this.host.scheduleReconcile?.();
      } catch {
        // A disposed host may reject a queued watcher hint. The successful
        // generation has already been published, so do not reopen recovery.
      }
    }
  }

  private async fail(message: string): Promise<void> {
    this.clearTimers();
    this.controller?.abort();
    this.controller = undefined;
    this.expected = undefined;
    this.pendingEvent = false;
    this.gap = undefined;
    this.state = 'exhausted';
    try {
      await this.host.invalidate('unknown');
    } catch {
      // Keep the recovery state terminal even if the UI has gone away.
    }
    try {
      await this.host.report(`Follow recovery failed: ${message}`);
    } catch {
      // Reporting is best effort and must never restart the state machine.
    }
  }

  private finishCancelled(): void {
    this.clearTimers();
    this.controller = undefined;
    this.expected = undefined;
    this.pendingEvent = false;
    if (!this.disposed && this.state !== 'exhausted') this.state = 'idle';
  }

  private clearAttemptTimer(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearAttemptTimer();
    if (this.deadlineTimer !== undefined) {
      this.timers.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
  }

  private resetGap(): void {
    this.gap = undefined;
    this.gapCount = 0;
  }

  private isRunRetired(): boolean {
    return this.state === 'exhausted' || this.disposed;
  }
}

function normalizeOptions(options: FollowRecoveryOptions): Required<FollowRecoveryOptions> {
  const positive = (value: number | undefined, fallback: number): number => (
    value === undefined || !Number.isFinite(value) || value < 1
      ? fallback
      : Math.round(value)
  );
  const quietPeriodMs = positive(options.quietPeriodMs, DEFAULT_FOLLOW_RECOVERY_OPTIONS.quietPeriodMs);
  const initialDelayMs = positive(options.initialDelayMs, DEFAULT_FOLLOW_RECOVERY_OPTIONS.initialDelayMs);
  const maxDelayMs = Math.max(
    initialDelayMs,
    quietPeriodMs,
    positive(options.maxDelayMs, DEFAULT_FOLLOW_RECOVERY_OPTIONS.maxDelayMs),
  );
  const maxWindowMs = Math.max(
    quietPeriodMs + initialDelayMs,
    positive(options.maxWindowMs, DEFAULT_FOLLOW_RECOVERY_OPTIONS.maxWindowMs),
  );
  const maxAttempts = positive(options.maxAttempts, DEFAULT_FOLLOW_RECOVERY_OPTIONS.maxAttempts);
  return {
    quietPeriodMs,
    initialDelayMs,
    maxDelayMs,
    maxWindowMs,
    maxAttempts,
    jitter: options.jitter ?? DEFAULT_FOLLOW_RECOVERY_OPTIONS.jitter,
  };
}

function compareIdentity(
  expected: FollowRecoveryIdentity,
  observed: FollowRecoveryIdentity,
): 'same' | 'changed' | 'unverifiable' {
  if (
    expected.documentId !== observed.documentId
    || expected.uri !== observed.uri
    || expected.generation === ''
    || observed.generation === ''
  ) {
    return expected.documentId === observed.documentId && expected.uri === observed.uri
      ? 'unverifiable'
      : 'changed';
  }
  // A partial or absent file identity is not enough to distinguish a
  // delete/recreate race. Requiring both fields keeps recovery conservative
  // on filesystems that do not expose stable identity metadata.
  const expectedHasIdentity = expected.device !== undefined && expected.inode !== undefined;
  const observedHasIdentity = observed.device !== undefined && observed.inode !== undefined;
  if (!expectedHasIdentity || !observedHasIdentity) return 'unverifiable';
  if (expected.device !== observed.device || expected.inode !== observed.inode) {
    return 'changed';
  }
  return 'same';
}

function sameProbe(
  first: Extract<FollowRecoveryProbe, { kind: 'present' }> | FollowRecoveryProbe,
  second: FollowRecoveryProbe,
): boolean {
  if (first.kind !== 'present' || second.kind !== 'present') return false;
  return compareIdentity(first.identity, second.identity) === 'same'
    && first.sizeBytes === second.sizeBytes
    && first.mtimeNs === second.mtimeNs;
}

export class FollowRecoveryTerminalError extends Error {
  public constructor(public readonly reason: 'delete' | 'replace' | 'truncate') {
    super(`Source ${reason}d while following.`);
    this.name = 'FollowRecoveryTerminalError';
  }
}

/** Errors that are safe to retry while a writer is still moving. */
export class FollowRecoveryTransientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FollowRecoveryTransientError';
  }
}

/**
 * Windows writers can briefly deny metadata/file access while rotating or
 * replacing a log. Keep the platform-specific mapping in one testable helper
 * instead of spreading numeric Win32 checks through the recovery state machine.
 */
export function isTransientFileLockError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown; win32Code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  if (new Set(['EACCES', 'EBUSY', 'EPERM', 'ETXTBSY', 'ERROR_SHARING_VIOLATION', 'ERROR_LOCK_VIOLATION']).has(code)) {
    return true;
  }
  if (candidate.errno === 32 || candidate.errno === 33 || candidate.win32Code === 32 || candidate.win32Code === 33) {
    return true;
  }
  return typeof candidate.message === 'string'
    && /sharing violation|lock violation|resource busy|file is being used/i.test(candidate.message);
}

function isTerminalRecoveryError(error: unknown): error is FollowRecoveryTerminalError {
  return error instanceof FollowRecoveryTerminalError;
}

function isTransientRecoveryError(error: unknown): error is FollowRecoveryTransientError {
  return error instanceof FollowRecoveryTransientError;
}
