import type { RowProjectionPlan } from './contracts/query';

export { isRowProjectionPlan } from './contracts/query';

export function legacyRowProjectionPlan(profileId?: string): RowProjectionPlan {
  return { conversation: true, dataset: profileId === undefined || profileId === 'generic' };
}

export function resolveRowProjectionPlan(
  requested: RowProjectionPlan | undefined,
  profileId?: string,
): RowProjectionPlan {
  return requested === undefined ? legacyRowProjectionPlan(profileId) : { ...requested };
}

export function rowProjectionPlanCovers(
  available: RowProjectionPlan,
  required: RowProjectionPlan,
): boolean {
  return (!required.conversation || available.conversation)
    && (!required.dataset || available.dataset);
}
