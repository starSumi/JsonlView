import { describe, expect, it } from 'vitest';
import { captureRuntimeExecutionIdentity } from '../../src/extension/execution-runtime';
import { parseStartupStageReceipt } from '../../src/extension/startup-stage';
import { EXECUTION_IDENTITY, isExecutionIdentity, type ExecutionIdentity } from '../../src/shared/execution-identity';
import { JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION } from '../../src/shared/contracts/errors';

describe('runtime execution identity', () => {
  const productionBundle: ExecutionIdentity = { ...EXECUTION_IDENTITY, buildMode: 'production' };

  it.each([[1, 'production'], [2, 'development'], [3, 'test']] as const)(
    'records host mode %i independently of a production build', (extensionMode, expectedMode) => {
      const runtimeIdentity = captureRuntimeExecutionIdentity({
        extensionMode, extension: { id: 'Sumi-Sophia.jsonl-view', packageJSON: { version: '0.2.11' } },
      } as never);
      const receipt = { type: 'JSONLVIEW_STARTUP_STAGE', startupStageProtocolVersion: JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION,
        stage: 'opened-accepted',
        documentId: 'document', generation: 'generation', startupId: 'boot', executionIdentity: productionBundle, runtimeIdentity };
      expect(runtimeIdentity.extensionMode).toBe(expectedMode);
      expect(Object.isFrozen(runtimeIdentity)).toBe(true);
      expect(parseStartupStageReceipt(receipt, productionBundle, runtimeIdentity)).toEqual(receipt);
      expect(parseStartupStageReceipt({ ...receipt, runtimeIdentity: { ...runtimeIdentity, extensionMode: 'unknown' } },
        productionBundle, runtimeIdentity)).toBeUndefined();
    },
  );

  it('keeps an absent or invalid runtime mode unknown instead of deriving it from the bundle', () => {
    for (const extensionMode of [undefined, 0, 4, 'production']) {
      const runtime = captureRuntimeExecutionIdentity({ extensionMode,
        extension: { id: 'Sumi-Sophia.jsonl-view', packageJSON: { version: '0.2.11' } } } as never);
      expect(runtime.extensionMode).toBe('unknown');
    }
    expect(captureRuntimeExecutionIdentity({} as never)).toEqual({
      extensionId: 'unknown', extensionVersion: 'unknown', extensionMode: 'unknown',
    });
  });

  it('rejects extra identity fields and path-shaped versions', () => {
    expect(isExecutionIdentity({ ...EXECUTION_IDENTITY, path: 'private' })).toBe(false);
    expect(isExecutionIdentity({ ...EXECUTION_IDENTITY, extensionVersion: 'C:/private/source' })).toBe(false);
  });
});
