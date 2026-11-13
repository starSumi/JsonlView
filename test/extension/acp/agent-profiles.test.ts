import { describe, expect, it } from 'vitest';
import { readAcpAgentProfiles } from '../../../src/extension/acp/agent-profiles';

describe('ACP agent profiles', () => {
  it('maps legacy command settings to one local ACP v1 profile', () => {
    expect(readAcpAgentProfiles({ command: 'claude-code-acp', args: ['--stdio'], timeoutMs: 12_000 })).toEqual({
      configured: false,
      invalidCount: 0,
      profiles: [{ id: 'legacy', adapterId: 'generic.acp-v1', label: 'Configured ACP agent', command: 'claude-code-acp', args: ['--stdio'], timeoutMs: 12_000, executionTarget: 'local', protocolVersion: '1', transport: 'stdio' }],
    });
  });

  it('returns no profile when neither the profile list nor legacy command is configured', () => {
    expect(readAcpAgentProfiles({ args: [], timeoutMs: 10_000 })).toEqual({ configured: false, invalidCount: 0, profiles: [] });
  });

  it('validates stable IDs, command, arguments, timeout, protocol and transport', () => {
    const result = readAcpAgentProfiles({ profiles: [
      { id: 'claude-code', adapterId: 'generic.acp-v1', label: 'Claude Code', command: 'claude-code-acp', args: ['--stdio'], timeoutMs: 15_000, protocolVersion: '1', transport: 'stdio' },
      { id: 'bad id', label: 'Invalid', command: 'agent', args: [], timeoutMs: 10_000 },
      { id: 'v2-agent', label: 'ACP v2 only', command: 'agent', args: [], timeoutMs: 10_000, protocolVersion: '2' },
      { id: 'ssh-agent', label: 'Not enabled remotely', command: 'agent', args: [], timeoutMs: 10_000, executionTarget: 'ssh' },
      { id: 'unknown-adapter', adapterId: 'vendor.experimental', label: 'Unknown adapter', command: 'agent', args: [], timeoutMs: 10_000 },
      { id: 'oversized-arg', label: 'Oversized argument', command: 'agent', args: ['x'.repeat(4097)], timeoutMs: 10_000 },
      { id: 'short-timeout', label: 'Short timeout', command: 'agent', args: [], timeoutMs: 999 },
      { id: 'env-agent', label: 'Inline secret', command: 'agent', args: [], timeoutMs: 10_000, env: { TOKEN: 'secret' } },
    ] });

    expect(result.configured).toBe(true);
    expect(result.invalidCount).toBe(7);
    expect(result.profiles).toEqual([{ id: 'claude-code', adapterId: 'generic.acp-v1', label: 'Claude Code', command: 'claude-code-acp', args: ['--stdio'], timeoutMs: 15_000, executionTarget: 'local', protocolVersion: '1', transport: 'stdio' }]);
  });

  it('rejects duplicate IDs and limits the profile catalog size', () => {
    const duplicate = readAcpAgentProfiles({ profiles: [
      { id: 'agent', label: 'One', command: 'one', args: [], timeoutMs: 10_000 },
      { id: 'agent', label: 'Two', command: 'two', args: [], timeoutMs: 10_000 },
    ] });
    expect(duplicate.profiles).toHaveLength(0);
    expect(duplicate.invalidCount).toBe(2);

    expect(readAcpAgentProfiles({ profiles: Array.from({ length: 17 }, (_, index) => ({
      id: `agent-${index}`, label: `Agent ${index}`, command: 'agent', args: [], timeoutMs: 10_000,
    })) })).toMatchObject({ configured: true, invalidCount: 1, profiles: [] });
  });
});
