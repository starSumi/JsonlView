import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { prettyPrintRawJson, RawJsonView } from '../../src/webview/json-raw';
import { buildJsonFoldLines, JsonCode, stringifyJsonBounded, tokenizeJson, visibleJsonFoldLines } from '../../src/webview/json-syntax';

describe('JSON syntax rendering helpers', () => {
  it('classifies JSON keys and scalar values without changing source text', () => {
    const source = '{"key":"<script>alert(1)</script>","n":12.5,"ok":true,"empty":null}';
    const result = tokenizeJson(source);

    expect(result.tokens.map((token) => token.text).join('')).toBe(source);
    expect(result.tokens.filter((token) => token.kind === 'key').map((token) => token.text)).toEqual([
      '"key"', '"n"', '"ok"', '"empty"',
    ]);
    expect(result.tokens.some((token) => token.kind === 'string' && token.text.includes('<script>'))).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'number' && token.text === '12.5')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'boolean' && token.text === 'true')).toBe(true);
    expect(result.tokens.some((token) => token.kind === 'null' && token.text === 'null')).toBe(true);
  });

  it('bounds both highlighted characters and syntax token nodes', () => {
    const result = tokenizeJson(JSON.stringify(Array.from({ length: 1_000 }, (_, index) => index)), {
      maxChars: 80,
      maxTokens: 5,
    });

    expect(result.truncated).toBe(true);
    expect(result.displayedChars).toBe(80);
    expect(result.tokens.length).toBeLessThanOrEqual(6);
    expect(result.tokens.map((token) => token.text).join('').length).toBe(80);
  });

  it('bounds derived structures before serializing them', () => {
    const cyclic: { items: string[]; self?: unknown } = {
      items: Array.from({ length: 100 }, () => 'x'.repeat(100)),
    };
    cyclic.self = cyclic;

    const result = stringifyJsonBounded(cyclic, {
      maxChars: 400,
      maxChildren: 3,
      maxStringChars: 10,
    });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(400);
    expect(result.text).toContain('[Circular]');
    expect(result.text).toContain('more items');
  });

  it('pretty prints only complete valid raw JSON', () => {
    const source = '{"message":"hello","count":2}';

    expect(prettyPrintRawJson(source, true, 'valid')?.text).toBe(`{\n  "message": "hello",\n  "count": 2\n}`);
    expect(prettyPrintRawJson(source, false, 'valid')).toBeUndefined();
    expect(prettyPrintRawJson('{broken', true, 'valid')).toBeUndefined();
    expect(prettyPrintRawJson(source, true, 'invalid_json')).toBeUndefined();
  });

  it('keeps ordinary multi-kilobyte strings intact in Pretty mode', () => {
    const source = JSON.stringify({ message: 'x'.repeat(18_000), kind: 'session_meta' });
    const pretty = prettyPrintRawJson(source, true, 'valid');

    expect(pretty?.truncated).toBe(false);
    expect(pretty?.text).toContain('x'.repeat(18_000));
    expect(pretty?.text).not.toContain('[truncated]');
  });

  it('retains exact source after the bounded highlighted prefix', () => {
    const source = '{"value":"' + 'x'.repeat(200) + '"}';
    const highlighted = tokenizeJson(source, { maxChars: 32, maxTokens: 4 });
    const reconstructed = highlighted.tokens.map((token) => token.text).join('')
      + source.slice(highlighted.displayedChars);

    expect(reconstructed).toBe(source);
  });

  it('renders an accessible Pretty default and escapes source content', () => {
    const source = '{"value":"<script>alert(1)</script>"}';
    const markup = renderToStaticMarkup(React.createElement(RawJsonView, {
      source,
      rawComplete: true,
      parseState: 'valid',
    }));

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Raw JSON display"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Pretty<\/button>/);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Wrap<\/button>/);
    expect(markup).toContain('aria-label="Copy JSON"');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });

  it('builds fold ranges from pretty JSON while ignoring braces inside strings', () => {
    const source = '{\n  "outer": {\n    "message": "not a } block",\n    "items": [\n      1\n    ]\n  },\n  "tail": true\n}';
    const lines = buildJsonFoldLines(source);

    expect(lines[0]?.foldEndLine).toBe(8);
    expect(lines[1]?.foldEndLine).toBe(6);
    expect(lines[3]?.foldEndLine).toBe(5);
    expect(visibleJsonFoldLines(lines, new Set([1])).map((line) => line.lineNumber)).toEqual([0, 1, 6, 7, 8]);
  });

  it('renders line numbers and accessible fold controls for pretty JSON', () => {
    const markup = renderToStaticMarkup(React.createElement(JsonCode, {
      source: '{\n  "nested": {\n    "value": true\n  }\n}',
      ariaLabel: 'Pretty JSON',
      collapsible: true,
    }));

    expect(markup).toContain('class="json-code json-fold-view"');
    expect(markup).toContain('json-line-number');
    expect(markup).toContain('aria-label="Collapse JSON block at line 1"');
    expect(markup).toContain('aria-label="Collapse JSON block at line 2"');
    expect(markup).toContain('json-token-key');
    expect(markup).toContain('json-token-boolean');
  });

  it('falls back to Source and disables Pretty for incomplete JSON', () => {
    const markup = renderToStaticMarkup(React.createElement(RawJsonView, {
      source: '{"unfinished":',
      rawComplete: false,
      parseState: 'oversized',
    }));

    expect(markup).toMatch(/aria-pressed="false" disabled=""[^>]*>Pretty<\/button>/);
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Source<\/button>/);
    expect(markup).toContain('class="json-code json-source json-wrap"');
    expect(markup).toContain('aria-label="Copy JSON"');
  });
});
