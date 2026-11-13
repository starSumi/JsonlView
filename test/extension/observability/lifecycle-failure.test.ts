import { describe, expect, it, vi } from 'vitest';
import { logLifecycleFailure, type LifecycleFailureStage } from '../../../src/extension/observability/lifecycle-failure';

function capture(error: unknown, stage: LifecycleFailureStage = 'source_reconcile') {
  const lines: string[] = [];
  const warnings: string[] = [];
  logLifecycleFailure({ appendLine: (line) => lines.push(line) }, stage, error, (line) => warnings.push(line));
  return { lines, warnings };
}

describe('metadata-only lifecycle failures', () => {
  it('keeps fixed failure metadata and recognized filesystem codes without error content', () => {
    const error = Object.assign(new Error('private prompt at C:/private/source.jsonl'), { code: 'ENOENT' });
    const { lines, warnings } = capture(error);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[source-reconcile-failed\] stage=source_reconcile outcome=failed error_name=Error code=ENOENT$/u);
    expect(warnings[0]).toBe('[JsonlView] source-reconcile-failed stage=source_reconcile outcome=failed error_name=Error code=ENOENT');
    expect([...lines, ...warnings].join(' ')).not.toContain(error.message);
  });

  it.each([
    ['source_reconcile', 'source-reconcile-failed'],
    ['webview_delivery', 'webview-delivery-failed'],
    ['webview_diagnostic', 'diagnostic'],
    ['preview_collection_filing', 'preview-collection-filing-failed'],
  ] as const)('uses the fixed %s stage and event', (stage, event) => {
    expect(capture(new TypeError('private'), stage).lines[0]).toContain(
      `[${event}] stage=${stage} outcome=failed error_name=TypeError`,
    );
  });

  it.each([undefined, null, 'private source', 123, 1n, Symbol('private'), () => 'private'])(
    'does not coerce primitive or callable thrown values: %s', (error) => {
      const { lines, warnings } = capture(error);
      expect(lines[0]).toMatch(/error_name=UnknownError$/u);
      expect([...lines, ...warnings].join(' ')).not.toContain('private');
    },
  );

  it('does not invoke error accessors or coercion hooks', () => {
    const read = vi.fn(() => { throw new Error('getter must not run'); });
    const error = Object.create(null);
    for (const key of ['name', 'code', 'message', 'stack', 'cause', 'toString', Symbol.toPrimitive]) {
      Object.defineProperty(error, key, { get: read });
    }
    expect(() => capture(error)).not.toThrow();
    expect(capture(error).lines[0]).toMatch(/error_name=UnknownError$/u);
    expect(read).not.toHaveBeenCalled();
  });

  it('contains throwing proxy traps and never reads properties through a proxy', () => {
    const get = vi.fn(() => { throw new Error('private get'); });
    const error = new Proxy({}, {
      get,
      getOwnPropertyDescriptor: () => { throw new Error('private descriptor'); },
      getPrototypeOf: () => { throw new Error('private prototype'); },
    });
    expect(capture(error).lines[0]).toMatch(/error_name=UnknownError$/u);
    expect(get).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => capture(revoked.proxy)).not.toThrow();
  });

  it('rejects arbitrary names, codes and diagnostic bodies rather than redacting strings', () => {
    const error = { name: 'private_name', code: 'private_code', message: 'source body', stack: 'source stack', cause: 'secret' };
    expect(capture(error).lines[0]).toMatch(/error_name=UnknownError$/u);
    const diagnostic = capture({ name: 'InvalidStateError', message: 'source body at /home/private/file.jsonl' }, 'webview_diagnostic');
    expect(diagnostic.lines[0]).toMatch(/error_name=InvalidStateError$/u);
    expect(diagnostic.lines[0]).not.toContain('source');
    expect(diagnostic.lines[0]).not.toContain('/home');
  });

  it('retains the fixed READY-timeout diagnosis without copying its message', () => {
    const diagnostic = capture({ name: 'StartupTimeout', message: 'private timeout context' }, 'webview_diagnostic');
    expect(diagnostic.lines[0]).toMatch(/error_name=StartupTimeout$/u);
    expect(diagnostic.warnings[0]).not.toContain('private');
  });

  it('records saved-preview Collection filing failures as allowlisted output metadata', () => {
    const error = Object.assign(new Error('private file path C:/private/preview.jsonl'), { code: 'EACCES' });
    const { lines, warnings } = capture(error, 'preview_collection_filing');
    expect(lines[0]).toMatch(/\[preview-collection-filing-failed\] stage=preview_collection_filing outcome=failed error_name=Error code=EACCES$/u);
    expect([...lines, ...warnings].join(' ')).not.toContain(error.message);
  });

  it('isolates output and console sink failures independently', () => {
    const appendLine = vi.fn(() => { throw new Error('disposed channel'); });
    const warn = vi.fn(() => { throw new Error('failed console'); });
    expect(() => logLifecycleFailure({ appendLine }, 'webview_delivery', new Error('private'), warn)).not.toThrow();
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => logLifecycleFailure(undefined, 'source_reconcile', null)).not.toThrow();
  });

  it('drops invalid stages before inspecting a thrown value', () => {
    const getOwnPropertyDescriptor = vi.fn(() => { throw new Error('must not inspect'); });
    const error = new Proxy({}, { getOwnPropertyDescriptor });
    const appendLine = vi.fn();
    logLifecycleFailure({ appendLine }, 'private_stage' as LifecycleFailureStage, error);
    expect(appendLine).not.toHaveBeenCalled();
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled();
  });
});
