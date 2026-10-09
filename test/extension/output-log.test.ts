import { describe, expect, it, vi } from 'vitest';
import { appendOutputLog, formatOutputLogLine } from '../../src/extension/output-log';

describe('JsonlView output log', () => {
  it('formats bounded single-line entries without copying control characters', () => {
    const line = formatOutputLogLine(' source\nchanged ', '  first\nsecond\t' + 'x'.repeat(600), '2026-10-09T00:00:00.000Z');
    expect(line).toContain('[source changed] first second');
    expect(line).not.toMatch(/[\r\n\t]/u);
    expect(line.length).toBeLessThan(700);
  });

  it('does not require a channel and appends when present', () => {
    const channel = { appendLine: vi.fn() };
    appendOutputLog(undefined, 'ignored');
    appendOutputLog(channel, 'ready', 'registered');
    expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[ready] registered'));
  });
});
