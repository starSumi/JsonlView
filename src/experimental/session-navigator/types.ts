import type { NavigationEntity, NavigationProvider, NavigationSnapshot } from '../navigation-contract';

export const SESSION_NAVIGATOR_SCHEMA_VERSION = 1 as const;

export type SessionNavigatorProviderId = 'codex' | 'claude' | 'pi' | 'generic';
export type SessionNavigatorSortKey = 'activity' | 'created' | 'title';

export interface AuthorizedSourceSetting {
  readonly provider: SessionNavigatorProviderId;
  readonly rootUri: string;
  readonly stateRootUri?: string;
}

export interface NavigatorSourceSummary {
  readonly sourceId: string;
  readonly provider: SessionNavigatorProviderId;
  readonly label: string;
  readonly generation: string;
  readonly capturedAt?: string;
  readonly entityCount: number;
  readonly relationCount: number;
  readonly updateAvailable: boolean;
  readonly truncated?: boolean;
  readonly nextCursor?: string;
  readonly lastActivityAt?: string;
}

export interface NavigatorLocation {
  readonly nativeId: string;
  readonly relativePath: string;
  readonly rowOrdinal: string;
}

export interface NavigatorSnapshot extends NavigationSnapshot {
  readonly schemaVersion: typeof SESSION_NAVIGATOR_SCHEMA_VERSION;
  readonly provider: SessionNavigatorProviderId;
  readonly locations: readonly NavigatorLocation[];
  readonly nextCursor?: string;
}

export interface NavigatorEntity extends NavigationEntity {
  readonly generation: string;
  readonly provider: SessionNavigatorProviderId;
}

export interface RevealIntent {
  readonly sourceId: string;
  readonly catalogGeneration: string;
  readonly nativeId: string;
  readonly anchorOrdinal: string;
}

export interface SessionNavigatorBudget {
  readonly maxEntities: number;
  readonly maxRelations: number;
  readonly maxRecords: number;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxMilliseconds: number;
}

export const DEFAULT_SESSION_NAVIGATOR_BUDGET: SessionNavigatorBudget = Object.freeze({
  maxEntities: 2_000,
  maxRelations: 4_000,
  maxRecords: 4_000,
  maxFiles: 64,
  maxBytes: 16 * 1024 * 1024,
  maxMilliseconds: 5_000,
});

export interface SessionNavigatorScanResult {
  readonly snapshot: NavigatorSnapshot;
  readonly fingerprint: string;
  /** Opaque continuation for a bounded provider page. Never contains source paths or bodies. */
  readonly nextCursor?: string;
}

export interface SessionNavigatorProvider extends NavigationProvider {
  readonly provider: SessionNavigatorProviderId;
  readonly rootUri: string;
  scan(signal: AbortSignal, budget: SessionNavigatorBudget): Promise<SessionNavigatorScanResult>;
  /** Read one bounded page after `cursor`; callers may persist and resume it later. */
  scanPage?(signal: AbortSignal, budget: SessionNavigatorBudget, cursor?: string): Promise<SessionNavigatorScanResult>;
  probe(signal: AbortSignal): Promise<string>;
}
