import { describe, expect, it } from 'vitest';
import { tokenizeCode } from '../../src/webview/code-syntax';

describe('bounded code syntax', () => {
  it('lexes common Python snippets without treating quoted comments as comments', () => {
    const result = tokenizeCode('if age >= 18:\n    print("# not a comment")\n# actual comment', 'python');
    expect(result.tokens.filter((token) => token.kind === 'keyword').map((token) => token.text)).toContain('if');
    expect(result.tokens.filter((token) => token.kind === 'string').map((token) => token.text)).toContain('"# not a comment"');
    expect(result.tokens.filter((token) => token.kind === 'comment').map((token) => token.text)).toContain('# actual comment');
  });

  it('handles JavaScript block comments and preserves unknown languages as source', () => {
    const javascript = tokenizeCode('const answer = 42; /* note */', 'typescript');
    expect(javascript.tokens.some((token) => token.kind === 'keyword' && token.text === 'const')).toBe(true);
    expect(javascript.tokens.some((token) => token.kind === 'comment' && token.text === '/* note */')).toBe(true);
    const unknown = tokenizeCode('some <syntax> stays source', 'invented-language');
    expect(unknown.tokens.every((token) => token.kind === 'plain')).toBe(true);
  });

  it('caps highlighting while retaining the complete source boundary', () => {
    const result = tokenizeCode('x'.repeat(20), 'python', { maxChars: 8 });
    expect(result.truncated).toBe(true);
    expect(result.displayedChars).toBe(8);
    expect(result.tokens.map((token) => token.text).join('')).toBe('xxxxxxxx');
  });
});
