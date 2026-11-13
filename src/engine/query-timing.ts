import type { JsonlEngineQueueOperation, JsonlQueryTiming } from './jsonl-engine-types';
import type { ReadWaitObserver } from './snapshot-fingerprint';

type QueryPhase = 'indexWorkMs' | 'readWaitMs' | 'parseMs' | 'projectionMs' | 'snapshotCheckMs';

export type QueryTimingContext = QueryTimingAccumulator | undefined;

export class QueryTimingAccumulator {
  private readCalls = 0;
  private readBytes = 0;
  private readMaxWaitMs = 0;
  private readonly phases: Record<QueryPhase, number> = {
    indexWorkMs: 0,
    readWaitMs: 0,
    parseMs: 0,
    projectionMs: 0,
    snapshotCheckMs: 0,
  };

  public add(phase: QueryPhase, elapsedMs: number): void {
    this.phases[phase] += elapsedMs;
  }

  public addRead(elapsedMs: number, bytesRead: number): void {
    this.add('readWaitMs', elapsedMs);
    this.readCalls = Math.min(Number.MAX_SAFE_INTEGER, this.readCalls + 1);
    this.readBytes = Math.min(Number.MAX_SAFE_INTEGER, this.readBytes + bytesRead);
    this.readMaxWaitMs = Math.max(this.readMaxWaitMs, elapsedMs);
  }

  public measure<T>(phase: QueryPhase, operation: () => T): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.add(phase, performance.now() - startedAt);
    }
  }

  public async measureAsync<T>(phase: QueryPhase, operation: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.add(phase, performance.now() - startedAt);
    }
  }

  public toTiming(
    queueWaitMs: number,
    engineExecMs: number,
    queueBlockedBy: JsonlEngineQueueOperation,
  ): JsonlQueryTiming {
    const rounded = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
    return {
      queueWaitMs: rounded(queueWaitMs),
      engineExecMs: rounded(engineExecMs),
      queueBlockedBy,
      indexWorkMs: rounded(this.phases.indexWorkMs),
      readWaitMs: rounded(this.phases.readWaitMs),
      readCalls: this.readCalls,
      readBytes: this.readBytes,
      readMaxWaitMs: rounded(this.readMaxWaitMs),
      parseMs: rounded(this.phases.parseMs),
      projectionMs: rounded(this.phases.projectionMs),
      snapshotCheckMs: rounded(this.phases.snapshotCheckMs),
    };
  }
}

export function withTrace<T>(timing: QueryTimingContext, spanName: QueryPhase, operation: () => T): T {
  return timing === undefined ? operation() : timing.measure(spanName, operation);
}

export function withAsyncTrace<T>(
  timing: QueryTimingContext,
  spanName: QueryPhase,
  operation: () => Promise<T>,
): Promise<T> {
  return timing === undefined ? operation() : timing.measureAsync(spanName, operation);
}

export function createReadWaitObserver(timing: QueryTimingContext): ReadWaitObserver | undefined {
  return timing === undefined ? undefined : (elapsedMs, bytesRead) => timing.addRead(elapsedMs, bytesRead);
}
