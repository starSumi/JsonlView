import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATION_CHARACTERS,
  MAX_CONVERSATION_DEPTH,
  MAX_CONVERSATION_LABEL_CHARACTERS,
  MAX_CONVERSATION_PARTS,
  MAX_CONVERSATION_ROLE_CHARACTERS,
} from '../../src/shared/types';
import { createProtocolEnvelope, isExtensionMessage } from '../../src/shared/transport';
import { projectConversation } from '../../src/profiles/conversation-projection';

const part = { role: 'user', label: 'Message', text: 'Source text', path: { tokens: [{ kind: 'key', value: 'text' }] } };
function rows(conversation?: unknown) {
  return createProtocolEnvelope({
    type: 'ROWS', documentId: 'document', generation: 'generation', requestId: 'request', delivery: 'reply',
    payload: {
      rows: [{
        ref: { generation: 'generation', ordinal: '0', byteStart: '0', byteEndExclusive: '12', contentByteLength: '11', delimiterByteLength: 1, parseState: 'valid' },
        cells: [], genericSummary: 'Record', ...(conversation === undefined ? {} : { conversation }),
      }],
      columns: [], anchorOrdinal: '0', hasBefore: false, hasAfter: false, indexedRecords: '1',
    },
  });
}

describe('conversation receive boundary', () => {
  it('keeps legacy rows and neutral empty projections valid', () => {
    expect(isExtensionMessage(rows())).toBe(true);
    expect(isExtensionMessage(rows({ parts: [], truncated: false }))).toBe(true);
    expect(isExtensionMessage(rows({ parts: [], truncated: true }))).toBe(true);
  });

  it('accepts the shared aggregate and part bounds including complete Unicode pairs', () => {
    const parts = Array.from({ length: MAX_CONVERSATION_PARTS }, () => ({
      ...part, text: '😀'.repeat(MAX_CONVERSATION_CHARACTERS / MAX_CONVERSATION_PARTS / 2),
      role: 'r'.repeat(MAX_CONVERSATION_ROLE_CHARACTERS), label: 'l'.repeat(MAX_CONVERSATION_LABEL_CHARACTERS),
      path: { tokens: Array.from({ length: MAX_CONVERSATION_DEPTH }, (_, value) => ({ kind: 'index', value })) },
    }));
    expect(isExtensionMessage(rows({ parts, truncated: true }))).toBe(true);
  });

  it('accepts bounded producer output after long or malformed source text is sanitized', () => {
    const conversation = projectConversation({ messages: [{ role: 'assistant', content: 'a\uD800b\uDC00😀'.repeat(600) }] });
    expect(conversation.truncated).toBe(true);
    expect(isExtensionMessage(rows(conversation))).toBe(true);
  });

  it.each([
    null, [], {}, { parts: [], truncated: 'false' }, { parts: null, truncated: false },
    { parts: [null], truncated: false }, { parts: [{ ...part, text: '' }], truncated: false },
    { parts: [{ ...part, text: 1 }], truncated: false }, { parts: [{ ...part, role: '' }], truncated: false },
    { parts: [{ ...part, label: '' }], truncated: false },
    { parts: [{ ...part, role: 'r'.repeat(MAX_CONVERSATION_ROLE_CHARACTERS + 1) }], truncated: false },
    { parts: [{ ...part, label: 'l'.repeat(MAX_CONVERSATION_LABEL_CHARACTERS + 1) }], truncated: false },
    { parts: [{ ...part, text: 'x'.repeat(MAX_CONVERSATION_CHARACTERS + 1) }], truncated: false },
    { parts: Array.from({ length: MAX_CONVERSATION_PARTS + 1 }, () => part), truncated: true },
    { parts: [{ ...part, text: 'x'.repeat(MAX_CONVERSATION_CHARACTERS) }, part], truncated: true },
    { parts: [{ ...part, path: { tokens: Array.from({ length: MAX_CONVERSATION_DEPTH + 1 }, () => ({ kind: 'key', value: 'content' })) } }], truncated: true },
    { parts: [{ ...part, path: { tokens: [{ kind: 'index', value: -1 }] } }], truncated: false },
    { parts: [{ ...part, path: { tokens: [{ kind: 'key', value: 1 }] } }], truncated: false },
    { parts: [{ ...part, path: '$.text' }], truncated: false },
    { parts: [], truncated: false, body: 'unexpected source content' },
    { parts: [{ ...part, body: 'unexpected source content' }], truncated: false },
    { parts: [{ ...part, path: { tokens: [], body: 'unexpected source content' } }], truncated: false },
    { parts: [{ ...part, path: { tokens: [{ kind: 'key', value: 'x'.repeat(81) }] } }], truncated: false },
    { parts: [{ ...part, path: { tokens: [{ kind: 'key', value: 'text', body: 'unexpected' }] } }], truncated: false },
  ])('rejects malformed or over-budget conversation projections: %#', (conversation) => {
    expect(isExtensionMessage(rows(conversation))).toBe(false);
  });

  it.each(['text', 'role', 'label'])('rejects unpaired Unicode in %s without throwing', (field) => {
    for (const text of ['\uD800', '\uDC00', 'a\uD800b', 'a\uDC00b']) {
      expect(isExtensionMessage(rows({ parts: [{ ...part, [field]: text }], truncated: false }))).toBe(false);
    }
  });
});
