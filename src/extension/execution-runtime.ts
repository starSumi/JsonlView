import type * as vscode from 'vscode';
import { isRuntimeExecutionIdentity, UNKNOWN_RUNTIME_IDENTITY, type RuntimeExecutionIdentity } from '../shared/execution-identity';

/** VS Code ExtensionContext owns host mode; bundle optimization never proves it. */
export function captureRuntimeExecutionIdentity(
  context: Pick<vscode.ExtensionContext, 'extensionMode' | 'extension'>,
): Readonly<RuntimeExecutionIdentity> {
  // Values are the public vscode.ExtensionMode contract. A type-only import
  // keeps this bounded conversion testable without loading the host API.
  const extensionMode = context.extensionMode === 1 ? 'production'
    : context.extensionMode === 2 ? 'development' : context.extensionMode === 3 ? 'test' : 'unknown';
  const extensionId: unknown = context.extension?.id;
  const extensionVersion: unknown = context.extension?.packageJSON?.version;
  const runtime = { extensionId, extensionVersion, extensionMode };
  if (!isRuntimeExecutionIdentity(runtime)) return Object.freeze({ ...UNKNOWN_RUNTIME_IDENTITY, extensionMode });
  return Object.freeze(runtime);
}
