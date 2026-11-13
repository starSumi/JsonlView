import type { ExtensionContributionConflict } from '../extension-conflicts';
import type { JsonlViewDiagnosticEnvelope } from './diagnostic-context';
import type { McpDiagnosticPlan } from '../native-mcp-manager';

/** Optional host command consumed by a side-agent integration. */
export const SIDE_AGENT_DIAGNOSTIC_COMMAND = 'jsonlView.sideAgent.receiveDiagnostic';

export interface ActivationConflictDiagnostic {
  readonly schema: 'jsonlview.side-agent-diagnostic.v1';
  readonly source: 'JsonlView';
  readonly kind: 'activation-contribution-conflict';
  readonly stage: 'activation';
  readonly currentExtensionId: string;
  readonly conflictingExtensionId: string;
  readonly contributionIds: readonly string[];
  readonly contentPolicy: 'metadata-only';
}

export interface SideAgentDiagnostic {
  readonly schema: 'jsonlview.side-agent-diagnostic.v1';
  readonly source: 'JsonlView';
  readonly kind: 'diagnostic';
  readonly stage: string;
  readonly error: { readonly name: string; readonly message: string };
  readonly contentPolicy: 'metadata-only';
}

export type SideAgentDiagnosticEvent = ActivationConflictDiagnostic | SideAgentDiagnostic;

export interface SideAgentDiagnosticDispatch {
  readonly schema: 'jsonlview.side-agent-dispatch.v1';
  readonly action: 'report_diagnostic';
  readonly diagnostic: SideAgentDiagnosticEvent;
  readonly mcp?: McpDiagnosticPlan;
}

export type SideAgentCommandExecutor = (
  command: string,
  dispatch: SideAgentDiagnosticDispatch,
) => PromiseLike<unknown> | unknown;

export type McpDiagnosticPlanFactory = (
  diagnostic: SideAgentDiagnosticEvent,
) => McpDiagnosticPlan | undefined;

export type SideAgentDelivery = 'delivered' | 'duplicate' | 'failed';

export interface SideAgentDiagnosticPort {
  publish(diagnostic: SideAgentDiagnosticEvent): Promise<SideAgentDelivery>;
}

/** Build metadata only; the user-facing notification text never crosses this boundary. */
export function buildActivationConflictDiagnostic(
  currentExtensionId: string,
  conflict: ExtensionContributionConflict,
): ActivationConflictDiagnostic {
  return {
    schema: 'jsonlview.side-agent-diagnostic.v1',
    source: 'JsonlView',
    kind: 'activation-contribution-conflict',
    stage: 'activation',
    currentExtensionId: sanitizeIdentifier(currentExtensionId),
    conflictingExtensionId: sanitizeIdentifier(conflict.extensionId),
    contributionIds: [...new Set(conflict.contributionIds.map((id) => sanitizeIdentifier(id)))].sort(),
    contentPolicy: 'metadata-only',
  };
}

/** Convert an already sanitized host diagnostic into the side-agent contract. */
export function buildSideAgentDiagnostic(envelope: JsonlViewDiagnosticEnvelope): SideAgentDiagnostic {
  return {
    schema: 'jsonlview.side-agent-diagnostic.v1',
    source: 'JsonlView',
    kind: 'diagnostic',
    stage: sanitizeIdentifier(envelope.stage),
    error: {
      name: sanitizeIdentifier(envelope.error.name),
      message: sanitizeIdentifier(envelope.error.message, 512),
    },
    contentPolicy: 'metadata-only',
  };
}

/**
 * Create a best-effort side-agent port. A failed or missing consumer cannot
 * change extension activation, and successfully delivered reports are
 * suppressed by value.
 */
export function createSideAgentDiagnosticPort(
  executeCommand: SideAgentCommandExecutor,
  command = SIDE_AGENT_DIAGNOSTIC_COMMAND,
  createMcpPlan?: McpDiagnosticPlanFactory,
): SideAgentDiagnosticPort {
  const delivered = new Set<string>();
  const inFlight = new Map<string, Promise<SideAgentDelivery>>();
  return Object.freeze({
    publish: async (diagnostic: SideAgentDiagnosticEvent): Promise<SideAgentDelivery> => {
      const key = stableFingerprint(diagnostic);
      if (delivered.has(key)) return 'duplicate';
      const active = inFlight.get(key);
      if (active !== undefined) return active;
      const attempt = (async (): Promise<SideAgentDelivery> => {
        try {
          const mcp = createMcpPlan?.(diagnostic);
          await executeCommand(command, {
            schema: 'jsonlview.side-agent-dispatch.v1',
            action: 'report_diagnostic',
            diagnostic,
            ...(mcp === undefined ? {} : { mcp }),
          });
          delivered.add(key);
          return 'delivered';
        } catch {
          return 'failed';
        }
      })();
      inFlight.set(key, attempt);
      try {
        return await attempt;
      } finally {
        inFlight.delete(key);
      }
    },
  });
}

function stableFingerprint(diagnostic: SideAgentDiagnosticEvent): string {
  if (diagnostic.kind === 'activation-contribution-conflict') {
    return JSON.stringify({
      schema: diagnostic.schema,
      kind: diagnostic.kind,
      stage: diagnostic.stage,
      currentExtensionId: diagnostic.currentExtensionId,
      conflictingExtensionId: diagnostic.conflictingExtensionId,
      contributionIds: diagnostic.contributionIds,
    });
  }
  return JSON.stringify({
    schema: diagnostic.schema,
    kind: diagnostic.kind,
    stage: diagnostic.stage,
    name: diagnostic.error.name,
    message: diagnostic.error.message,
  });
}

function sanitizeIdentifier(value: string, limit = 128): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) || 'Unknown';
}
