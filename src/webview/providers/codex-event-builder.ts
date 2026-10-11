import type { EventPresentationSection } from '../features/event-presentation/model';

export type CodexEventObject = Record<string, unknown>;

export interface CodexEventBuilderContext {
  own(object: CodexEventObject, key: string): unknown;
  valueAtPath(root: CodexEventObject | undefined, path: readonly string[]): unknown;
  valueLabel(value: unknown): string | undefined;
  addTextCandidate(sections: EventPresentationSection[], title: string, value: unknown, richText?: boolean): void;
  addOutputCandidate(sections: EventPresentationSection[], title: string, value: unknown): void;
  addCodeCandidate(sections: EventPresentationSection[], title: string, value: unknown, language?: string, copyText?: string): void;
  addDiffCandidate(sections: EventPresentationSection[], title: string, value: unknown): boolean;
  addCommandCandidate(sections: EventPresentationSection[], value: unknown): void;
  addCommandOutputCandidate(sections: EventPresentationSection[], title: string, value: unknown): void;
  addJavaScriptCandidate(sections: EventPresentationSection[], title: string, value: string): void;
  decodeSerializedJsonValue(value: unknown): unknown;
  addExecCommandView(section: EventPresentationSection, name: string | undefined, argumentsValue: unknown): void;
}

/**
 * These are deliberately explicit Codex-owned paths. A generic text key is
 * not enough evidence to turn arbitrary application data into Markdown.
 */
export function buildCodexContextSections(
  envelopeType: string | undefined,
  payload: CodexEventObject,
  context: CodexEventBuilderContext,
): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  if (envelopeType === 'world_state') {
    const fields: Array<{ title: string; path: string[]; richText: boolean }> = [
      { title: 'AGENTS.md', path: ['state', 'agents_md', 'text'], richText: true },
      { title: 'Host skills', path: ['state', 'host_skills', 'body'], richText: true },
      { title: 'Orchestrator skills', path: ['state', 'orchestrator_skills', 'body'], richText: true },
      { title: 'Permission instructions', path: ['state', 'permissions', 'instructions'], richText: true },
      { title: 'Collaboration instructions', path: ['state', 'collaboration_mode', 'settings', 'developer_instructions'], richText: true },
      { title: 'Developer instructions', path: ['state', 'developer_instructions'], richText: true },
      { title: 'Managed developer instructions', path: ['state', 'managed_developer_instructions'], richText: true },
      { title: 'Multi-agent usage hint', path: ['state', 'multi_agent_usage_hint'], richText: false },
      { title: 'Skills', path: ['state', 'skills', 'body'], richText: true },
      { title: 'Skills instructions', path: ['state', 'skills', 'instructions'], richText: true },
      { title: 'Context window guidance', path: ['state', 'context_window_guidance'], richText: false },
    ];
    for (const field of fields) context.addTextCandidate(sections, field.title, context.valueAtPath(payload, field.path), field.richText);
  } else if (envelopeType === 'thread_settings_applied') {
    const fields: Array<{ title: string; path: string[] }> = [
      { title: 'Developer instructions', path: ['thread_settings', 'collaboration_mode', 'settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['thread_settings', 'settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['thread_settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['collaboration_mode', 'settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['settings', 'developer_instructions'] },
      { title: 'Developer instructions', path: ['developer_instructions'] },
      { title: 'Instructions', path: ['instructions'] },
    ];
    for (const field of fields) context.addTextCandidate(sections, field.title, context.valueAtPath(payload, field.path), true);
  } else if (envelopeType === 'session_meta') {
    context.addTextCandidate(sections, 'Base instructions', context.valueAtPath(payload, ['base_instructions']), true);
  } else if (envelopeType === 'compacted') {
    context.addTextCandidate(sections, 'Compaction message', context.own(payload, 'message'), true);
  } else if (envelopeType === 'inter_agent_communication') {
    context.addTextCandidate(sections, 'Agent message', context.own(payload, 'content'), true);
  } else if (envelopeType === 'task_complete' || envelopeType === 'turn_complete') {
    // Codex keeps the terminal turn message beside the lifecycle envelope,
    // rather than wrapping it in a response-item content block.
    context.addTextCandidate(sections, 'Last agent message', context.own(payload, 'last_agent_message'), true);
    context.addTextCandidate(sections, 'Error', context.own(payload, 'error'), true);
    const timing: CodexEventObject = {};
    for (const key of ['started_at', 'completed_at', 'duration_ms', 'time_to_first_token_ms']) {
      if (context.own(payload, key) !== undefined) timing[key] = context.own(payload, key);
    }
    if (Object.keys(timing).length > 0) context.addCodeCandidate(sections, 'Timing', timing, 'json');
  }
  return sections;
}

export function buildCodexItemSections(
  item: CodexEventObject | undefined,
  normalizedType: string | undefined,
  context: CodexEventBuilderContext,
): EventPresentationSection[] {
  if (!item || !normalizedType) return [];
  const sections: EventPresentationSection[] = [];
  switch (normalizedType) {
    case 'reasoning':
      context.addTextCandidate(sections, 'Reasoning summary', context.own(item, 'summary_text'), true);
      context.addTextCandidate(sections, 'Reasoning content', context.own(item, 'raw_content'), true);
      break;
    case 'command_execution':
      context.addCommandCandidate(sections, context.own(item, 'command'));
      for (const key of ['stdout', 'stderr', 'aggregated_output', 'formatted_output']) {
        context.addCommandOutputCandidate(sections, key.replaceAll('_', ' '), context.own(item, key));
      }
      break;
    case 'file_change':
      if (!context.addDiffCandidate(sections, 'Changes', context.own(item, 'changes'))) {
        if (typeof context.own(item, 'unified_diff') === 'string' || typeof context.own(item, 'diff') === 'string') {
          context.addDiffCandidate(sections, 'Changes', item);
        } else {
          context.addCodeCandidate(sections, 'Changes', context.own(item, 'changes'));
        }
      }
      context.addTextCandidate(sections, 'stdout', context.own(item, 'stdout'), true);
      context.addTextCandidate(sections, 'stderr', context.own(item, 'stderr'), true);
      break;
    case 'mcp_tool_call':
    case 'dynamic_tool_call':
      context.addCodeCandidate(sections, 'Arguments', context.own(item, 'arguments'));
      context.addTextCandidate(sections, 'Result', context.own(item, 'result'));
      context.addTextCandidate(sections, 'Error', context.own(item, 'error'));
      context.addTextCandidate(sections, 'Output', context.own(item, 'content_items'));
      break;
    case 'collab_agent_tool_call':
    case 'collab_tool_call':
    case 'sub_agent_activity':
      context.addTextCandidate(sections, 'Prompt', context.own(item, 'prompt'), true);
      break;
    case 'plan':
      context.addTextCandidate(sections, 'Plan', context.own(item, 'text'), true);
      break;
    case 'hook_prompt':
      context.addTextCandidate(sections, 'Prompt', context.own(item, 'fragments'), true);
      break;
    case 'extension':
      context.addTextCandidate(sections, 'Query', context.own(item, 'query'));
      context.addCodeCandidate(sections, 'Action', context.own(item, 'action'));
      context.addTextCandidate(sections, 'Results', context.own(item, 'results'));
      context.addTextCandidate(sections, 'Result', context.own(item, 'result'));
      context.addTextCandidate(sections, 'Output', context.own(item, 'output'));
      break;
    case 'image_view':
      context.addTextCandidate(sections, 'Path', context.own(item, 'path'));
      break;
    default:
      break;
  }
  return sections;
}

export function buildCodexResponseItemSections(
  itemType: string | undefined,
  item: CodexEventObject,
  context: CodexEventBuilderContext,
): EventPresentationSection[] {
  const sections: EventPresentationSection[] = [];
  switch (itemType) {
    case 'custom_tool_call': {
      const name = context.valueLabel(context.own(item, 'name'));
      const input = context.own(item, 'input');
      if ((name === 'exec' || name === 'js_repl') && typeof input === 'string') {
        context.addJavaScriptCandidate(sections, 'JavaScript · ' + name, input);
      } else {
        context.addTextCandidate(sections, name ? 'Freeform input · ' + name : 'Freeform input', input);
      }
      break;
    }
    case 'custom_tool_call_output':
    case 'function_call_output':
      context.addOutputCandidate(sections, 'Tool result', context.own(item, 'output'));
      break;
    case 'function_call': {
      const rawArguments = context.own(item, 'arguments');
      const decodedArguments = context.decodeSerializedJsonValue(rawArguments);
      context.addCodeCandidate(
        sections,
        'Arguments',
        decodedArguments,
        'json',
        typeof rawArguments === 'string' ? rawArguments : undefined,
      );
      const argumentsSection = sections.find((section) => section.title === 'Arguments');
      if (argumentsSection) context.addExecCommandView(argumentsSection, context.valueLabel(context.own(item, 'name')), decodedArguments);
      break;
    }
    case 'mcp_tool_call_output':
      context.addCodeCandidate(sections, 'Tool result', context.own(item, 'output'), 'json');
      break;
    default:
      break;
  }
  return sections;
}

