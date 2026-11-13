import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry } from '../../src/profiles/profile-registry';
import { projectTrajectory } from '../../src/profiles/trajectory-projection';
import { matchesTrajectory } from '../../src/shared/contracts/trajectory-slice';

const registry = new AgentProfileRegistry();
const project = (id: string, version: string, value: unknown) => projectTrajectory(registry, { id, version }, value, 'snapshot');
describe('trajectory profile evidence', () => {
  it('keeps absent, null and wrongly typed tool errors unknown under AND filtering', () => {
    for (const is_error of [undefined, null, 'false', 0]) {
      const row = project('claude-code-session', registry.version('claude-code-session'), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error, content: 'output' }] } });
      expect(row).toMatchObject({ actor: 'tool', hasError: null, text: 'output' });
      expect(matchesTrajectory(row, { actor: 'tool', hasError: false })).toBe(false);
      expect(matchesTrajectory(row, { actor: 'user' })).toBe(false);
    }
  });
  it('aggregates explicit tool results without treating incomplete evidence as false', () => {
    const row = (errors: unknown[]) => project('claude-code-session', registry.version('claude-code-session'), { type: 'user', message: { content: errors.map((is_error) => ({ type: 'tool_result', is_error })) } });
    expect(row([false, false]).hasError).toBe(false);
    expect(row([false, undefined]).hasError).toBeNull();
    expect(row([undefined, true]).hasError).toBe(true);
  });
  it('rejects an old Claude projection revision after the additive profile upgrade', () => {
    expect(project('claude-code-session', '2', { type: 'user', message: { content: [{ type: 'tool_result', is_error: false }] } }))
      .toMatchObject({ actor: 'unknown', hasError: null, text: null });
  });
  it('requires a terminal integer command result and does not equate warning/cancelled to error', () => {
    const command = (exit_code: unknown, type = 'item.completed') => project('codex-exec-jsonl', '1', { type, item: { id: 'c', type: 'command_execution', command: 'x', aggregated_output: '', status: 'completed', exit_code } });
    expect(command(0).hasError).toBe(false);
    expect(command(2).hasError).toBe(true);
    expect(command(null).hasError).toBeNull();
    expect(command(1, 'item.updated').hasError).toBeNull();
    expect(project('codex-exec-jsonl', '1', { type: 'turn.completed', usage: {} }).hasError).toBeNull();
    for (const type of ['security_risk_score', 'turn_aborted', 'task_complete']) {
      expect(project('codex-rollout', '1', { type: 'event_msg', payload: { type } }).hasError).toBeNull();
    }
    expect(project('codex-rollout', '1', { type: 'event_msg', payload: { type: 'error', message: 'failed' } }).hasError).toBe(true);
  });
  it('uses literal boolean Pi evidence and preserves unknown actor/generic rows', () => {
    expect(project('pi-coding-agent', '1', { type: 'message', message: { role: 'toolResult', content: 'ok', isError: false } }).hasError).toBe(false);
    expect(project('pi-coding-agent', '1', { type: 'message', message: { role: 'assistant', isError: true } }).hasError).toBeNull();
    expect(project('generic', '1', { role: 'tool', isError: false })).toMatchObject({ actor: 'unknown', hasError: null, text: null });
  });
  it('keeps Kimi and generic boolean evidence strict and does not infer failure from event labels', () => {
    const kimi = (isError: unknown) => project('kimi-code-session', '5', { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'tool', result: { output: 'done', isError } } });
    expect(kimi(true).hasError).toBe(true);
    expect(kimi(false).hasError).toBe(false);
    expect(kimi('false').hasError).toBeNull();
    const generic = (isError: unknown) => project('generic-agent-events', '1', { event_type: 'tool.result', data: { toolCallId: 'tool', output: 'done', isError } });
    expect(generic(false).hasError).toBe(false);
    expect(generic('true').hasError).toBeNull();
    expect(project('generic-agent-events', '1', { event_type: 'tool.error', data: { output: 'done' } }).hasError).toBeNull();
  });
});
