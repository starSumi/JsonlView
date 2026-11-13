import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RowProjection } from '../../src/shared/types';
import { ConversationRow, conversationRowHeight } from '../../src/webview/features/record-query/conversation-row';

const base: RowProjection = { ref: { generation: 'g', ordinal: '9007199254740993', byteStart: '0',
  byteEndExclusive: '5', contentByteLength: '4', delimiterByteLength: 1, parseState: 'valid' },
  cells: [], genericSummary: 'Generic source record' };

describe('compact conversation cards', () => {
  it('shows bounded actual text, truncation and inert markup rather than the lossy table summary', () => {
    const row = { ...base, conversation: { parts: [{ role: 'user', label: 'Prompt', text: '<img src=x onerror=alert(1)>', path: { tokens: [] } }], truncated: true } };
    const markup = renderToStaticMarkup(<ConversationRow row={row} />);
    expect(markup).toContain('&lt;img');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('Preview limited');
    expect(markup).toContain('Open record');
    expect(conversationRowHeight(row)).toBe(132);
  });

  it('keeps tool, system, reasoning and unknown/error records as neutral physical strips', () => {
    expect(conversationRowHeight(base)).toBe(42);
    expect(renderToStaticMarkup(<ConversationRow row={base} />)).toContain('Generic source record');
    expect(renderToStaticMarkup(<ConversationRow row={{ ...base, ref: { ...base.ref, parseState: 'invalid_json' } }} />)).not.toContain('Agent');
    for (const role of ['tool', 'system', 'developer', 'reasoning']) {
      expect(conversationRowHeight({ ...base, conversation: { parts: [{ role, label: role, text: 'Event', path: { tokens: [] } }], truncated: false } })).toBe(42);
    }
  });
});
