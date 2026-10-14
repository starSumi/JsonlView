import { describe, expect, it } from 'vitest';
import { parseStartupStageReceipt } from '../../src/extension/startup-stage';

describe('startup stage receipt', () => {
  const identity = { documentId: 'document', generation: 'generation', startupId: 'boot-1' };

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
});
