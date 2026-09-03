export type EngineErrorCode =
  | 'ABORTED'
  | 'DISPOSED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RECORD_REF'
  | 'NOT_A_FILE'
  | 'QUEUE_FULL'
  | 'SOURCE_CHANGED'
  | 'STALE_GENERATION'
  | 'UNEXPECTED_EOF';

export class JsonlEngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonlEngineError';
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof JsonlEngineError && error.code === 'ABORTED';
}
