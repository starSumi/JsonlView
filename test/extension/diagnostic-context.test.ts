import { describe, expect, it } from 'vitest';
import { buildDiagnosticEnvelope, formatDiagnosticPrompt } from '../../src/extension/diagnostic-context';

describe('bounded Webview diagnostic context', () => {
  it('redacts local paths and never includes source-content policy violations', () => {
    const envelope = buildDiagnosticEnvelope({
      stage: 'webview-host-registration',
      name: 'InvalidStateError',
      message: 'Failed at C:/Users/private/session.jsonl with secret payload',
      extensionId: 'Sumi-Sophia.jsonl-view',
    });
    expect(envelope.schema).toBe('jsonlview.diagnostic.v1');
    expect(envelope.contentPolicy).toBe('no-source-content');
    expect(envelope.error.message).not.toContain('C:/Users');
    expect(envelope.error.message).toContain('[REDACTED_PATH]');
  });

  it('redacts common POSIX absolute paths without changing URLs or relative references', () => {
    const message = [
      'Failed at /home/runner/work/jsonlview/private/session.jsonl',
      'and /Users/developer/projects/jsonlview/file.ts',
      'also /runner/build/JsonlView/session.jsonl',
      'endpoint https://host/v1/chat/completions',
      'relative /../../secret.jsonl',
      'Markdown [docs](./docs/README.md)',
      'release v1.2.3',
    ].join('; ');

    const envelope = buildDiagnosticEnvelope({ stage: 'query', name: 'Error', message });

    expect(envelope.error.message.match(/\[REDACTED_PATH\]/gu)).toHaveLength(3);
    expect(envelope.error.message).not.toContain('/home/runner');
    expect(envelope.error.message).not.toContain('/Users/developer');
    expect(envelope.error.message).not.toContain('/runner/build');
    expect(envelope.error.message).toContain('https://host/v1/chat/completions');
    expect(envelope.error.message).toContain('/../../secret.jsonl');
    expect(envelope.error.message).toContain('[docs](./docs/README.md)');
    expect(envelope.error.message).toContain('v1.2.3');
  });

  it('redacts POSIX paths with spaced directories without consuming nearby prose', () => {
    const envelope = buildDiagnosticEnvelope({
      stage: 'query',
      name: 'Error',
      message: 'Failed at /home/runner/My Projects/private/session.jsonl; retry the scan',
    });

    expect(envelope.error.message).toBe('Failed at [REDACTED_PATH]; retry the scan');
  });

  it('preserves a bare versioned API route', () => {
    const envelope = buildDiagnosticEnvelope({
      stage: 'query',
      name: 'Error',
      message: 'Request failed at /v1/chat/completions, /v1/chat/completions.json, /v1.2/chat/completions.json, and /api/v1/chat/completions.json',
    });

    expect(envelope.error.message).toContain('/v1/chat/completions');
    expect(envelope.error.message).toContain('/v1/chat/completions.json');
    expect(envelope.error.message).toContain('/v1.2/chat/completions.json');
    expect(envelope.error.message).toContain('/api/v1/chat/completions.json');
    expect(envelope.error.message).not.toContain('[REDACTED_PATH]');
  });

  it('preserves root-relative Markdown links to versioned API routes', () => {
    const envelope = buildDiagnosticEnvelope({
      stage: 'query',
      name: 'Error',
      message: 'See [completions](/v1/chat/completions) and [route](/v1/chat/completions.json)',
    });

    expect(envelope.error.message).toContain('[completions](/v1/chat/completions)');
    expect(envelope.error.message).toContain('[route](/v1/chat/completions.json)');
    expect(envelope.error.message).not.toContain('[REDACTED_PATH]');
  });

  it('redacts file URLs before matching POSIX paths', () => {
    const envelope = buildDiagnosticEnvelope({
      stage: 'query',
      name: 'Error',
      message: 'Could not read file:///Users/developer/private/session.jsonl',
    });

    expect(envelope.error.message).toBe('Could not read [REDACTED_PATH]');
  });

  it('bounds untrusted fields and produces an explicit AI prompt', () => {
    const envelope = buildDiagnosticEnvelope({ stage: 'x'.repeat(300), name: 'E', message: 'm'.repeat(2_000) });
    expect(envelope.stage.length).toBeLessThanOrEqual(128);
    expect(envelope.error.message.length).toBeLessThanOrEqual(512);
    expect(formatDiagnosticPrompt(envelope)).toContain('Treat the JSON below as metadata only');
  });
});
