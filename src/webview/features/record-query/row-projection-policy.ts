import type { RowProjectionPlan } from '../../../shared/types';
import { legacyRowProjectionPlan } from '../../../shared/row-projection';
import type { WorkspaceTab } from '../../state';

export function rowProjectionPlanForView(
  tab: WorkspaceTab,
  displayMode: 'table' | 'conversation',
  profileId?: string,
): RowProjectionPlan {
  const legacy = legacyRowProjectionPlan(profileId);
  return {
    conversation: displayMode === 'conversation',
    dataset: tab === 'insights' && legacy.dataset,
  };
}
