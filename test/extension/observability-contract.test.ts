import { describe, expect, it } from 'vitest';
import { createObservabilityEvent, NOOP_OBSERVABILITY } from '../../src/extension/observability-contract';

describe('contract-first observability boundary', () => {
  it('accepts bounded scalar diagnostic attributes only', () => {
    expect(createObservabilityEvent('jsonlview.webview.error', { stage: 'editor-webview', error_name: 'InvalidStateError' })).toMatchObject({
      name: 'jsonlview.webview.error',
      attributes: { stage: 'editor-webview', error_name: 'InvalidStateError' },
    });
  });

  it('rejects source, identity, unbounded, and non-scalar data', () => {
    expect(createObservabilityEvent('jsonlview.query.completed', { path: 'C:/secret/session.jsonl' })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.completed', { rows: { count: 1 } })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.completed', { result: 'x'.repeat(161) })).toBeUndefined();
    expect(createObservabilityEvent('jsonlview.query.completed', { rows: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('has no-op behavior until an explicit exporter is introduced', () => {
    expect(() => NOOP_OBSERVABILITY.record({ name: 'jsonlview.index.completed', timestamp: new Date().toISOString(), attributes: {} })).not.toThrow();
  });
});
