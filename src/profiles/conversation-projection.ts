import type { AgentRowProjection, ConversationProjection, FieldPath, PathToken } from '../shared/types';

export const MAX_CONVERSATION_CHARACTERS = 2048;
export const MAX_CONVERSATION_PARTS = 8;
export const MAX_CONVERSATION_DEPTH = 12;
export const MAX_CONVERSATION_VISITS = 96;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const roles: Record<string, string> = { human: 'user', gpt: 'assistant', model: 'assistant', observation: 'tool' };
const childPath = (path: FieldPath, value: string | number): FieldPath => ({
  tokens: [...path.tokens, { kind: typeof value === 'number' ? 'index' : 'key', value } as PathToken],
});

/** A UTF-16 cap that never introduces a split surrogate or forwards malformed Unicode. */
function boundedText(value: string, limit: number): string {
  let text = value.slice(0, limit);
  if (text.length < value.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** Extract only known textual slots; never traverse arbitrary metadata or resolve media/tool paths. */
export function projectConversation(value: unknown, profile?: AgentRowProjection): ConversationProjection {
  const result: ConversationProjection = { parts: [], truncated: false };
  let remaining = MAX_CONVERSATION_CHARACTERS;
  let visits = 0;
  const add = (value: string, path: FieldPath, role: string, label: string): void => {
    if (!value) return;
    if (result.parts.length >= MAX_CONVERSATION_PARTS || remaining <= 0) { result.truncated = true; return; }
    const text = boundedText(value, remaining);
    result.truncated ||= text.length < value.length;
    remaining -= text.length;
    if (text) result.parts.push({ role: boundedText(role, 32), label: boundedText(label, 40), text, path });
  };
  const visit = (value: unknown, path: FieldPath, role: string, label: string): void => {
    if (++visits > MAX_CONVERSATION_VISITS || path.tokens.length > MAX_CONVERSATION_DEPTH) { result.truncated = true; return; }
    if (typeof value === 'string') { add(value, path, role, label); return; }
    if (Array.isArray(value)) {
      let index = 0;
      for (; index < value.length && visits < MAX_CONVERSATION_VISITS; index++) {
        visit(value[index], childPath(path, index), role, label);
      }
      result.truncated ||= index < value.length;
      return;
    }
    const item = object(value);
    if (!item) return;
    const explicit = typeof item.role === 'string' ? item.role : typeof item.from === 'string' ? item.from : role;
    const nextRole = (Object.hasOwn(roles, explicit) ? roles[explicit] : undefined) ?? explicit;
    // Image, audio, binary and externalized outputs stay opaque even when they contain a text-like URL.
    if (typeof item.type === 'string' && /image|audio|video|file|base64/i.test(item.type)) {
      result.truncated = true;
      return;
    }
    for (const key of ['messages', 'conversations', 'message', 'content', 'parts']) {
      if (item[key] !== undefined) { visit(item[key], childPath(path, key), nextRole, label); return; }
    }
    for (const key of ['text', 'think', 'thinking', 'reasoning', 'value', 'body', 'delta', 'aggregated_output']) {
      if (typeof item[key] === 'string') {
        const reasoning = key === 'think' || key === 'thinking' || key === 'reasoning';
        visit(item[key], childPath(path, key), reasoning ? 'reasoning' : nextRole, reasoning ? 'Reasoning' : label);
        return;
      }
    }
    const datasetSlots = [
      ['instruction', 'user', 'Instruction'], ['prompt', 'user', 'Prompt'], ['question', 'user', 'Question'],
      ['context', 'context', 'Context'], ['input', 'user', 'Input'], ['output', 'assistant', 'Response'],
      ['answer', 'assistant', 'Answer'], ['chosen', 'assistant', 'Chosen'], ['rejected', 'assistant', 'Rejected'],
    ] as const;
    let found = false;
    for (const [key, slotRole, slotLabel] of datasetSlots) {
      if (typeof item[key] === 'string' || Array.isArray(item[key])) {
        const toolOutput = key === 'output' && (nextRole === 'tool' || profile?.eventKind === 'tool_result');
        found = true; visit(item[key], childPath(path, key), toolOutput ? 'tool' : slotRole, toolOutput ? 'Tool result' : slotLabel);
      }
    }
    if (found) return;
    for (const key of ['payload', 'item', 'event', 'part', 'data', 'params', 'result']) {
      if (object(item[key])) { visit(item[key], childPath(path, key), nextRole, label); return; }
    }
  };
  visit(value, { tokens: [] }, profile?.actor ?? 'unknown', profile?.eventKind ?? 'Record');
  return result;
}
