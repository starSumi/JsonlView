import type { NavigationProvider } from './navigation-contract';
import { ReadOnlyNavigationFacade, type NavigationClock } from './read-only-navigation';

export interface NavigationExperimentConfig {
  /** Must be explicitly true after a user gesture or equivalent host policy. */
  enabled: boolean;
  allowedSourceIds: readonly string[];
}

export interface NavigationExperimentOptions extends NavigationExperimentConfig {
  providers: readonly NavigationProvider[];
  clock?: NavigationClock;
}

/**
 * Host integration seam. Disabled configuration returns without constructing a
 * facade, reading a provider, touching the filesystem, or starting a process.
 */
export function createOptInNavigationFacade(
  options: NavigationExperimentOptions,
): ReadOnlyNavigationFacade | undefined {
  if (!options.enabled) return undefined;
  if (options.allowedSourceIds.length === 0) throw new Error('Navigation requires an explicit source allowlist.');
  return new ReadOnlyNavigationFacade(options);
}
