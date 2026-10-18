import { describe, expect, it, vi } from 'vitest';
import {
  buildActivationConflictDiagnostic,
  buildSideAgentDiagnostic,
  createSideAgentDiagnosticPort,
  SIDE_AGENT_DIAGNOSTIC_COMMAND,
} from '../../src/extension/side-agent-diagnostics';

describe('side-agent activation diagnostics', () => {
  it('sends bounded conflict metadata without copying the notification text', () => {
    const diagnostic = buildActivationConflictDiagnostic('JsonlView\ncurrent', {
      extensionId: 'other\rbuild',
      contributionIds: ['jsonlView.open', 'jsonlView.open', 'jsonlView.editor'],
    });

    expect(diagnostic).toEqual({
      schema: 'jsonlview.side-agent-diagnostic.v1',
      source: 'JsonlView',
      kind: 'activation-contribution-conflict',
      stage: 'activation',
      currentExtensionId: 'JsonlView current',
      conflictingExtensionId: 'other build',
      contributionIds: ['jsonlView.editor', 'jsonlView.open'],
      contentPolicy: 'metadata-only',
    });
    expect(diagnostic).not.toHaveProperty('message');
    expect(JSON.stringify(diagnostic)).not.toContain('Disable or uninstall');
  });

  it('allows a failed delivery to be retried while containing the missing consumer', async () => {
    const execute = vi.fn(async () => { throw new Error('command not found'); });
    const port = createSideAgentDiagnosticPort(execute);
    const diagnostic = buildActivationConflictDiagnostic('current', { extensionId: 'other', contributionIds: ['jsonlView.open'] });

    await expect(port.publish(diagnostic)).resolves.toBe('failed');
    await expect(port.publish({ ...diagnostic, contributionIds: ['jsonlView.open'] })).resolves.toBe('failed');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(SIDE_AGENT_DIAGNOSTIC_COMMAND, expect.objectContaining({
      schema: 'jsonlview.side-agent-dispatch.v1',
      action: 'report_diagnostic',
      diagnostic,
    }));
  });

  it('reports delivery without exposing the executor result', async () => {
    const execute = vi.fn(async () => ({ privateBody: 'must not be forwarded' }));
    const port = createSideAgentDiagnosticPort(execute, 'sideAgent.receive');
    const diagnostic = buildActivationConflictDiagnostic('current', { extensionId: 'other', contributionIds: ['jsonlView.pageSize'] });

    await expect(port.publish(diagnostic)).resolves.toBe('delivered');
    expect(execute).toHaveBeenCalledWith('sideAgent.receive', expect.objectContaining({ diagnostic }));
    await expect(port.publish(diagnostic)).resolves.toBe('duplicate');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps generic diagnostics distinct from activation conflicts', async () => {
    const execute = vi.fn(async (_command: string, _dispatch: unknown) => undefined);
    const port = createSideAgentDiagnosticPort(execute);
    const first = buildSideAgentDiagnostic({
      schema: 'jsonlview.diagnostic.v1',
      source: 'JsonlView',
      stage: 'webview_diagnostic',
      error: { name: 'Error', message: 'first' },
      contentPolicy: 'no-source-content',
    });
    const second = buildSideAgentDiagnostic({
      schema: 'jsonlview.diagnostic.v1',
      source: 'JsonlView',
      stage: 'webview_diagnostic',
      error: { name: 'Error', message: 'second' },
      contentPolicy: 'no-source-content',
    });

    await expect(port.publish(first)).resolves.toBe('delivered');
    await expect(port.publish(second)).resolves.toBe('delivered');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('creates an optional MCP plan only when the explicit publish action runs', async () => {
    const execute = vi.fn(async (_command: string, _dispatch: unknown) => undefined);
    const createMcpPlan = vi.fn(() => ({
      schema: 'jsonlview.mcp-diagnostic-plan.v1' as const,
      transport: 'host-owned' as const,
      timeoutMs: 5_000,
      contentPolicy: 'metadata-only' as const,
      attempts: [],
    }));
    const diagnostic = buildActivationConflictDiagnostic('current', { extensionId: 'other', contributionIds: ['jsonlView.open'] });
    const port = createSideAgentDiagnosticPort(execute, SIDE_AGENT_DIAGNOSTIC_COMMAND, createMcpPlan);

    expect(createMcpPlan).not.toHaveBeenCalled();
    await expect(port.publish(diagnostic)).resolves.toBe('delivered');
    expect(createMcpPlan).toHaveBeenCalledWith(diagnostic);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ mcp: { schema: 'jsonlview.mcp-diagnostic-plan.v1' } });
  });
});
