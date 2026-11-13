import * as vscode from 'vscode';
import { readAcpAgentProfiles, type AcpAgentProfile, type AcpAgentProfilesResult } from './agent-profiles';

export function readConfiguredAcpProfiles(): AcpAgentProfilesResult {
  const configuration = vscode.workspace.getConfiguration('jsonlView.acp');
  return readAcpAgentProfiles({
    command: configuration.get<string>('command', ''),
    args: configuration.get<string[]>('args', []),
    timeoutMs: configuration.get<number>('timeoutMs', 10_000),
    profiles: configuration.get<unknown>('profiles', undefined),
  });
}

export async function chooseAcpAgentProfile(profiles: readonly AcpAgentProfile[], signal?: AbortSignal): Promise<AcpAgentProfile | undefined> {
  if (signal?.aborted) return undefined;
  const cancellation = signal === undefined ? undefined : new vscode.CancellationTokenSource();
  const abort = (): void => cancellation?.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const selected = await vscode.window.showQuickPick(profiles.map((profile) => ({
      label: profile.label,
      description: `ACP v${profile.protocolVersion} · local stdio`,
      profileId: profile.id,
    })), {
      title: 'Choose an ACP agent',
      placeHolder: 'Select the explicitly configured agent for this diagnostic',
      ignoreFocusOut: true,
    }, cancellation?.token);
    if (signal?.aborted) return undefined;
    return profiles.find((profile) => profile.id === selected?.profileId);
  } finally {
    signal?.removeEventListener('abort', abort);
    cancellation?.dispose();
  }
}

export async function selectConfiguredAcpAgentProfile(onInvalid: (count: number) => void, signal?: AbortSignal): Promise<AcpAgentProfile | undefined> {
  if (signal?.aborted) return undefined;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage('ACP agents can only be launched in a trusted workspace.');
    return undefined;
  }
  const configured = readConfiguredAcpProfiles();
  if (configured.invalidCount > 0) onInvalid(configured.invalidCount);
  if (configured.profiles.length === 0) {
    void vscode.window.showInformationMessage('Configure a valid local ACP v1 profile before sending this diagnostic.');
    return undefined;
  }
  return configured.profiles.length === 1
    ? configured.profiles[0]
    : chooseAcpAgentProfile(configured.profiles, signal);
}
