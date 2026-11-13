import {
  isJsonlViewDiagnosticMessage,
  type JsonlViewDiagnosticMessage,
} from '@shared/contracts/errors';

/** Compatibility facade for the extension's Webview diagnostic message guard. */
export function isWebviewDiagnostic(value: unknown): value is JsonlViewDiagnosticMessage {
  return isJsonlViewDiagnosticMessage(value);
}
