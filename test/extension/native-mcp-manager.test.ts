import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpDiagnosticPlan } from '../../src/extension/native-mcp-manager';

const diagnostic = {
  schema: 'jsonlview.side-agent-diagnostic.v1',
  source: 'JsonlView',
  kind: 'diagnostic',
  stage: 'webview_diagnostic',
  error: { name: 'Error', message: 'renderer stalled' },
  contentPolicy: 'metadata-only',
} as const;

function expectBoundedPlan(plan: McpDiagnosticPlan | undefined): void {
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
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:module');
  vi.resetModules();
});

describe('native MCP diagnostic manager bridge', () => {
  it('builds explicit, bounded attempts for modern and legacy protocol lines', async () => {
    const instances: FixtureManager[] = [];
    class FixtureManager {
      readonly maxPayloadBytes: number | undefined;
      readonly beginConnection = vi.fn(() => 'initialize');
      readonly acceptInitialize = vi.fn((version: string) => `accepted:${version}`);
      readonly retryLegacyConnection = vi.fn((version: string) => `retry:${version}`);
      readonly prepareDiagnostic = vi.fn((_stage: string, _name: string, _message: string) => JSON.stringify({ contentPolicy: 'metadata-only' }));
      readonly completeRequest = vi.fn();
      readonly failRequest = vi.fn();
      readonly close = vi.fn();

      constructor(maxPayloadBytes?: number) {
        this.maxPayloadBytes = maxPayloadBytes;
        instances.push(this);
      }
    }
    const load = vi.fn(() => ({ McpManager: FixtureManager }));
    vi.resetModules();
    vi.doMock('node:fs', () => ({ existsSync: () => true }));
    vi.doMock('node:module', () => ({ createRequire: () => load }));
    const { createMcpDiagnosticPlan } = await import('../../src/extension/native-mcp-manager');
    const plan = createMcpDiagnosticPlan(process.cwd(), diagnostic);

    expectBoundedPlan(plan);
    expect(load).toHaveBeenCalledOnce();
    expect(instances).toHaveLength(3);
    for (const [index, manager] of instances.entries()) {
      const version = plan!.attempts[index]!.protocolVersion;
      expect(manager.maxPayloadBytes).toBe(16 * 1024);
      expect(manager.beginConnection).toHaveBeenCalledOnce();
      expect(manager.acceptInitialize).toHaveBeenCalledWith(version);
      expect(manager.prepareDiagnostic).toHaveBeenCalledWith('webview_diagnostic', 'Error', 'Error: renderer stalled');
      expect(manager.completeRequest).toHaveBeenCalledOnce();
      expect(manager.close).toHaveBeenCalledOnce();
      if (index === 0) {
        expect(manager.failRequest).not.toHaveBeenCalled();
        expect(manager.retryLegacyConnection).not.toHaveBeenCalled();
      } else {
        expect(manager.failRequest).toHaveBeenCalledOnce();
        expect(manager.retryLegacyConnection).toHaveBeenCalledWith(version);
      }
    }
  });

  it('returns no plan when the optional native addon is absent', async () => {
    const load = vi.fn();
    vi.resetModules();
    vi.doMock('node:fs', () => ({ existsSync: () => false }));
    vi.doMock('node:module', () => ({ createRequire: () => load }));
    const { createMcpDiagnosticPlan } = await import('../../src/extension/native-mcp-manager');
    expect(createMcpDiagnosticPlan(resolve(tmpdir(), 'missing-jsonlview-extension'), {
      ...diagnostic,
      error: { name: 'Error', message: 'missing native' },
    })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('native MCP addon integration', () => {
  it('checks a supported real addon or the explicit unsupported-host fallback', async () => {
    const root = process.cwd();
    const candidates = [
      ...(process.platform === 'win32' && process.arch === 'x64'
        ? [resolve(root, 'native', 'jsonl-core', 'jsonl_core.win32-x64-msvc.node')]
        : []),
      resolve(root, 'native', 'jsonl-core', 'jsonl_core.node'),
    ];
    const available = candidates.find((candidate) => existsSync(candidate));
    const { createMcpDiagnosticPlan } = await import('../../src/extension/native-mcp-manager');
    if (available === undefined) {
      expect(createMcpDiagnosticPlan(root, diagnostic)).toBeUndefined();
      return;
    }
    const binding = createRequire(resolve(root, 'package.json'))(available) as { McpManager?: unknown };
    expect(typeof binding.McpManager).toBe('function');
    expectBoundedPlan(createMcpDiagnosticPlan(root, diagnostic));
  });
});
