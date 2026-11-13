import type { RowProjectionPlan } from './shared-types.js';

export function isRowProjectionPlan(value: unknown): value is RowProjectionPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return Object.keys(plan).length === 2
    && typeof plan.conversation === 'boolean'
    && typeof plan.dataset === 'boolean';
}

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

