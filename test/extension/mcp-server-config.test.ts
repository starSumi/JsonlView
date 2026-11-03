import { describe, expect, it } from 'vitest';
import { parseMcpServerLimits } from '../../src/extension/mcp-server-config';

describe('MCP stdio server limits', () => {
  it('uses bounded defaults when the client does not configure limits', () => {
    expect(parseMcpServerLimits({})).toEqual({ maxConcurrency: 2, budgetMs: 3_000 });
  });

  it('accepts explicitly configured limits at the supported boundaries', () => {
    expect(parseMcpServerLimits({ JSONLVIEW_MCP_MAX_CONCURRENCY: '1', JSONLVIEW_MCP_BUDGET_MS: '1' }))
      .toEqual({ maxConcurrency: 1, budgetMs: 1 });
    expect(parseMcpServerLimits({ JSONLVIEW_MCP_MAX_CONCURRENCY: '8', JSONLVIEW_MCP_BUDGET_MS: '60000' }))
      .toEqual({ maxConcurrency: 8, budgetMs: 60_000 });
  });

  it.each([
    ['JSONLVIEW_MCP_MAX_CONCURRENCY', '0'],
    ['JSONLVIEW_MCP_MAX_CONCURRENCY', '9'],
    ['JSONLVIEW_MCP_MAX_CONCURRENCY', '2.5'],
    ['JSONLVIEW_MCP_BUDGET_MS', '0'],
    ['JSONLVIEW_MCP_BUDGET_MS', '60001'],
    ['JSONLVIEW_MCP_BUDGET_MS', '3s'],
    ['JSONLVIEW_MCP_BUDGET_MS', ''],
  ])('rejects malformed or out-of-range %s', (name, value) => {
    expect(() => parseMcpServerLimits({ [name]: value })).toThrow(name);
  });
});
