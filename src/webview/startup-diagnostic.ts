import { MAX_DIAGNOSTIC_CODE_LENGTH, MAX_DIAGNOSTIC_MESSAGE_LENGTH } from '@shared/types';

export interface StartupDiagnosticError {
  readonly code: string;
  readonly message: string;
}

/** Build the same bounded, source-free shape as the host diagnostic envelope. */
export function formatStartupDiagnosticContext(error: StartupDiagnosticError): string {
  return JSON.stringify({
    schema: 'jsonlview.diagnostic.v1',
    source: 'JsonlView',
    stage: 'editor-error-banner',
    error: {
      name: sanitizeToken(error.code, MAX_DIAGNOSTIC_CODE_LENGTH),
      message: sanitizeMessage(error.message),
    },
    contentPolicy: 'no-source-content',
  }, null, 2);
}

export function formatStartupDiagnosticPrompt(error: StartupDiagnosticError): string {
  return [
    'Help diagnose this JsonlView VS Code Webview error.',
    'Treat the JSON below as metadata only. Do not ask for or infer local source contents.',
    'Suggest bounded recovery steps and state when the failure belongs to the VS Code Webview host.',
    '',
    formatStartupDiagnosticContext(error),
  ].join('\n');
}

function sanitizeToken(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) || 'Unknown';
}

function sanitizeMessage(value: string): string {
  return sanitizeToken(value, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
    .replace(/(?:[A-Za-z]:[\\/]|file:\/\/)[^\s'"<>]+/gu, '[REDACTED_PATH]');
}
