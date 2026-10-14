import { describe, expect, it } from 'vitest';
import { parseStartupStageReceipt } from '../../src/extension/startup-stage';
import { EXECUTION_IDENTITY, UNKNOWN_RUNTIME_IDENTITY } from '../../src/shared/execution-identity';

describe('startup stage receipt', () => {
  const identity = {
    documentId: 'document', generation: 'generation', startupId: 'boot-1', executionIdentity: EXECUTION_IDENTITY,
    runtimeIdentity: UNKNOWN_RUNTIME_IDENTITY,
  };

  it('accepts a bounded first page commit, including an empty page', () => {
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed', ...identity, rows: 0 }))
      .toMatchObject({ stage: 'page-committed', rows: 0 });
  });

  it('rejects unknown or unbounded values', () => {
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'painted', ...identity })).toBeUndefined();
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'page-committed', ...identity, rows: 501 })).toBeUndefined();
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', ...identity, rows: 1 })).toBeUndefined();
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', ...identity, startupId: '' })).toBeUndefined();
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', ...identity, epoch: -1 })).toBeUndefined();
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', ...identity, epoch: 1.5 })).toBeUndefined();
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', ...identity, epoch: 2 }))
      .toMatchObject({ epoch: 2 });
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'startup-error', ...identity, message: 'sensitive' }))
      .toEqual({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'startup-error', ...identity });
  });

  it('fails closed when the Webview identity is absent or mismatched', () => {
    const { executionIdentity: _executionIdentity, ...withoutIdentity } = identity;
    expect(parseStartupStageReceipt({ type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', ...withoutIdentity }))
      .toBeUndefined();
    expect(parseStartupStageReceipt({
      type: 'JSONLVIEW_STARTUP_STAGE',
      stage: 'opened-accepted',
      ...identity,
      executionIdentity: { ...EXECUTION_IDENTITY, manifestSha256: 'f'.repeat(64) },
    })).toBeUndefined();
    expect(parseStartupStageReceipt({ ...identity, type: 'JSONLVIEW_STARTUP_STAGE', stage: 'opened-accepted', runtimeIdentity: undefined }))
      .toBeUndefined();
  });
});
