import { basename } from 'node:path';
import type * as vscode from 'vscode';
import type { ExtensionContributionConflict } from './extension-conflicts';
import {
  buildDiagnosticEnvelope,
  formatDiagnosticContext,
  formatDiagnosticPrompt,
  type JsonlViewDiagnosticEnvelope,
} from './diagnostics/diagnostic-context';
import {
  buildActivationConflictDiagnostic,
  buildSideAgentDiagnostic,
  type SideAgentDiagnosticEvent,
} from './diagnostics/side-agent-diagnostics';

export const DIAGNOSTIC_ACTION = Object.freeze({
  sendToSideAgent: 'Send to side agent',
  openLog: 'Open JsonlView Log',
  copyContext: 'Copy diagnostic context',
  explainWithChat: 'Explain with VS Code Chat',
});

export interface ActivationConflictPresentation {
  readonly diagnostic: ReturnType<typeof buildActivationConflictDiagnostic>;
  readonly envelope: JsonlViewDiagnosticEnvelope;
  readonly notificationMessage: string;
}

/** Construct the conflict metadata and host-facing envelope at one pure boundary. */
export function buildActivationConflictPresentation(
  currentExtensionId: string,
  conflict: ExtensionContributionConflict,
): ActivationConflictPresentation {
  const diagnostic = buildActivationConflictDiagnostic(currentExtensionId, conflict);
  const contributionLabel = diagnostic.contributionIds.join(', ');
  const envelope = buildDiagnosticEnvelope({
    stage: 'activation-contribution-conflict',
    name: 'ExtensionContributionConflict',
    message: `Another enabled extension declares ${contributionLabel}.`,
    extensionId: currentExtensionId,
  });
  return {
    diagnostic,
    envelope,
    notificationMessage: `JsonlView cannot activate while ${conflict.extensionId} is enabled because both extensions declare ${conflict.contributionIds.join(', ')}. Disable or uninstall one JsonlView build, then reload the window.`,
  };
}

/** File-extension policy used by host commands without requiring a VS Code runtime. */
export function isJsonlResource(uri: Pick<vscode.Uri, 'path'>): boolean {
  const name = basename(uri.path).toLowerCase();
  return name.endsWith('.jsonl') || name.endsWith('.ndjson');
}

export interface DiagnosticActionPorts {
  copyText(text: string): Promise<unknown> | unknown;
  openLog(): void;
  sendToSideAgent(
    diagnostic: SideAgentDiagnosticEvent,
    envelope: JsonlViewDiagnosticEnvelope,
    context?: vscode.ExtensionContext,
  ): Promise<void>;
  explainWithChat(prompt: string): Promise<void>;
}

export interface DiagnosticActionOptions {
  readonly sideAgentDiagnostic?: SideAgentDiagnosticEvent;
  readonly context?: vscode.ExtensionContext;
}

/**
 * Dispatch a selected diagnostic action through injected host ports. The
 * selection and payload choice are deterministic and directly testable in Node.
 */
export function createDiagnosticActionController(ports: DiagnosticActionPorts) {
  return async function dispatchDiagnosticAction(
    action: string | undefined,
    envelope: JsonlViewDiagnosticEnvelope,
    options: DiagnosticActionOptions = {},
  ): Promise<void> {
    if (action === DIAGNOSTIC_ACTION.copyContext) {
      await ports.copyText(formatDiagnosticContext(envelope));
      return;
    }
    if (action === DIAGNOSTIC_ACTION.openLog) {
      ports.openLog();
      return;
    }
    if (action === DIAGNOSTIC_ACTION.sendToSideAgent) {
      await ports.sendToSideAgent(
        options.sideAgentDiagnostic ?? buildSideAgentDiagnostic(envelope),
        envelope,
        options.context,
      );
      return;
    }
    if (action === DIAGNOSTIC_ACTION.explainWithChat) {
      await ports.explainWithChat(formatDiagnosticPrompt(envelope));
    }
  };
}
