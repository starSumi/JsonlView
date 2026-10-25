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
  readonly parseError?: string;
}

export function parseArgs(argv: readonly string[]): ModuleReviewArgs;
export function parseTypeScriptMetrics(path: string, sourceText: string): ModuleSourceMetrics;
