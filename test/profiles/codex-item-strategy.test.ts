import { describe, expect, it } from 'vitest';
import {
  classifyCodexItem,
  codexItemExtensionKind,
  normalizeCodexItemType,
} from '../../src/profiles/codex-item-strategy';

describe('Codex item strategy', () => {
  it('normalizes flat CamelCase response and turn item discriminators', () => {
    expect(normalizeCodexItemType('CommandExecution')).toBe('command_execution');
    expect(normalizeCodexItemType('customToolCall')).toBe('custom_tool_call');
    expect(normalizeCodexItemType('CustomToolCallOutput')).toBe('custom_tool_call_output');

    expect(classifyCodexItem({ type: 'CustomToolCall', name: 'exec', input: 'text(1);' }, 'item_started'))
      .toMatchObject({ itemType: 'CustomToolCall', normalizedType: 'custom_tool_call', eventKind: 'tool_call' });
    expect(classifyCodexItem({ type: 'CustomToolCallOutput', output: 'done' }))
      .toMatchObject({ itemType: 'CustomToolCallOutput', normalizedType: 'custom_tool_call_output', eventKind: 'tool_result' });
  });

  it('does not infer tool semantics for an unknown Extension kind', () => {
    const item = { type: 'Extension', id: 'extension-unknown', kind: 'future.namespace', output: 'opaque' };
    const classification = classifyCodexItem(item);

    expect(classification).toMatchObject({
      itemType: 'Extension',
      normalizedType: 'extension',
      eventKind: 'other',
      actor: 'system',
    });
    expect(codexItemExtensionKind(item)).toBe('future.namespace');
  });

  it('keeps source-owned Extension kinds distinct', () => {
    expect(classifyCodexItem({ type: 'Extension', kind: 'clock.sleep', status: 'completed' }))
      .toMatchObject({ eventKind: 'action', actor: 'assistant' });
    expect(classifyCodexItem({ type: 'Extension', kind: 'web.search', results: [] }))
      .toMatchObject({ eventKind: 'tool_result', actor: 'tool' });
    expect(classifyCodexItem({ type: 'Extension', kind: 'image_gen.generation' }, 'item_started'))
      .toMatchObject({ eventKind: 'tool_call', actor: 'assistant' });
  });
});
