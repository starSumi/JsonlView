import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { SideAgentDiagnosticEvent } from './diagnostics/side-agent-diagnostics';

export const MCP_DIAGNOSTIC_PLAN_SCHEMA = 'jsonlview.mcp-diagnostic-plan.v1' as const;
export const MCP_DIAGNOSTIC_TIMEOUT_MS = 5_000;

export interface NativeMcpManager {
  beginConnection(): string;
  acceptInitialize(serverProtocolVersion: string): string;
  retryLegacyConnection(protocolVersion?: string): string;
  prepareDiagnostic(stage: string, name: string, message: string): string;
  completeRequest(): void;
  failRequest(): void;
  close(): void;
  state(): string;
  protocolVersion(): string;
}

interface NativeMcpBinding {
  McpManager?: new (maxPayloadBytes?: number) => NativeMcpManager;
}

export interface McpDiagnosticPlanAttempt {
  readonly protocolVersion: '2026-07-28' | '2025-11-25' | '2025-06-18';
  readonly messages: readonly string[];
}

export interface McpDiagnosticPlan {
  readonly schema: typeof MCP_DIAGNOSTIC_PLAN_SCHEMA;
  readonly transport: 'host-owned';
  readonly timeoutMs: number;
  readonly contentPolicy: 'metadata-only';
  readonly attempts: readonly McpDiagnosticPlanAttempt[];
}

/** Build a transport-neutral plan only after an explicit diagnostic action. */
export function createMcpDiagnosticPlan(
  extensionPath: string,
  diagnostic: SideAgentDiagnosticEvent,
): McpDiagnosticPlan | undefined {
  const Manager = loadNativeManager(extensionPath);
  if (Manager === undefined) return undefined;

  const attempts = (['2026-07-28', '2025-11-25', '2025-06-18'] as const).map((protocolVersion) => {
    const manager = new Manager(16 * 1024);
    const messages = [manager.beginConnection()];
    if (protocolVersion !== '2026-07-28') {
      manager.failRequest();
      messages.push(manager.retryLegacyConnection(protocolVersion));
    }
    messages.push(manager.acceptInitialize(protocolVersion));
    messages.push(
      manager.prepareDiagnostic(
        diagnostic.stage,
        diagnostic.kind === 'activation-contribution-conflict' ? diagnostic.kind : diagnostic.error.name,
        diagnosticSummary(diagnostic),
      ),
    );
    manager.completeRequest();
    manager.close();
    return { protocolVersion, messages };
  });

  return {
    schema: MCP_DIAGNOSTIC_PLAN_SCHEMA,
    transport: 'host-owned',
    timeoutMs: MCP_DIAGNOSTIC_TIMEOUT_MS,
    contentPolicy: 'metadata-only',
    attempts,
  };
}

function diagnosticSummary(diagnostic: SideAgentDiagnosticEvent): string {
  if (diagnostic.kind === 'activation-contribution-conflict') {
    return (
      'Activation contribution conflict: ' +
      diagnostic.conflictingExtensionId +
      ' (' +
      diagnostic.contributionIds.join(', ') +
      ').'
    );
  }
  return diagnostic.error.name + ': ' + diagnostic.error.message;
}

function loadNativeManager(extensionPath: string): NativeMcpBinding['McpManager'] {
  const candidates = [
    resolve(extensionPath, 'native', 'jsonl-core', 'jsonl_core.win32-x64-msvc.node'),
    resolve(extensionPath, 'native', 'jsonl-core', 'jsonl_core.node'),
  ];
  const requireNative = createRequire(resolve(extensionPath, 'package.json'));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const binding = requireNative(candidate) as NativeMcpBinding;
      if (typeof binding.McpManager === 'function') return binding.McpManager;
    } catch {
      // The portable host path remains available when an optional native addon is unavailable.
    }
  }
  return undefined;
}
