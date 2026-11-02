import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildReport, parseArgs, parseTypeScriptMetrics } from '../../scripts/module-review.mjs';

const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('accepts package-manager argument separators between script options', () => {
    expect(parseArgs(['--all', '--', '--json'])).toEqual({
      all: true,
      json: true,
      base: undefined,
      head: 'HEAD',
      includeWorktree: true,
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

  it('records Babel parser diagnostics produced during error recovery', () => {
    const metrics = parseTypeScriptMetrics('fixture.ts', 'class Duplicate { #value; #value; }');
    expect(metrics.parseError).toContain('Duplicate private name');
    expect(metrics.parseDiagnostics).toEqual(expect.arrayContaining([expect.stringContaining('Duplicate private name')]));
  });

  it('anchors reports to the supplied product repository root', async () => {
    await expect(buildReport({ directory: resolve(productRoot, 'src'), includeWorktree: false })).rejects.toThrow(/must be the product repository root/u);
    const report = await buildReport({ directory: productRoot, includeWorktree: true });
    expect(report.resolvedHead).toMatch(/^[0-9a-f]{40}$/u);
    expect(report.entries.every((entry) => entry.path.startsWith('src/'))).toBe(true);
    expect(report.entries.some((entry) => entry.path.startsWith('../'))).toBe(false);
  });

  it('reports the core-file line-count ratchet and keeps the current baseline bounded', async () => {
    const report = await buildReport({ directory: productRoot, includeWorktree: true, all: true });
    expect(report.ratchet?.enabled).toBe(true);
    expect(report.ratchet?.maxGrowthLines).toBe(0);
    expect(report.ratchet?.violations).toEqual([]);
    expect(report.ratchet?.trackedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/engine/jsonl-engine.ts', baselineLines: 2270, currentLines: 2270, lineDelta: 0, violation: false }),
      expect.objectContaining({ path: 'src/webview/state.ts', baselineLines: 960, currentLines: 960, lineDelta: 0, violation: false }),
      expect.objectContaining({ path: 'src/webview/features/record-query/row-query-controller.ts', baselineLines: 864, currentLines: 864, lineDelta: 0, violation: false }),
      expect.objectContaining({ path: 'src/webview/App.tsx', baselineLines: 1486, currentLines: 1486, lineDelta: 0, violation: false }),
    ]));
  });

  it('rejects an invalid head revision instead of silently producing a report', async () => {
    await expect(buildReport({ directory: productRoot, head: 'refs/heads/does-not-exist', includeWorktree: false })).rejects.toThrow(/--head revision does not resolve.*does-not-exist/u);
  });

  it('rejects a no-worktree report whose requested head is not the clean checkout', async () => {
    await expect(buildReport({ directory: productRoot, head: 'HEAD^', includeWorktree: false })).rejects.toThrow(/--no-worktree requires checkout HEAD/u);
  });
});
