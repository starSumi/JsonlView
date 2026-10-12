import { describe, expect, it } from 'vitest';
import { claudeToolSections } from '../../src/webview/providers/claude-tool-projection';

describe('claude tool projection', () => {
  it('keeps command and file output projections in source order', () => {
    const sections = claudeToolSections({
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
          { type: 'tool_result', tool_use_id: 'tool-redacted' },
        ],
      },
      toolUseResult: {
        type: 'text',
        file: { filePath: 'C:/redacted/app.ts', content: 'export const ready = true;', startLine: 4, numLines: 1 },
      },
    });

    expect(sections.map((section) => section.title)).toEqual([
      'Command 1',
      'Read · C:/redacted/app.ts · from line 4 · 1 lines',
      'Read metadata',
    ]);
    expect(sections[0]).toMatchObject({ kind: 'code', value: 'pnpm test', language: 'shell' });
    expect(sections[1]).toMatchObject({ kind: 'code', value: 'export const ready = true;' });
  });

  it('falls back to bounded metadata for malformed patches and unknown tool results', () => {
    const malformed = claudeToolSections({
      message: { content: [{ type: 'tool_result' }] },
      toolUseResult: { filePath: 'C:/redacted/app.ts', structuredPatch: [{ oldStart: 'bad', lines: [] }] },
    });
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toMatchObject({ title: 'Tool metadata', kind: 'json' });

    const unknown = claudeToolSections({
      message: { content: [{ type: 'tool_use', name: 'FutureTool', input: { future: true } }, { type: 'tool_result' }] },
      toolUseResult: { type: 'future_result', opaque: { value: true } },
    });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ title: 'Tool metadata', kind: 'json' });
  });

  it('bounds oversized tool output without throwing or emitting an unbounded text section', () => {
    const sections = claudeToolSections({
      message: { content: [{ type: 'tool_result' }] },
      toolUseResult: { stdout: 'x'.repeat(200_000) },
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: 'stdout', kind: 'text', truncated: true });
    expect(typeof sections[0]?.value).toBe('string');
    expect(sections[0]?.value).toHaveLength(128 * 1024);
  });
});
