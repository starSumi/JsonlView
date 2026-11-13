/** Compatibility surface; serializable DTOs are canonically owned by shared/contracts/navigation. */
export * from '../shared/contracts/navigation';

import type { NavigationBudget, NavigationSnapshot } from '../shared/contracts/navigation';

/** Effectful provider port remains with the experimental navigation adapter. */
export interface NavigationProvider {
  readonly sourceId: string;
  readSnapshot(signal: AbortSignal, budget: Required<NavigationBudget>): Promise<NavigationSnapshot>;
}
