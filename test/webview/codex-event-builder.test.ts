import { describe, expect, it } from 'vitest';
import {
  buildCodexContextSections,
  buildCodexItemSections,
  buildCodexResponseItemSections,
  type CodexEventBuilderContext,
} from '../../src/webview/providers/codex-event-builder';
import type { EventPresentationSection } from '../../src/webview/features/event-presentation/model';

function context(): CodexEventBuilderContext {
  const own = (object: Record<string, unknown>, key: string): unknown => Object.hasOwn(object, key) ? object[key] : undefined;
  const valueAtPath = (root: Record<string, unknown> | undefined, path: readonly string[]): unknown => {
    let current: unknown = root;
    for (const key of path) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = own(current as Record<string, unknown>, key);
    }
    return current;
  };
  const valueLabel = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  const addTextCandidate = (sections: EventPresentationSection[], title: string, value: unknown, richText = false): void => {
    if (typeof value === 'string' && value.length > 0 && !sections.some((section) => section.title === title)) sections.push({ title, text: value, fullText: value, richText });
  };
  const addOutputCandidate = addTextCandidate;
  const addCodeCandidate = (sections: EventPresentationSection[], title: string, value: unknown, language?: string, copyText?: string): void => {
    if (value === undefined || sections.some((section) => section.title === title)) return;
    sections.push({ title, code: typeof value === 'string' ? value : JSON.stringify(value), ...(language ? { language } : {}), ...(copyText ? { copyText } : {}) });
  };
  const addDiffCandidate = (sections: EventPresentationSection[], title: string, value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    addCodeCandidate(sections, title, value, 'diff');
    return true;
  };
  const addCommandCandidate = (sections: EventPresentationSection[], value: unknown): void => addCodeCandidate(sections, 'Command', value, 'shell');
  const addCommandOutputCandidate = (sections: EventPresentationSection[], title: string, value: unknown): void => addTextCandidate(sections, title, value, true);
  const addJavaScriptCandidate = (sections: EventPresentationSection[], title: string, value: string): void => addCodeCandidate(sections, title, value, 'javascript');
  return {
    own,
    valueAtPath,
    valueLabel,
    addTextCandidate,
    addOutputCandidate,
    addCodeCandidate,
    addDiffCandidate,
    addCommandCandidate,
    addCommandOutputCandidate,
    addJavaScriptCandidate,
    decodeSerializedJsonValue: (value) => {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    },
    addExecCommandView: (section, name, args) => {
      if (name === 'exec_command' && args && typeof args === 'object' && !Array.isArray(args) && typeof (args as Record<string, unknown>).cmd === 'string') section.language = 'shell';
    },
  };
}

describe('Codex event builder', () => {
  it('projects bounded world-state and lifecycle context fields', () => {
    const sections = buildCodexContextSections('world_state', {
      state: { agents_md: { text: '# Local policy' }, skills: { body: 'skill body' } },
    }, context());
    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'AGENTS.md', text: '# Local policy', richText: true }),
      expect.objectContaining({ title: 'Skills', text: 'skill body' }),
    ]));
    expect(buildCodexContextSections('turn_complete', { last_agent_message: 'Done', duration_ms: 42 }, context()).map((section) => section.title)).toEqual(['Last agent message', 'Timing']);
  });

  it('keeps item-specific command, diff, plan, and extension projections explicit', () => {
    expect(buildCodexItemSections({ command: ['pwsh', '-c', 'Get-ChildItem'], stdout: 'ok' }, 'command_execution', context()).map((section) => section.title)).toEqual(['Command', 'stdout']);
    expect(buildCodexItemSections({ changes: '--- a/demo.ts\n+++ b/demo.ts' }, 'file_change', context()).some((section) => section.language === 'diff')).toBe(true);
    expect(buildCodexItemSections({ text: 'step one' }, 'plan', context())[0]).toMatchObject({ title: 'Plan', text: 'step one' });
    expect(buildCodexItemSections({ kind: 'web.search', output: 'result' }, 'extension', context())).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Output', text: 'result' })]));
  });

  it('renders response tool calls through the shared command and JavaScript adapters', () => {
    const functionSections = buildCodexResponseItemSections('function_call', { name: 'exec_command', arguments: '{"cmd":"git status"}' }, context());
    expect(functionSections[0]).toMatchObject({ title: 'Arguments', language: 'shell', copyText: '{"cmd":"git status"}' });
    expect(buildCodexResponseItemSections('custom_tool_call', { name: 'js_repl', input: 'text(1);' }, context())[0]).toMatchObject({ title: 'JavaScript · js_repl', language: 'javascript' });
    expect(buildCodexResponseItemSections('function_call_output', { output: 'completed' }, context())[0]).toMatchObject({ title: 'Tool result', text: 'completed' });
  });
});
