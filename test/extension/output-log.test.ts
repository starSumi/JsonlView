import { describe, expect, it, vi } from 'vitest';
import {
  appendObservabilityEvent,
  appendOutputLog,
  createOutputLogObservabilitySink,
  formatOutputLogLine,
  formatObservabilityLogLine,
} from '../../src/extension/output-log';

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

  it('writes only validated lifecycle metadata to the local output channel', () => {
    const channel = { appendLine: vi.fn() };
    const event = {
      name: 'jsonlview.lifecycle.source_classified' as const,
      timestamp: '2026-10-13T00:00:00.000Z',
      attributes: { stage: 'source_classification', result: 'append', sequence: 1, causation: 'root' },
    };

    appendObservabilityEvent(channel, event);
    expect(channel.appendLine).toHaveBeenCalledWith(
      '2026-10-13T00:00:00.000Z [jsonlview.lifecycle.source_classified] stage=source_classification result=append sequence=1 causation=root',
    );
    expect(formatObservabilityLogLine({
      ...event,
      attributes: { path: 'C:/private/source.jsonl' },
    } as never)).toBeUndefined();
  });

  it('keeps the default sink silent and supports an explicit channel sink', () => {
    const channel = { appendLine: vi.fn() };
    const noChannelSink = createOutputLogObservabilitySink(undefined);
    expect(() => noChannelSink.record({
      name: 'jsonlview.lifecycle.webview_delivered',
      timestamp: '2026-10-13T00:00:00.000Z',
      attributes: { stage: 'webview_delivery', result: 'delivered', sequence: 4, causation: 'snapshot_publish' },
    })).not.toThrow();

    const sink = createOutputLogObservabilitySink(channel);
    sink.record({
      name: 'jsonlview.lifecycle.webview_delivered',
      timestamp: '2026-10-13T00:00:00.000Z',
      attributes: { stage: 'webview_delivery', result: 'delivered', sequence: 4, causation: 'snapshot_publish' },
    });
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
  });
});
