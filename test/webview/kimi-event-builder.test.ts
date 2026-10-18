import { describe, expect, it } from 'vitest';
import { buildKimiEventSections, type KimiEventBuilderContext, type KimiEventObject } from '../../src/webview/providers/kimi-event-builder';
import { kimiEventStrategyRegistry } from '../../src/webview/providers/kimi-event-strategies';
import type { EventPresentationSection } from '../../src/webview/features/event-presentation/model';

const kimiProfile = { profileId: 'kimi-code-session' } as never;

function context(): KimiEventBuilderContext {
  const objectOf = (value: unknown): KimiEventObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as KimiEventObject
    : undefined;
  const own = (object: KimiEventObject, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
  const valueLabel = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  const addTextCandidate = (sections: EventPresentationSection[], title: string, value: unknown, richText = false): void => {
    if (value === undefined || sections.some((section) => section.title === title)) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text) sections.push({ title, text, fullText: text, richText });
  };
  const addCodeCandidate = (sections: EventPresentationSection[], title: string, value: unknown, language?: string): void => {
    if (value === undefined || sections.some((section) => section.title === title)) return;
    sections.push({ title, code: typeof value === 'string' ? value : JSON.stringify(value), ...(language ? { language } : {}) });
  };
  return { objectOf, own, valueLabel, addTextCandidate, addCodeCandidate };
}

describe('Kimi event builder', () => {
  it('routes source discriminants through one bounded strategy registry', () => {
    expect(kimiEventStrategyRegistry.get('context.append_loop_event')?.id).toBe('loop');
    expect(kimiEventStrategyRegistry.get('prompt.steered')?.id).toBe('content');
    expect(kimiEventStrategyRegistry.get('llm.tools_snapshot')?.id).toBe('tool-schema');
    expect(kimiEventStrategyRegistry.get('task.started')?.id).toBe('lifecycle');

    const command = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: {
        type: 'tool.call',
        name: 'Bash',
        args: { command: 'echo from args', cwd: 'F:/tmp' },
        display: { kind: 'command', command: 'echo from display' },
      },
    }, kimiProfile, context());
    expect(command).toEqual([expect.objectContaining({
      title: 'Tool command · Bash',
      code: 'echo from display',
      language: 'shell',
    })]);

    const task = buildKimiEventSections({
      type: 'task.started',
      agentId: 'main',
      info: { kind: 'process', description: 'run a command', command: 'pnpm test', pid: 1, exitCode: null },
    }, kimiProfile, context());
    expect(task).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Task description', text: 'run a command' }),
      expect.objectContaining({ title: 'Task command', code: 'pnpm test', language: 'shell' }),
    ]));

    const result = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: { type: 'tool.result', result: { output: 'finished' } },
    }, kimiProfile, context());
    expect(result).toEqual([expect.objectContaining({ title: 'Tool result', text: 'finished' })]);
  });

  it('renders the persisted systemPrompt string as text instead of hiding it in a generic payload', () => {
    const sections = buildKimiEventSections({
      type: 'profile.bind',
      systemPrompt: 'You are Kimi Code CLI, an interactive general AI agent.',
    }, kimiProfile, context());

    expect(sections).toEqual([expect.objectContaining({
      title: 'System prompt',
      text: 'You are Kimi Code CLI, an interactive general AI agent.',
    })]);
  });

  it('projects the persisted Kimi union fields through bounded typed candidates', () => {
    const snapshot = buildKimiEventSections({
      type: 'llm.tools_snapshot',
      tools: [{ name: 'Lookup', description: 'Look up a short value.', parameters: { type: 'object' } }],
    }, kimiProfile, context());
    expect(snapshot).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool description · Lookup', text: 'Look up a short value.' }),
      expect.objectContaining({ title: 'Tool parameters · Lookup', code: expect.stringContaining('object') }),
    ]));

    const part = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'text', text: 'streamed text' } },
    }, kimiProfile, context());
    expect(part).toEqual([expect.objectContaining({ title: 'Content', text: 'streamed text' })]);
    const thinking = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'think', think: 'reason about the source' } },
    }, kimiProfile, context());
    expect(thinking).toEqual([expect.objectContaining({ title: 'Reasoning', text: 'reason about the source' })]);

    const call = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: { type: 'tool.call', name: 'Bash', command: 'Get-ChildItem', display: { command: 'fallback' } },
    }, kimiProfile, context());
    expect(call).toEqual([expect.objectContaining({ title: 'Tool command · Bash', code: 'Get-ChildItem', language: 'shell' })]);
    const result = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: { type: 'tool.result', result: { output: [{ type: 'text', text: 'done' }], note: 'completed' } },
    }, kimiProfile, context());
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool result 1', text: 'done' }),
      expect.objectContaining({ title: 'Result note', text: 'completed' }),
    ]));

    const task = buildKimiEventSections({ type: 'task.started', info: { description: 'Index the workspace' } }, kimiProfile, context());
    expect(task).toEqual([expect.objectContaining({ title: 'Task description', text: 'Index the workspace' })]);
    const steered = buildKimiEventSections({ type: 'prompt.steered', content: [
      { type: 'text', text: 'Use the focused file.' },
      { type: 'think', think: 'private reasoning' },
    ] }, kimiProfile, context());
    expect(steered).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Prompt 1', text: 'Use the focused file.' }),
      expect.objectContaining({ title: 'Reasoning', text: 'private reasoning' }),
    ]));
  });

  it('projects fixed semantic payload fields while leaving open-ended values in Raw', () => {
    const cases: Array<{ value: KimiEventObject; title: string }> = [
      { value: { type: 'llm.request', systemPrompt: 'system instructions' }, title: 'System prompt' },
      { value: { type: 'mcp.tools_discovered', tools: [{ name: 'Read', description: 'Read a file.', inputSchema: { type: 'object' } }] }, title: 'MCP tool description · Read' },
      { value: { type: 'plugin.session_start', content: 'plugin context' }, title: 'Session content' },
      { value: { type: 'prompt.aborted', reason: 'cancelled' }, title: 'Reason' },
      { value: { type: 'prompt.completed', reason: 'completed' }, title: 'Reason' },
      { value: { type: 'subagent.spawned', description: 'Inspect the parser' }, title: 'Subagent description' },
      { value: { type: 'subagent.completed', resultSummary: 'Parser inspected' }, title: 'Result summary' },
      { value: { type: 'subagent.failed', error: 'Parser unavailable' }, title: 'Error' },
      { value: { type: 'task.terminated', info: { description: 'Run checks' }, outputTail: 'passed' }, title: 'Task output' },
      { value: { type: 'goal.create', objective: 'Ship the fix', completionCriterion: 'Tests pass' }, title: 'Objective' },
      { value: { type: 'goal.update', reason: 'validation complete' }, title: 'Reason' },
      { value: { type: 'cron.add', task: { prompt: 'Refresh the index' } }, title: 'Cron prompt' },
      { value: { type: 'full_compaction.begin', instruction: 'Compact old context' }, title: 'Compaction instruction' },
      { value: { type: 'turn.prompt', input: [{ type: 'text', text: 'Inspect the file' }] }, title: 'Prompt 1' },
      { value: { type: 'turn.steer', input: [{ type: 'think', think: 'Use a bounded read' }] }, title: 'Reasoning' },
      { value: { type: 'turn.ended', error: { message: 'failed' } }, title: 'Error' },
      { value: { type: 'tools.register_user_tool', description: 'Read a file.', parameters: { type: 'object' } }, title: 'Tool description' },
    ];
    for (const testCase of cases) {
      expect(buildKimiEventSections(testCase.value, kimiProfile, context()), String(testCase.value.type))
        .toEqual(expect.arrayContaining([expect.objectContaining({ title: testCase.title })]));
    }
  });

  it('preserves opaque reasoning flags and unknown structured parts without leaking hidden content', () => {
    const sections = buildKimiEventSections({ type: 'context.append_message', message: { role: 'assistant', content: [
      { type: 'think', think: 'visible reasoning' },
      { type: 'think', think: 'secret', hidden: true },
      { type: 'think', think: 'ciphertext', encrypted: 'opaque' },
      { type: 'image_url', imageUrl: { url: 'https://example.invalid/source.png' } },
    ] } }, kimiProfile, context());

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Reasoning', text: 'visible reasoning' }),
      expect.objectContaining({ title: 'Opaque reasoning · source flag', code: expect.stringContaining('opaque') }),
      expect.objectContaining({ title: 'Message 4 · reference or structured content', code: expect.stringContaining('source.png') }),
    ]));
    expect(JSON.stringify(sections)).not.toMatch(/secret|ciphertext/);
  });

  it('limits content and tool-call projection and marks omitted records for Raw inspection', () => {
    const content: unknown[] = Array.from({ length: 33 }, (_, index) => ({ type: 'text', text: `part-${index}` }));
    Object.defineProperty(content, 32, { get() { throw new Error('content budget exceeded'); } });
    const calls: unknown[] = Array.from({ length: 33 }, (_, index) => ({ name: `tool-${index}`, arguments: { index } }));
    Object.defineProperty(calls, 32, { get() { throw new Error('call budget exceeded'); } });

    const sections = buildKimiEventSections({
      type: 'context.append_message',
      message: { role: 'user', content, toolCalls: calls },
    }, kimiProfile, context());

    expect(sections.filter((section) => /^Message \d+$/.test(section.title))).toHaveLength(32);
    expect(sections.filter((section) => /^Tool call \d+ · tool-/.test(section.title))).toHaveLength(32);
    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Additional content · available in Raw', truncated: true, previewOnly: true }),
      expect.objectContaining({ title: 'Additional tool calls · available in Raw', truncated: true, previewOnly: true }),
    ]));
  });

  it('bounds oversized structured tool arguments before they reach the webview', () => {
    const sections = buildKimiEventSections({
      type: 'context.append_loop_event',
      event: { type: 'tool.call', name: 'Bash', args: { payload: 'x'.repeat(140_000) } },
    }, kimiProfile, context());

    expect(sections).toEqual([expect.objectContaining({
      title: 'Additional Kimi content · available in Raw',
      truncated: true,
      previewOnly: true,
    })]);
  });

  it('does not project Kimi sections for a different provider profile', () => {
    expect(buildKimiEventSections({ type: 'context.append_message', message: { content: 'text' } }, { profileId: 'generic' } as never, context())).toEqual([]);
  });
});
