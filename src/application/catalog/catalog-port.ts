import type {
  CatalogAppendGuard,
  CatalogChildrenPage,
  CatalogChildrenPageOptions,
  CatalogCheckpoint,
  CatalogContinuationExpectation,
  CatalogReplaceGuard,
  CatalogEntity,
  CatalogNavigatorSourceSetting,
  CatalogProviderId,
  CatalogSnapshot,
  CatalogStoredSnapshot,
  CatalogSortKey,
  CatalogSourceInput,
  CatalogSourceMetadata,
  CatalogSourcePageState,
  CatalogSourceSummary,
} from './catalog-model';

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

/**
 * Complete persistence contract for the local Session Navigator catalog.
 * Implementations own their storage lifecycle; callers see only bounded,
 * metadata-only projections and compare-and-swap continuation operations.
 */
export interface SessionCatalogPort extends CatalogPort {
  readonly path: string;
  syncSources(settings: readonly CatalogNavigatorSourceSetting[]): void;
  listSources(): readonly CatalogSourceSummary[];
  getSourceRoot(sourceId: string): string | undefined;
  getSourceProvider(sourceId: string): CatalogProviderId | undefined;
  getFingerprint(sourceId: string): string | undefined;
  getSourcePageState(sourceId: string): CatalogSourcePageState | undefined;
  getChildren(sourceId: string, parentNativeId?: string, sortKey?: CatalogSortKey): readonly CatalogEntity[];
  getChildrenPage(sourceId: string, parentNativeId?: string, sortKey?: CatalogSortKey, options?: CatalogChildrenPageOptions): CatalogChildrenPage;
  hasChildren(sourceId: string, nativeId: string): boolean;
  setProductTitle(sourceId: string, nativeId: string, title: string): void;
  clearProductTitle(sourceId: string, nativeId: string): void;
  getLocation(intent: { readonly sourceId: string; readonly generation: string; readonly nativeId: string }): {
    readonly nativeId: string;
    readonly relativePath: string;
    readonly rowOrdinal: string;
  } | undefined;
  getSnapshot(sourceId: string): CatalogStoredSnapshot | undefined;
  appendSnapshot(sourceId: string, page: CatalogSnapshot, fingerprint: string, guard?: CatalogAppendGuard): CatalogStoredSnapshot;
  replaceSnapshot(sourceId: string, snapshot: CatalogSnapshot, fingerprint: string, guard?: CatalogReplaceGuard): CatalogStoredSnapshot;
  markUpdateAvailable(sourceId: string, available: boolean): void;
  invalidateContinuationIfCurrent(sourceId: string, expected: CatalogContinuationExpectation): boolean;
  close(): void;
}
