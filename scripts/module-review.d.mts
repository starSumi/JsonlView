export interface ModuleReviewArgs {
  readonly all: boolean;
  readonly json: boolean;
  readonly base: string | undefined;
  readonly head: string;
  readonly includeWorktree: boolean;
}

export interface ModuleSourceMetrics {
  readonly functionCount: number;
  readonly maxFunctionLines: number;
  readonly branchCount: number;
  readonly directFanOut: number;
  readonly imports: readonly string[];
  readonly parseDiagnostics: readonly string[];
  readonly parseError?: string;
}

export interface ModuleReviewEntry {
  readonly path: string;
  readonly lines: number;
  readonly bytes: number;
  readonly functionCount: number;
  readonly maxFunctionLines: number;
  readonly branchCount: number;
  readonly directFanOut: number;
  readonly directFanIn: number;
  readonly changedLines: number;
  readonly recentCommits: number;
  readonly parseDiagnostics: readonly string[];
  readonly parseError?: string;
  readonly priority: number;
  readonly level: string;
  readonly reasons: readonly string[];
  readonly reviewRequired: boolean;
}

export interface ModuleReviewReport {
  readonly schemaVersion: number;
  readonly base: string | null;
  readonly head: string;
  readonly resolvedBase: string | null;
  readonly resolvedHead: string;
  readonly revision: {
    readonly base: { readonly requested: string | null; readonly resolved: string | null };
    readonly head: { readonly requested: string; readonly resolved: string };
  };
  readonly includeWorktree: boolean;
  readonly dependencyGraph: { readonly scope: string; readonly fanOutScope: string };
  readonly scope: string;
  readonly thresholds: unknown;
  readonly entries: readonly ModuleReviewEntry[];
  readonly reviewRequired: readonly string[];
}

export function parseArgs(argv: readonly string[]): ModuleReviewArgs;
export function parseTypeScriptMetrics(path: string, sourceText: string): ModuleSourceMetrics;
export function buildReport(options?: {
  readonly directory?: string;
  readonly base?: string;
  readonly head?: string;
  readonly includeWorktree?: boolean;
  readonly all?: boolean;
}): Promise<ModuleReviewReport>;
