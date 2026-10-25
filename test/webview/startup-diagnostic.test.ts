import { describe, expect, it } from 'vitest';
import {
  formatStartupDiagnosticContext,
  formatStartupDiagnosticPrompt,
} from '../../src/webview/startup-diagnostic';

describe('startup diagnostic fallback', () => {
  const error = {
    code: 'STARTUP_TIMEOUT',
    message: 'The editor did not connect. C:\\Users\\private\\source.jsonl',
  };

  it('produces bounded metadata without local paths or source content', () => {
    const context = formatStartupDiagnosticContext(error);
    expect(JSON.parse(context)).toEqual({
      schema: 'jsonlview.diagnostic.v1',
      source: 'JsonlView',
      stage: 'editor-error-banner',
      error: { name: 'STARTUP_TIMEOUT', message: 'The editor did not connect. [REDACTED_PATH]' },
      contentPolicy: 'no-source-content',
    });
    expect(context).not.toContain('private');
  });

  it('builds a provider-neutral prompt around the same bounded context', () => {
    const prompt = formatStartupDiagnosticPrompt(error);
    expect(prompt).toContain('Treat the JSON below as metadata only.');
    expect(prompt).toContain('"schema": "jsonlview.diagnostic.v1"');
    expect(prompt).not.toContain('C:\\Users\\private');
  });
});
