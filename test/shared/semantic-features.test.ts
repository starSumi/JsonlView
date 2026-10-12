import { describe, expect, it } from 'vitest';
import { bestSemanticFeature, findSemanticFeatures } from '../../src/shared/semantic-features';

describe('semantic feature matching', () => {
  it('selects nested content by key meaning and value shape', () => {
    const value = {
      content: {
        type: 'User',
        content: '# Redacted memory',
        rawContent: 'raw-content-redacted',
      },
    };
    const match = bestSemanticFeature(value, [{ id: 'content', keys: ['content'], weight: 1.1 }]);
    expect(match?.value).toBe('# Redacted memory');
    expect(match?.path.tokens).toEqual([
      { kind: 'key', value: 'content' },
      { kind: 'key', value: 'content' },
    ]);
  });

  it('bounds traversal and handles cyclic values without provider-specific indexes', () => {
    const value: Record<string, unknown> = { blocks: [{ text: 'noise' }] };
    value.self = value;
    const matches = findSemanticFeatures(value, [{ id: 'text', keys: ['text'] }], { maxNodes: 8 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe('noise');
  });
});
