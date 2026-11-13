import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStartupStageReceipt, readRuntimeExecutionIdentity, startStartupHandshake } from '../../src/webview/startup-handshake';
import { EXECUTION_IDENTITY, UNKNOWN_RUNTIME_IDENTITY } from '../../src/shared/execution-identity';
import { JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION } from '../../src/shared/contracts/errors';

describe('startup handshake', () => {
  afterEach(() => vi.useRealTimers());

  it('retries a lost READY twice, then reports a missing response once', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const timeout = vi.fn();
    const stop = startStartupHandshake(send, () => false, timeout);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(timeout).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(timeout).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each(['OPENED', 'ERROR'])('stops retrying when %s arrives', () => {
    vi.useFakeTimers();
    let settled = false;
    const send = vi.fn();
    const timeout = vi.fn();
    const stop = startStartupHandshake(send, () => settled, timeout);
    settled = true;
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
    stop();
  });

  it('cancels pending retry timers on unmount', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const timeout = vi.fn();
    startStartupHandshake(send, () => false, timeout)();
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('does not schedule a retry when READY receives a terminal response synchronously', () => {
    vi.useFakeTimers();
    let settled = false;
    const timeout = vi.fn();
    const send = vi.fn(() => { settled = true; });
    startStartupHandshake(send, () => settled, timeout);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('does not report timeout when a terminal response arrives just before the deadline', () => {
    vi.useFakeTimers();
    let settled = false;
    const send = vi.fn();
    const timeout = vi.fn();
    const stop = startStartupHandshake(send, () => settled, timeout);
    vi.advanceTimersByTime(7499);
    settled = true;
    stop();
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(timeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps startup receipts fixed and bounded, including an empty page', () => {
    const session = { documentId: 'document-1', generation: 'generation-1', startupId: 'boot-1', epoch: 2 };
    expect(createStartupStageReceipt('page-committed', session, 0)).toEqual({
      type: 'JSONLVIEW_STARTUP_STAGE', startupStageProtocolVersion: JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION,
      stage: 'page-committed', ...session, rows: 0,
      executionIdentity: EXECUTION_IDENTITY,
      runtimeIdentity: UNKNOWN_RUNTIME_IDENTITY,
    });
    expect(createStartupStageReceipt('opened-accepted', session, 10)).toEqual({
      type: 'JSONLVIEW_STARTUP_STAGE', startupStageProtocolVersion: JSONLVIEW_STARTUP_STAGE_PROTOCOL_VERSION,
      stage: 'opened-accepted', ...session,
      executionIdentity: EXECUTION_IDENTITY,
      runtimeIdentity: UNKNOWN_RUNTIME_IDENTITY,
    });
    expect(createStartupStageReceipt('page-committed', session, 501)).toBeUndefined();
    expect(createStartupStageReceipt('page-committed', session, NaN)).toBeUndefined();
    expect(createStartupStageReceipt('opened-accepted', { ...session, epoch: -1 })).toBeUndefined();
    expect(createStartupStageReceipt('opened-accepted', { ...session, startupId: '' })).toBeUndefined();
    expect(createStartupStageReceipt('startup-error', { ...session, documentId: 'x'.repeat(129) })).toBeUndefined();
  });

  it('reads runtime mode only from the host bootstrap and keeps missing data unknown', () => {
    const runtime = { extensionId: 'Sumi-Sophia.jsonl-view', extensionVersion: '0.2.11', extensionMode: 'development' };
    vi.stubGlobal('document', { body: { dataset: { runtimeIdentity: JSON.stringify(runtime) } } });
    try {
      expect(readRuntimeExecutionIdentity()).toEqual(runtime);
      expect(createStartupStageReceipt('opened-accepted', { documentId: 'd', generation: 'g', startupId: 's' }))
        .toMatchObject({ runtimeIdentity: runtime });
      vi.stubGlobal('document', { body: { dataset: { runtimeIdentity: '{' } } });
      expect(readRuntimeExecutionIdentity()).toEqual(UNKNOWN_RUNTIME_IDENTITY);
      vi.stubGlobal('document', { body: { dataset: {} } });
      expect(readRuntimeExecutionIdentity()).toEqual(UNKNOWN_RUNTIME_IDENTITY);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
