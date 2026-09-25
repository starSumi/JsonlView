// @ts-expect-error JavaScript CLI module intentionally does not emit declarations.
import { findInstalledTargetConflicts, parseArgs, sourceStateFromGitOutputs } from '../../scripts/sync-local-extension.mjs';
import { describe, expect, it } from 'vitest';

describe('local extension sync arguments', () => {
  it('accepts the pnpm separator and keeps installation explicit', () => {
    expect(parseArgs([
      '--',
      '--publisher', 'Sumi-Sophia',
      '--version', '0.1.10',
      '--code', 'D:/Program Files/vscode/Microsoft VS Code/bin/code.cmd',
      '--install',
    ])).toMatchObject({
      publisher: 'Sumi-Sophia',
      version: '0.1.10',
      code: 'D:/Program Files/vscode/Microsoft VS Code/bin/code.cmd',
      install: true,
    });
  });

  it('does not turn a candidate preparation into an install by default', () => {
    expect(parseArgs(['--publisher', 'Sumi-Sophia', '--version', '0.1.10'])).toMatchObject({
      publisher: 'Sumi-Sophia',
      version: '0.1.10',
      install: false,
    });
  });

  it('parses a registry target without requiring a manual publisher override', () => {
    expect(parseArgs(['--target', 'marketplace', '--version', '0.2.1'])).toMatchObject({
      target: 'marketplace',
      version: '0.2.1',
      install: false,
    });
  });

  it('blocks the alternate registry ID even though its extension name differs', () => {
    expect(findInstalledTargetConflicts([
      { name: 'Sumi-Sophia.jsonl-view', version: '0.2.1', registered: true },
      { name: 'other.viewer', version: '1.0.0', registered: true },
    ], 'Sumi-Sophia.jsonlview-data-studio', 'jsonlview-data-studio')).toEqual([
      expect.objectContaining({ name: 'Sumi-Sophia.jsonl-view' }),
    ]);
  });

  it('rejects a second separator instead of silently widening the command', () => {
    expect(() => parseArgs(['--', '--', '--publisher', 'Sumi-Sophia'])).toThrow(/requires a value/i);
  });

  it('normalizes buffered git output without losing the source-state hashes', () => {
    const state = sourceStateFromGitOutputs(
      Buffer.from('abc\n'),
      Buffer.from(' M README.md\n'),
      Buffer.from('diff-bytes'),
    );
    expect(state.sha).toBe('abc');
    expect(state.clean).toBe(false);
    expect(state.statusSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.diffSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
