import type { RawExportIntent } from './intent';
import { createScopedRawSpool, SCOPED_RAW_EXPORT_LIMITS, type ScopedRawSpoolRequest } from './scoped-spool';
import { exportRawJsonl, type RawJsonlSourceSnapshot } from './jsonl';
import { RawExportOperations, type RawExportRecovery } from './operations';
import { observeRawExportSource } from './source-observation';

export interface ScopedRawExportRequest extends Omit<ScopedRawSpoolRequest, 'spoolPath'> {
  readonly destinationPath: string;
}

/** Caller can always inspect the Host-issued operation after any failure. */
export class ScopedRawExportError extends Error {
  public readonly requestId: string;
  public constructor(intent: RawExportIntent, cause?: unknown) {
    super('Scoped raw export did not settle. Inspect operation ' + intent.requestId + ' before retrying.', { cause });
    this.name = 'ScopedRawExportError';
    this.requestId = intent.requestId;
  }
}

export async function exportScopedRawJsonl(request: ScopedRawExportRequest, operations: RawExportOperations): Promise<RawExportRecovery> {
  const cancellation = new AbortController();
  const abort = (): void => cancellation.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) abort();
  const timer = setTimeout(abort, SCOPED_RAW_EXPORT_LIMITS.deadlineMs);
  try {
    if (cancellation.signal.aborted || !await request.authorize()) throw new Error('Export authorization unavailable.');
    const sourceObservation = request.sourceObservation ?? await observeRawExportSource(request.sourcePath, request.intent);
    const operation = await operations.admit(request.intent, request.destinationPath, sourceObservation);
    const spool = await createScopedRawSpool({ ...request, sourceObservation, spoolPath: operation.spoolPath, signal: cancellation.signal });
    await operations.recordSpool(request.intent.requestId, operation.spoolPath, spool);
    const source: RawJsonlSourceSnapshot = {
      sourceId: request.intent.binding.documentId, documentId: request.intent.binding.documentId,
      generation: request.intent.binding.generation, authorizationEpoch: String(request.intent.binding.epoch),
      byteLength: spool.byteLength, sha256: spool.sha256,
    };
    await exportRawJsonl({ source, destinationPath: operation.destinationPath,
      maxBytes: BigInt(SCOPED_RAW_EXPORT_LIMITS.maxOutputBytes), signal: cancellation.signal }, {
      authorizeAndResolveSource: async () => await request.authorize()
        ? { authorization: 'authorized', sourcePath: operation.spoolPath, snapshot: source } : undefined,
      onPrepared: (prepared) => operations.prepare(request.intent.requestId, prepared),
      retainPreparedTemporary: true,
    });
    return await operations.inspect(request.intent.requestId);
  } catch (error) { throw new ScopedRawExportError(request.intent, error); }
  finally { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
}
