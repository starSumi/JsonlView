import { describe, expect, it, vi } from 'vitest';
import {
  appendObservabilityEvent,
  appendExecutionIdentityLog,
  appendOutputLog,
  createOutputLogObservabilitySink,
  formatOutputLogLine,
  formatObservabilityLogLine,
} from '../../../src/extension/observability/output-log';
import { EXECUTION_IDENTITY } from '../../../src/shared/execution-identity';

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

  it('keeps the full validated identity receipt parseable beyond the generic log bound', () => {
    const channel = { appendLine: vi.fn() };
    const identity = { ...EXECUTION_IDENTITY, extensionId: 'x'.repeat(128), extensionVersion: '1.2.3-' + 'x'.repeat(58) };
    const runtime = { extensionId: identity.extensionId, extensionVersion: identity.extensionVersion, extensionMode: 'development' as const };
    appendExecutionIdentityLog(channel, identity, runtime);
    const line = channel.appendLine.mock.calls[0]?.[0] as string;
    expect(line.length).toBeGreaterThan(512);
    expect(line.length).toBeLessThan(2100);
    expect(JSON.parse(line.split('[execution-identity] ')[1] ?? '')).toEqual({ executionIdentity: identity, runtimeIdentity: runtime });
    appendExecutionIdentityLog(channel, { ...identity, path: 'private' } as never, runtime);
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
  });

  it('preserves every field of a maximum-size 19-attribute query receipt beyond the generic detail cap', () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const attributes = {
      stage: 'get_rows', request_seq: maximum, outcome: 'failed', delivery: 'failed', abort_observed: false,
      duration_ms: maximum, rows: maximum, error_name: 'InvalidStateError',
      queue_wait_ms: maximum, engine_exec_ms: maximum, queue_blocked_by: 'finish_indexing',
      index_work_ms: maximum, read_wait_ms: maximum, parse_ms: maximum, projection_ms: maximum,
      snapshot_check_ms: maximum, read_calls: maximum, read_bytes: maximum, read_max_wait_ms: maximum,
    };
    const detail = Object.entries(attributes).map(([key, value]) => `${key}=${String(value)}`).join(' ');
    expect(detail.length).toBeGreaterThan(512);
    expect(Object.keys(attributes)).toHaveLength(19);
    const event = { name: 'jsonlview.query.settled' as const, timestamp: '2026-10-13T00:00:00.000Z', attributes };
    expect(formatObservabilityLogLine(event)).toBe(`${event.timestamp} [${event.name}] ${detail}`);
    const channel = { appendLine: vi.fn() };
    appendObservabilityEvent(channel, event);
    expect(channel.appendLine).toHaveBeenCalledExactlyOnceWith(`${event.timestamp} [${event.name}] ${detail}`);
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
