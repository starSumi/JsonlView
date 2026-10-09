import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_NAVIGATION_PROTOCOL_VERSIONS,
  MCP_NAVIGATION_TOOL_NAME,
  McpNavigationAdapterError,
  McpReadOnlyNavigationAdapter,
  negotiateMcpNavigationProtocolVersion,
  ReadOnlyNavigationFacade,
  type NavigationProvider,
  type NavigationSnapshot,
} from '../../src/experimental';

const snapshot: NavigationSnapshot = {
  snapshotId: 'snapshot-1',
  sourceId: 'codex-local',
  sourceGeneration: 'generation-1',
  capturedAt: '2026-10-10T00:00:00.000Z',
  redaction: 'metadata-only',
  truncated: false,
  entities: [
    { sourceId: 'codex-local', nativeId: 'thread-001', kind: 'session', label: 'Fallback session', vendorTitle: 'Vendor session', productTitle: 'Pinned session', firstMessagePreview: 'secret prompt body', project: String.raw`C:\private\repo`, opaqueRef: 'opaque:1', confidence: 'source' },
    { sourceId: 'codex-local', nativeId: 'thread-002', kind: 'subagent', label: 'Worker two', parentNativeId: 'thread-001', confidence: 'correlated' },
    { sourceId: 'codex-local', nativeId: 'thread-003', kind: 'task', label: 'Worker three', parentNativeId: 'thread-001', confidence: 'inferred' },
  ],
  relations: [
    { sourceId: 'codex-local', fromNativeId: 'thread-001', toNativeId: 'thread-002', kind: 'spawn' },
    { sourceId: 'codex-local', fromNativeId: 'thread-001', toNativeId: 'thread-003', kind: 'spawn' },
  ],
};

function provider(readSnapshot = snapshot): NavigationProvider {
  return { sourceId: 'codex-local', readSnapshot: async () => readSnapshot };
}

function adapter(options: {
  now?: () => number;
  sourceProviders?: Readonly<Record<string, string>>;
} = {}) {
  const facade = new ReadOnlyNavigationFacade({ providers: [provider()], allowedSourceIds: ['codex-local'] });
  let sequence = 0;
  return {
    value: new McpReadOnlyNavigationAdapter({
      query: facade.query.bind(facade),
      allowedSourceIds: ['codex-local'],
      ...(options.sourceProviders === undefined ? {} : { sourceProviders: options.sourceProviders }),
      clock: { now: options.now ?? (() => 1_000) },
      cursorFactory: () => `cursor-${sequence++}`,
    }),
    facade,
  };
}

describe('MCP read-only navigation contract adapter', () => {
  it('negotiates the July 2026 revision and retains the November 2025 revision', () => {
    expect(negotiateMcpNavigationProtocolVersion(['2025-11-25', '2026-07-28'])).toBe('2026-07-28');
    expect(negotiateMcpNavigationProtocolVersion(['2025-11-25'])).toBe('2025-11-25');
    expect(() => negotiateMcpNavigationProtocolVersion(['2024-10-01'])).toThrowError(McpNavigationAdapterError);
    expect(() => negotiateMcpNavigationProtocolVersion(['2026-07-28'], ['2024-10-01'])).toThrowError(McpNavigationAdapterError);
    expect(MCP_NAVIGATION_PROTOCOL_VERSIONS).toEqual(['2026-07-28', '2025-11-25']);
  });

  it('exposes one read-only tool and strips source content from a paged projection', async () => {
    const { value } = adapter({ sourceProviders: { 'codex-local': 'codex' } });
    expect(value.tools('2026-07-28')).toHaveLength(1);
    expect(() => value.tools('2024-10-01')).toThrowError(McpNavigationAdapterError);
    expect(value.tools()[0]?.name).toBe(MCP_NAVIGATION_TOOL_NAME);
    const first = await value.callTool('2026-07-28', MCP_NAVIGATION_TOOL_NAME, { sourceId: 'codex-local', limit: 1 }, new AbortController().signal);
    expect(first.structuredContent.entities).toHaveLength(1);
    expect(first.structuredContent.entities[0]).toMatchObject({ id: 'thread-001', title: 'Pinned session' });
    expect(first.structuredContent.entities[0]).not.toHaveProperty('firstMessagePreview');
    expect(first.structuredContent.entities[0]).not.toHaveProperty('project');
    expect(first.structuredContent.entities[0]).not.toHaveProperty('opaqueRef');
    expect(JSON.stringify(first)).not.toContain('secret prompt body');
    expect(JSON.stringify(first)).not.toContain('C:\\private');
    expect(first.structuredContent.nextCursor).toMatch(/^cursor-/u);

    const second = await value.callTool('2025-11-25', MCP_NAVIGATION_TOOL_NAME, { sourceId: 'codex-local', cursor: first.structuredContent.nextCursor! }, new AbortController().signal);
    expect(second.structuredContent.entities.map((entity) => entity.id)).toEqual(['thread-002']);
    expect(second.structuredContent.relations).toEqual([{ fromId: 'thread-001', toId: 'thread-002', kind: 'spawn' }]);
  });

  it('uses provider or kind plus short id title fallbacks without exposing locations', async () => {
    const { value } = adapter({ sourceProviders: { 'codex-local': 'codex' } });
    const page = await value.querySessions('2026-07-28', { sourceId: 'codex-local', kind: 'subagent', limit: 1 }, new AbortController().signal);
    expect(page.entities[0]).toMatchObject({ id: 'thread-002', title: 'codex · thread-002' });
    expect(page).not.toHaveProperty('locations');
    expect(JSON.stringify(page)).not.toMatch(/(?:prompt|body|args|results?|path|location)/iu);
  });

  it('checks the source allowlist before invoking the supplied facade', async () => {
    const query = vi.fn(async () => { throw new Error('must not probe'); });
    const value = new McpReadOnlyNavigationAdapter({ query, allowedSourceIds: ['codex-local'] });
    await expect(value.callTool('2026-07-28', MCP_NAVIGATION_TOOL_NAME, { sourceId: 'unknown-local' }, new AbortController().signal)).rejects.toMatchObject({ code: 'source_not_allowlisted' });
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a cursor bound to another query and expires old cursors', async () => {
    let now = 1_000;
    const { value } = adapter({ now: () => now });
    const first = await value.querySessions('2026-07-28', { sourceId: 'codex-local', limit: 1 }, new AbortController().signal);
    await expect(value.querySessions('2026-07-28', { sourceId: 'codex-local', text: 'different', cursor: first.nextCursor! }, new AbortController().signal)).rejects.toMatchObject({ code: 'cursor_query_mismatch' });
    now += 5 * 60 * 1000;
    await expect(value.querySessions('2026-07-28', { sourceId: 'codex-local', cursor: first.nextCursor! }, new AbortController().signal)).rejects.toMatchObject({ code: 'stale_cursor' });
  });

  it('honors cancellation, entity/relation budgets, and maximum response bytes', async () => {
    const { value } = adapter();
    const controller = new AbortController();
    controller.abort();
    await expect(value.querySessions('2026-07-28', { sourceId: 'codex-local' }, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    await expect(value.querySessions('2026-07-28', { sourceId: 'codex-local', budget: { maxBytes: 1 } }, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(value.querySessions('2026-07-28', { sourceId: 'codex-local', budget: { maxBytes: 128 } }, new AbortController().signal)).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('has no transport, process, filesystem, network, VS Code, or SDK dependency', () => {
    const source = readFileSync(new URL('../../src/experimental/mcp-navigation-adapter.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:node:fs|node:child_process|node:http|node:https|from ['"]vscode['"]|mcp-sdk|@modelcontextprotocol)/iu);
  });
});
