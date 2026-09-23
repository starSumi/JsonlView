import type { AgentEventKind, AgentRowProjection } from '../shared/types';
import { own } from './utils';

/**
 * The rollout writer serializes `TurnItem` with Rust's variant name (for
 * example `CommandExecution`), while `codex exec --json` uses snake_case.
 * Keep the translation in one small, source-backed table so projection and
 * detail presentation cannot drift apart.
 */
export const CODEX_ITEM_KIND_MAP: Readonly<Record<string, AgentEventKind>> = Object.freeze({
  user_message: 'message',
  agent_message: 'message',
  message: 'message',
  reasoning: 'reasoning',
  command_execution: 'tool_call',
  file_change: 'patch',
  function_call: 'tool_call',
  custom_tool_call: 'tool_call',
  local_shell_call: 'tool_call',
  tool_search_call: 'tool_call',
  mcp_tool_call: 'tool_call',
  dynamic_tool_call: 'tool_call',
  collab_agent_tool_call: 'subagent',
  collab_tool_call: 'subagent',
  sub_agent_activity: 'subagent',
  plan: 'task',
  todo_list: 'task',
  hook_prompt: 'action',
  web_search: 'tool_call',
  web_search_call: 'tool_call',
  image_view: 'action',
  image_generation: 'tool_call',
  image_generation_call: 'tool_call',
  tool_search_output: 'tool_result',
  mcp_tool_call_output: 'tool_result',
  custom_tool_call_output: 'tool_result',
  extension: 'tool_call',
  entered_review_mode: 'action',
  exited_review_mode: 'action',
  context_compaction: 'checkpoint',
  function_call_output: 'tool_result',
  compaction: 'checkpoint',
  compaction_summary: 'checkpoint',
  configuration_update: 'action',
  compaction_trigger: 'action',
  error: 'error',
});

export type CodexItemLifecycle = 'item_started' | 'item_updated' | 'item_completed';

const CODEX_ITEM_SUMMARY_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  user_message: ['content', 'text'],
  agent_message: ['content', 'text'],
  message: ['content', 'text'],
  reasoning: ['summary_text', 'raw_content', 'text'],
  command_execution: ['command', 'aggregated_output', 'formatted_output', 'status'],
  function_call: ['name', 'arguments'],
  custom_tool_call: ['name', 'input'],
  local_shell_call: ['action', 'status'],
  tool_search_call: ['execution', 'arguments'],
  file_change: ['changes', 'status'],
  mcp_tool_call: ['tool', 'server', 'result', 'error', 'status'],
  dynamic_tool_call: ['tool', 'arguments', 'error', 'status'],
  collab_agent_tool_call: ['tool', 'prompt', 'status'],
  collab_tool_call: ['tool', 'prompt', 'status'],
  sub_agent_activity: ['kind', 'agent_path', 'agent_thread_id'],
  plan: ['text'],
  todo_list: ['items'],
  hook_prompt: ['fragments'],
  web_search: ['query', 'action'],
  web_search_call: ['action', 'status'],
  image_view: ['path'],
  image_generation: ['result', 'status'],
  image_generation_call: ['result', 'status'],
  tool_search_output: ['execution', 'status'],
  mcp_tool_call_output: ['output'],
  custom_tool_call_output: ['output'],
  extension: ['kind', 'query', 'action', 'results', 'result', 'output', 'status'],
  entered_review_mode: ['review', 'user_facing_hint'],
  exited_review_mode: ['review', 'review_output'],
  context_compaction: ['id'],
  function_call_output: ['output'],
  compaction: ['encrypted_content'],
  compaction_summary: ['encrypted_content'],
  configuration_update: ['reasoning'],
  compaction_trigger: ['type'],
  error: ['message'],
});

export interface CodexItemClassification {
  /** Original discriminator as written by the producer. */
  itemType?: string;
  /** Normalized discriminator used only for matching known source variants. */
  normalizedType?: string;
  eventKind: AgentEventKind;
  actor: AgentRowProjection['actor'];
  hasResult: boolean;
}

export function normalizeCodexItemType(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const normalized = type
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(CODEX_ITEM_KIND_MAP, normalized) ? normalized : undefined;
}

export function isKnownCodexItemType(type: string | undefined): boolean {
  return normalizeCodexItemType(type) !== undefined;
}

export function classifyCodexItem(
  item: Record<string, unknown> | undefined,
  lifecycle: CodexItemLifecycle = 'item_completed',
): CodexItemClassification {
  const itemType = typeof item?.type === 'string' ? item.type : undefined;
  const normalizedType = normalizeCodexItemType(itemType);
  const mappedKind = normalizedType === 'extension'
    ? extensionKind(item)
    : normalizedType ? CODEX_ITEM_KIND_MAP[normalizedType] : undefined;
  const hasResult = lifecycle === 'item_completed' && codexItemHasResult(item, normalizedType);
  const eventKind = mappedKind === 'tool_call' && hasResult ? 'tool_result' : (mappedKind ?? 'other');
  return {
    ...(itemType === undefined ? {} : { itemType }),
    ...(normalizedType === undefined ? {} : { normalizedType }),
    eventKind,
    actor: codexItemActor(eventKind, normalizedType),
    hasResult,
  };
}

export function codexItemHasResult(
  item: Record<string, unknown> | undefined,
  normalizedType = normalizeCodexItemType(typeof item?.type === 'string' ? item.type : undefined),
): boolean {
  if (!item || !normalizedType) return false;
  const status = typeof own(item, 'status') === 'string' ? String(own(item, 'status')).toLowerCase() : undefined;
  switch (normalizedType) {
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'mcp_tool_call_output':
    case 'tool_search_output':
      return true;
    case 'command_execution':
      return ['stdout', 'stderr', 'aggregated_output', 'formatted_output', 'exit_code'].some((key) => own(item, key) !== undefined);
    case 'mcp_tool_call':
    case 'dynamic_tool_call':
      return ['completed', 'failed', 'declined', 'interrupted'].includes(status ?? '')
        || own(item, 'result') !== undefined
        || own(item, 'error') !== undefined
        || own(item, 'content_items') !== undefined
        || own(item, 'success') !== undefined;
    case 'extension': {
      const extension = typeof own(item, 'kind') === 'string' ? String(own(item, 'kind')).toLowerCase() : '';
      if (extension === 'clock.sleep') return ['completed', 'failed', 'interrupted'].includes(status ?? '');
      return ['completed', 'failed', 'interrupted'].includes(status ?? '')
        || own(item, 'result') !== undefined
        || own(item, 'results') !== undefined
        || own(item, 'error') !== undefined
        || own(item, 'output') !== undefined;
    }
    case 'web_search':
      return ['completed', 'failed', 'interrupted'].includes(status ?? '')
        || own(item, 'action') !== undefined
        || own(item, 'result') !== undefined;
    case 'image_generation':
      return ['completed', 'failed', 'interrupted'].includes(status ?? '')
        || own(item, 'result') !== undefined
        || own(item, 'output') !== undefined;
    default:
      return false;
  }
}

export function codexItemActor(
  eventKind: AgentEventKind,
  normalizedType: string | undefined,
): AgentRowProjection['actor'] {
  if (eventKind === 'tool_result') return 'tool';
  if (eventKind === 'subagent') return 'agent';
  if (normalizedType === 'user_message') return 'user';
  if (eventKind === 'message' || eventKind === 'reasoning' || eventKind === 'tool_call'
    || eventKind === 'patch' || eventKind === 'task' || eventKind === 'action') return 'assistant';
  return 'system';
}

/** Pick a stable, human-useful source field for the row summary. */
export function codexItemSummaryKey(item: Record<string, unknown> | undefined): string | undefined {
  const normalizedType = normalizeCodexItemType(typeof item?.type === 'string' ? item.type : undefined);
  const candidates = normalizedType ? CODEX_ITEM_SUMMARY_KEYS[normalizedType] ?? [] : [];
  return candidates.find((key) => own(item ?? {}, key) !== undefined);
}

export function codexItemExtensionKind(item: Record<string, unknown> | undefined): string | undefined {
  if (normalizeCodexItemType(typeof item?.type === 'string' ? item.type : undefined) !== 'extension') return undefined;
  return typeof own(item ?? {}, 'kind') === 'string' ? String(own(item ?? {}, 'kind')) : undefined;
}

function extensionKind(item: Record<string, unknown> | undefined): AgentEventKind {
  const kind = typeof own(item ?? {}, 'kind') === 'string' ? String(own(item ?? {}, 'kind')).toLowerCase() : '';
  if (kind === 'clock.sleep') return 'action';
  if (kind === 'web.search' || kind === 'image_gen.generation') return 'tool_call';
  // The extension namespace is open-ended. Preserve an unknown kind in
  // `extensionKind`, but do not claim it executed a tool without source-owned
  // semantics.
  return 'other';
}
