import { describe, expect, it } from 'vitest';
import { queryStudioShortcut } from '../../src/webview/features/record-query/query-studio-keyboard';

describe('Top Query Studio keyboard scope', () => {
  it('handles Escape and modified Enter only inside the studio', () => {
    expect(queryStudioShortcut({ key: 'Escape', ctrlKey: false, metaKey: false, isComposing: false, insideStudio: true })).toBe('close');
    expect(queryStudioShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, insideStudio: true })).toBe('run');
    expect(queryStudioShortcut({ key: 'Enter', ctrlKey: false, metaKey: true, isComposing: false, insideStudio: true })).toBe('run');
    expect(queryStudioShortcut({ key: 'Enter', ctrlKey: false, metaKey: false, isComposing: false, insideStudio: true })).toBeUndefined();
  });

  it('does not consume external focus or IME composition', () => {
    expect(queryStudioShortcut({ key: 'Escape', ctrlKey: false, metaKey: false, isComposing: false, insideStudio: false })).toBeUndefined();
    expect(queryStudioShortcut({ key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true, insideStudio: true })).toBeUndefined();
  });

  it('cancels a running query with Escape even when new queries are disabled', () => {
    expect(queryStudioShortcut({ key: 'Escape', ctrlKey: false, metaKey: false, isComposing: false,
      insideStudio: true, pending: true, disabled: true })).toBe('cancel');
    expect(queryStudioShortcut({ key: 'Escape', ctrlKey: false, metaKey: false, isComposing: true,
      insideStudio: true, pending: true })).toBeUndefined();
  });

  it.each([{ pending: true }, { disabled: true }])('blocks both modified Enter shortcuts when unavailable: %j', (state) => {
    for (const modifiers of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }]) {
      expect(queryStudioShortcut({ key: 'Enter', ...modifiers, isComposing: false, insideStudio: true, ...state })).toBeUndefined();
    }
  });
});
