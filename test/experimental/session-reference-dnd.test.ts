import { describe, expect, it } from 'vitest';
import { parseSessionReferenceDragPayload } from '../../src/experimental/session-navigator/session-reference-dnd';

const reference = { providerId: 'codex', sourceId: 'source-a', nativeId: 'thread-a', generation: '4' };

describe('session reference drag payload', () => {
  it('accepts the bounded versioned reference shape and removes duplicate entries', () => {
    expect(parseSessionReferenceDragPayload(JSON.stringify({ version: 1, references: [reference, reference] }))).toEqual({
      version: 1, references: [reference],
    });
  });

  it.each([
    '', '{', JSON.stringify({ version: 2, references: [reference] }),
    JSON.stringify({ version: 1, references: [{ ...reference, canonicalUri: 'file:///private' }] }),
    JSON.stringify({ version: 1, references: [] }),
    JSON.stringify({ version: 1, references: [null] }),
    JSON.stringify({ version: 1, references: [{ ...reference, generation: '' }] }),
  ])('rejects malformed or non-versioned transfer content', (text) => {
    expect(parseSessionReferenceDragPayload(text)).toBeUndefined();
  });

  it('rejects payloads larger than 64 KiB and selections larger than 32 references', () => {
    expect(parseSessionReferenceDragPayload(' '.repeat(64 * 1024 + 1))).toBeUndefined();
    const references = Array.from({ length: 33 }, (_, index) => ({ ...reference, nativeId: 'thread-' + String(index) }));
    expect(parseSessionReferenceDragPayload(JSON.stringify({ version: 1, references }))).toBeUndefined();
  });
});
