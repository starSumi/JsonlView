import { basename, dirname } from 'node:path';
import type { NavigatorLocation, SessionNavigatorProviderId, SessionNavigatorScanResult } from './types';

export interface SessionCatalogStrategy {
  readonly provider: SessionNavigatorProviderId;
  readonly refreshPriority: number;
  readonly initialLoad: {
    readonly emptyTruncatedRetry: { readonly maxAttempts: number; readonly statusDetail: string } | undefined;
    /** Includes the initial scan page. */
    readonly maximumPages: number;
  };
  isRetryableEmptyScan(scan: SessionNavigatorScanResult): boolean;
  resolveLocationRoot(configuredRootPath: string): string;
  allowsStaleLocation(location: NavigatorLocation): boolean;
}

const noRetry = undefined;
const strictAnchor = (_location: NavigatorLocation): boolean => false;
const sessionStartAnchor = (location: NavigatorLocation): boolean => location.rowOrdinal === '0';
const identityRoot = (rootPath: string): string => rootPath;
const retryableEmptyTruncated = (scan: SessionNavigatorScanResult): boolean => scan.snapshot.entities.length === 0 && scan.snapshot.truncated;

const strategies = {
  codex: {
    provider: 'codex',
    refreshPriority: 10,
    initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 },
    isRetryableEmptyScan: (_scan: SessionNavigatorScanResult) => false,
    resolveLocationRoot: (rootPath: string) => /^state(?:_\d+)?\.sqlite$/iu.test(basename(rootPath)) ? dirname(rootPath) : rootPath,
    allowsStaleLocation: sessionStartAnchor,
  },
  claude: {
    provider: 'claude',
    refreshPriority: 10,
    initialLoad: { emptyTruncatedRetry: { maxAttempts: 2, statusDetail: 'Waiting for Claude metadata…' }, maximumPages: 2 },
    isRetryableEmptyScan: retryableEmptyTruncated,
    resolveLocationRoot: identityRoot,
    allowsStaleLocation: sessionStartAnchor,
  },
  pi: { provider: 'pi', refreshPriority: 10, initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 }, isRetryableEmptyScan: () => false, resolveLocationRoot: identityRoot, allowsStaleLocation: sessionStartAnchor },
  kimi: { provider: 'kimi', refreshPriority: 0, initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 }, isRetryableEmptyScan: () => false, resolveLocationRoot: identityRoot, allowsStaleLocation: sessionStartAnchor },
  gemini: { provider: 'gemini', refreshPriority: 10, initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 }, isRetryableEmptyScan: () => false, resolveLocationRoot: identityRoot, allowsStaleLocation: strictAnchor },
  opencode: { provider: 'opencode', refreshPriority: 10, initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 }, isRetryableEmptyScan: () => false, resolveLocationRoot: identityRoot, allowsStaleLocation: strictAnchor },
  agentsview: { provider: 'agentsview', refreshPriority: 10, initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 }, isRetryableEmptyScan: () => false, resolveLocationRoot: identityRoot, allowsStaleLocation: strictAnchor },
  generic: { provider: 'generic', refreshPriority: 10, initialLoad: { emptyTruncatedRetry: noRetry, maximumPages: 1 }, isRetryableEmptyScan: () => false, resolveLocationRoot: identityRoot, allowsStaleLocation: strictAnchor },
} satisfies Record<SessionNavigatorProviderId, SessionCatalogStrategy>;

/** Provider-specific catalog behavior is selected once by source identity, outside the tree projection. */
export function getSessionCatalogStrategy(provider: SessionNavigatorProviderId): SessionCatalogStrategy {
  return strategies[provider];
}
