export interface McpServerLimits {
  readonly maxConcurrency: number;
  readonly budgetMs: number;
}

const DEFAULT_MAX_CONCURRENCY = 2;
const MAX_MAX_CONCURRENCY = 8;
const DEFAULT_BUDGET_MS = 3_000;
const MAX_BUDGET_MS = 60_000;

/** Parse only the two bounded limits exposed to explicitly launched stdio clients. */
export function parseMcpServerLimits(environment: Readonly<Record<string, string | undefined>>): McpServerLimits {
  return {
    maxConcurrency: readBoundedInteger(environment, 'JSONLVIEW_MCP_MAX_CONCURRENCY', DEFAULT_MAX_CONCURRENCY, 1, MAX_MAX_CONCURRENCY),
    budgetMs: readBoundedInteger(environment, 'JSONLVIEW_MCP_BUDGET_MS', DEFAULT_BUDGET_MS, 1, MAX_BUDGET_MS),
  };
}

function readBoundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new Error(`${name} must be a decimal integer from ${minimum} through ${maximum}.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a decimal integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}
