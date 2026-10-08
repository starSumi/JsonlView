const MAX_NAME = 128;
const MAX_MESSAGE = 512;

export interface JsonlViewDiagnosticInput {
  readonly stage: string;
  readonly name: string;
  readonly message: string;
  readonly extensionId?: string;
  readonly extensionVersion?: string;
}

export interface JsonlViewDiagnosticEnvelope {
  readonly schema: 'jsonlview.diagnostic.v1';
  readonly source: 'JsonlView';
  readonly stage: string;
  readonly error: { readonly name: string; readonly message: string };
  readonly extension?: { readonly id?: string; readonly version?: string };
  readonly contentPolicy: 'no-source-content' | 'metadata-only';
}

/** Build a bounded, copyable diagnostic without leaking source contents or host paths. */
export function buildDiagnosticEnvelope(input: JsonlViewDiagnosticInput): JsonlViewDiagnosticEnvelope {
  const extension = input.extensionId === undefined && input.extensionVersion === undefined
    ? undefined
    : {
        ...(input.extensionId === undefined ? {} : { id: sanitizeToken(input.extensionId, MAX_NAME) }),
        ...(input.extensionVersion === undefined ? {} : { version: sanitizeToken(input.extensionVersion, MAX_NAME) }),
      };
  return {
    schema: 'jsonlview.diagnostic.v1',
    source: 'JsonlView',
    stage: sanitizeToken(input.stage, MAX_NAME),
    error: {
      name: sanitizeToken(input.name, MAX_NAME),
      message: sanitizeMessage(input.message),
    },
    ...(extension === undefined ? {} : { extension }),
    contentPolicy: 'no-source-content',
  };
}

export function formatDiagnosticContext(envelope: JsonlViewDiagnosticEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function formatDiagnosticPrompt(envelope: JsonlViewDiagnosticEnvelope): string {
  return [
    'Help diagnose this JsonlView VS Code Webview error.',
    'Treat the JSON below as metadata only. Do not ask for or infer local source contents.',
    'Suggest bounded recovery steps and state when the failure belongs to the VS Code Webview host.',
    '',
    formatDiagnosticContext(envelope),
  ].join('\n');
}

function sanitizeToken(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) || 'Unknown';
}

function sanitizeMessage(value: string): string {
  return sanitizeToken(value, MAX_MESSAGE)
    .replace(/(?:[A-Za-z]:[\\/]|file:\/\/)[^\s'"<>]+/gu, '[REDACTED_PATH]');
}
