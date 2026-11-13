import { describe, expect, it } from 'vitest';
import { createMcpDiagnosticPlan } from '../../src/extension/native-mcp-manager';

describe('native MCP diagnostic manager bridge', () => {
  it('builds explicit, bounded attempts for modern and legacy protocol lines', () => {
    const plan = createMcpDiagnosticPlan(process.cwd(), {
      schema: 'jsonlview.side-agent-diagnostic.v1',
      source: 'JsonlView',
      kind: 'diagnostic',
      stage: 'webview_diagnostic',
      error: { name: 'Error', message: 'renderer stalled' },
      contentPolicy: 'metadata-only',
    });

    expect(plan).toMatchObject({
      schema: 'jsonlview.mcp-diagnostic-plan.v1',
      transport: 'host-owned',
      timeoutMs: 5_000,
      contentPolicy: 'metadata-only',
    });
    expect(plan?.attempts.map((attempt) => attempt.protocolVersion)).toEqual([
      '2026-07-28',
      '2025-11-25',
      '2025-06-18',
    ]);
    expect(plan?.attempts.every((attempt) => attempt.messages.some((message) => message.includes('metadata-only')))).toBe(true);
  });

  it('returns no plan when the optional native addon is absent', () => {
    expect(
      createMcpDiagnosticPlan('E:\\\\missing-jsonlview-extension', {
        schema: 'jsonlview.side-agent-diagnostic.v1',
        source: 'JsonlView',
        kind: 'diagnostic',
        stage: 'webview_diagnostic',
        error: { name: 'Error', message: 'missing native' },
        contentPolicy: 'metadata-only',
      }),
    ).toBeUndefined();
  });
});
