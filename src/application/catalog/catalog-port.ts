import type { CatalogCheckpoint, CatalogSourceInput, CatalogSourceMetadata } from './catalog-model';

/**
 * The persistence boundary for source metadata. Implementations may use
 * SQLite, but callers do not depend on a database driver or filesystem API.
 * Entity snapshots remain behind the existing bounded navigator API until the
 * provider scan contract is promoted.
 */
export interface CatalogPort {
  reconcileSourceMetadata(sources: readonly CatalogSourceInput[], navigatorEnabled: boolean): void;
  listSourceMetadata(): readonly CatalogSourceMetadata[];
  getSourceMetadata(sourceId: string): CatalogSourceMetadata | undefined;
  getCheckpoint(sourceId: string, plane: 'metadata' | 'entity'): CatalogCheckpoint | undefined;
}
