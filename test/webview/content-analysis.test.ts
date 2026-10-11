import { describe, expect, it } from 'vitest';
import {
  classifyContent,
  extractEmbeddedJson,
  inferCodeLanguage,
  normalizeMarkdownSource,
  parseJsonObjectOrArray,
} from '../../src/webview/content-analysis';

describe('content analysis', () => {
  it('classifies complete JSON independently of the React renderer', () => {
    expect(classifyContent('{"role":"assistant","ok":true}')).toBe('json');
    expect(parseJsonObjectOrArray('{"nested":{"value":1}}')).toEqual({ nested: { value: 1 } });
  });

  it('recovers bounded JSON objects embedded in prose', () => {
    const source = 'tool output: {"status":"ok","items":[1,2]}';
    expect(extractEmbeddedJson(source)).toMatchObject([{ start: 13, end: source.length, source: source.slice(13) }]);
  });

  it('normalizes numbered ANSI output only for Markdown classification', () => {
    const source = '\u001b[32m1: # Result\u001b[0m\n\u001b[32m2: - ready\u001b[0m';
    expect(normalizeMarkdownSource(source)).toBe('# Result\n- ready');
    expect(classifyContent(source)).toBe('markdown');
  });

  it('keeps language inference conservative and honors explicit hints', () => {
    expect(inferCodeLanguage('cargo test\nif [ -f package.json ]; then echo ready; fi')).toBe('shell');
    expect(inferCodeLanguage('const answer = await run();')).toBe('javascript');
    expect(inferCodeLanguage('ordinary text', 'custom')).toBe('custom');
    expect(inferCodeLanguage('ordinary text')).toBeUndefined();
  });
});
