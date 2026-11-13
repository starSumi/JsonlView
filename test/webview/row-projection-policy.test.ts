import { describe, expect, it } from 'vitest';
import { legacyRowProjectionPlan, rowProjectionPlanCovers, resolveRowProjectionPlan } from '../../src/shared/row-projection';
import { rowProjectionPlanForView } from '../../src/webview/features/record-query/row-projection-policy';

describe('row projection policy', () => {
  it('requests only the optional scenes consumed by the active view', () => {
    expect(rowProjectionPlanForView('table', 'table', 'generic'))
      .toEqual({ conversation: false, dataset: false });
    expect(rowProjectionPlanForView('timeline', 'table', 'generic'))
      .toEqual({ conversation: false, dataset: false });
    expect(rowProjectionPlanForView('insights', 'table', 'generic'))
      .toEqual({ conversation: false, dataset: true });
    expect(rowProjectionPlanForView('insights', 'conversation', 'generic'))
      .toEqual({ conversation: true, dataset: true });
    expect(rowProjectionPlanForView('insights', 'table', 'codex-rollout'))
      .toEqual({ conversation: false, dataset: false });
  });

  it('treats legacy pages as fully covered and compares explicit page capabilities', () => {
    const legacy = legacyRowProjectionPlan('generic');
    expect(legacy).toEqual({ conversation: true, dataset: true });
    expect(rowProjectionPlanCovers(legacy, { conversation: false, dataset: true })).toBe(true);
    expect(rowProjectionPlanCovers({ conversation: false, dataset: false },
      { conversation: false, dataset: true })).toBe(false);
    expect(resolveRowProjectionPlan(undefined, 'codex-rollout'))
      .toEqual({ conversation: true, dataset: false });
  });
});
