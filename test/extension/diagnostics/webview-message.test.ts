import { describe, expect, it } from 'vitest';
import { isWebviewDiagnostic } from '../../../src/extension/diagnostics/webview-message';
import { JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION } from '../../../src/shared/contracts/errors';

describe('Webview diagnostic contract adapter', () => {
  const diagnostic = {
    type: 'JSONLVIEW_DIAGNOSTIC',
    diagnosticProtocolVersion: JSONLVIEW_DIAGNOSTIC_PROTOCOL_VERSION,
    name: 'UnhandledRejection',
    message: 'bounded host diagnostic',
  };

  it('accepts the current versioned diagnostic shape', () => {
    expect(isWebviewDiagnostic(diagnostic)).toBe(true);
  });

  it.each([
    ['missing protocol version', Object.fromEntries(Object.entries(diagnostic).filter(([key]) => key !== 'diagnosticProtocolVersion'))],
    ['stale protocol version', { ...diagnostic, diagnosticProtocolVersion: 0 }],
    ['unbounded message', { ...diagnostic, message: 'x'.repeat(513) }],
  ])('rejects %s', (_description, value) => {
    expect(isWebviewDiagnostic(value)).toBe(false);
  });
});
