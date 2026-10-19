import type { NavigationEntity, NavigationProvider, NavigationSnapshot } from '../navigation-contract';

export const SESSION_NAVIGATOR_SCHEMA_VERSION = 1 as const;

export type SessionNavigatorProviderId = 'codex' | 'claude' | 'pi' | 'kimi' | 'gemini' | 'opencode' | 'agentsview' | 'generic';

/** Provider ids whose source is read through the bounded generic file adapter. */
export const GENERIC_FILE_PROVIDER_IDS = ['generic', 'gemini', 'opencode', 'agentsview'] as const;

export type DetectedAgentProviderId = Exclude<SessionNavigatorProviderId, 'generic'>;

export function isGenericFileProvider(provider: SessionNavigatorProviderId): boolean {
  return (GENERIC_FILE_PROVIDER_IDS as readonly string[]).includes(provider);
}

export function sessionNavigatorProviderLabel(provider: SessionNavigatorProviderId): string {
  switch (provider) {
    case 'codex': return 'Codex';
    case 'claude': return 'Claude';
    case 'pi': return 'pi';
    case 'kimi': return 'Kimi Code';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'OpenCode';
    case 'agentsview': return 'AgentsView';
    case 'generic': return 'Generic JSONL';
  }
}
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
  scan(signal: AbortSignal, budget: SessionNavigatorBudget, expectedFingerprint?: string): Promise<SessionNavigatorScanResult>;
  /** Read one bounded page after `cursor`; callers may persist and resume it later. */
  scanPage?(signal: AbortSignal, budget: SessionNavigatorBudget, cursor?: string, expectedFingerprint?: string): Promise<SessionNavigatorScanResult>;
  probe(signal: AbortSignal): Promise<string>;
}
