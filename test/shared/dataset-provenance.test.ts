import { describe, expect, it } from 'vitest';
import { terminalDatasetProvenance } from '../../src/profiles/dataset-runtime';
import { isDatasetRuntimeProvenance } from '../../src/shared/transport/dataset-provenance';

describe('dataset terminal metadata transport', () => {
  it.each(['failed', 'timeout', 'cancelled', 'disabled'] as const)('admits the closed %s status without invented sample evidence', (status) => {
    const value = terminalDatasetProvenance(status, 'head-hydration');
    expect(isDatasetRuntimeProvenance(value)).toBe(true);
    expect(value).not.toHaveProperty('shape');
    expect(value).not.toHaveProperty('coverage');
    expect(value).not.toHaveProperty('adapterId');
  });

  it.each([
    { extra: { raw: 'private value' } },
    { extra: { coverage: { sampledRecords: 1 } } },
    { extra: { terminal: { stage: 'head-hydration', code: 'deadline_exceeded', retryable: false, action: 'none' } } },
    { extra: { terminal: { stage: 'head-hydration', code: 'deadline_exceeded', retryable: true, action: 'reload', error: 'private error' } } },
    { extra: { terminal: { stage: 'unknown', code: 'deadline_exceeded', retryable: true, action: 'reload' } } },
  ])('rejects terminal payload growth and inconsistent recovery semantics', ({ extra }) => {
    expect(isDatasetRuntimeProvenance({ ...terminalDatasetProvenance('timeout', 'head-hydration'), ...extra })).toBe(false);
  });

  it('rejects disabled metadata claiming that sampling began', () => {
    const value = terminalDatasetProvenance('disabled', 'not-started');
    expect(isDatasetRuntimeProvenance({ ...value, terminal: { stage: 'head-inspection', code: 'auto_detection_disabled', retryable: false, action: 'enable-auto-detection' } })).toBe(false);
  });
});
