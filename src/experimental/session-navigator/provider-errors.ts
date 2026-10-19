export class SessionSourceChangedError extends Error {
  public readonly code = 'SESSION_SOURCE_CHANGED';

  public constructor() {
    super('Session source changed while loading a page. Refresh the source before loading more.');
    this.name = 'SessionSourceChangedError';
  }
}

export function isSessionSourceChangedError(error: unknown): error is SessionSourceChangedError {
  return error instanceof SessionSourceChangedError
    || (error instanceof Error && 'code' in error && error.code === 'SESSION_SOURCE_CHANGED');
}
