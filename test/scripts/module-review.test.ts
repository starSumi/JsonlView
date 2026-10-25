import { describe, expect, it } from 'vitest';

import { parseArgs, parseTypeScriptMetrics } from '../../scripts/module-review.mjs';

describe('module review report', () => {
  it('keeps base/head and worktree scope explicit', () => {
    expect(parseArgs(['--', '--base', 'base-ref', '--head', 'head-ref', '--no-worktree', '--json'])).toEqual({
      all: false,
      json: true,
      base: 'base-ref',
      head: 'head-ref',
      includeWorktree: false,
    });
  });

  it('extracts imports, functions, and branch signals through the parser', () => {
    const metrics = parseTypeScriptMetrics('fixture.ts', [
      "import value from './value.js';",
      'export function render(input: string) {',
      '  if (input && value) return () => input;',
      '  return value;',
      '}',
    ].join('\n'));

    expect(metrics.parseError).toBeUndefined();
    expect(metrics.functionCount).toBe(2);
    expect(metrics.directFanOut).toBe(1);
    expect(metrics.branchCount).toBe(2);
    expect(metrics.maxFunctionLines).toBe(4);
  });

  it('reports parse failures instead of silently undercounting a source file', () => {
    const metrics = parseTypeScriptMetrics('fixture.ts', 'export function {');
    expect(metrics.parseError).toEqual(expect.any(String));
  });
});
