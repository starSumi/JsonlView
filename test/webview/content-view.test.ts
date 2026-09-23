import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { classifyContent, ContentView, extractEmbeddedJson, inferCodeLanguage, normalizeMarkdownSource } from '../../src/webview/content-view';

describe('bounded event content renderer', () => {
  it('recognizes complete JSON and keeps an embedded object inside prose parseable', () => {
    expect(classifyContent('{"role":"assistant","ok":true}')).toBe('json');
    const candidates = extractEmbeddedJson('payload: {"role":"assistant","ok":true}');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.value).toEqual({ role: 'assistant', ok: true });
    const markup = renderToStaticMarkup(React.createElement(ContentView, {
      text: 'payload: {"role":"assistant","ok":true}',
    }));
    expect(markup).toContain('Embedded JSON');
    expect(markup).toContain('json-fold-view');
  });

  it('auto-selects the JSON container for pretty JSON text instead of Markdown', () => {
    const source = JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', arguments: { task_name: 'runtime_probe' } },
    }, null, 2);
    expect(classifyContent(source)).toBe('json');
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(markup).toContain('Detected: json');
    expect(markup).toContain('json-fold-view');
    expect(markup).toContain('JSON block at line');
    expect(markup).toContain('spawn_agent');
    expect(markup).not.toContain('content-markdown');
  });

  it('unwraps a JSON document that was serialized twice by a tool bridge', () => {
    const source = JSON.stringify(JSON.stringify({ command: 'pnpm test', status: 'completed' }));
    expect(classifyContent(source)).toBe('json');
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(markup).toContain('Detected: json');
    expect(markup).toContain('json-fold-view');
    expect(markup).toContain('pnpm test');
  });

  it('infers only strong code signals and keeps ambiguous output as text', () => {
    expect(inferCodeLanguage('cargo test\nif [ -f package.json ]; then echo ready; fi')).toBe('shell');
    expect(inferCodeLanguage('use std::path::Path;\nfn main() { let value = 1; }')).toBe('rust');
    expect(inferCodeLanguage('a normal line\nanother normal line')).toBeUndefined();
  });

  it('renders conservative Markdown blocks without injecting raw HTML', () => {
    const source = '# Summary\n\n- first\n- second\n\n```json\n{"count":2}\n```';
    expect(classifyContent(source)).toBe('markdown');
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(markup).toContain('content-markdown');
    expect(markup).toContain('<h1>Summary</h1>');
    expect(markup).toContain('<ul><li>first</li><li>second</li></ul>');
    expect(markup).toContain('json-fold-view');
    expect(markup).toContain('Copy json block');
    expect(markup).toContain('aria-pressed="false">Wrap</button>');
    expect(markup).not.toContain('<script');
  });

  it('keeps ordinary Markdown source safe and preserves readable soft line breaks', () => {
    const markup = renderToStaticMarkup(React.createElement(ContentView, {
      text: 'line one\nline two\n\n[OpenAI](https://openai.com) <script>alert(1)</script>',
      defaultMode: 'markdown',
    }));
    expect(markup).toContain('<p>line one<br/>line two</p>');
    expect(markup).toContain('href="https://openai.com"');
    expect(markup).toContain('>OpenAI</a>');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('exposes explicit format switches and reports preview boundaries', () => {
    const markup = renderToStaticMarkup(React.createElement(ContentView, {
      text: 'line one\nline two',
      truncated: true,
    }));
    expect(markup).toContain('Content format');
    expect(markup).toContain('>Auto</button>');
    expect(markup).toContain('>Text</button>');
    expect(markup).toContain('>Markdown</button>');
    expect(markup).toContain('>JSON</button>');
    expect(markup).toContain('Preview limited to 8,000 characters');
  });

  it('keeps malformed or unclosed fenced content as code instead of guessing JSON', () => {
    const source = '```json\n{"broken":\n';
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(classifyContent(source)).toBe('markdown');
    expect(markup).toContain('class="content-code"');
    expect(markup).not.toContain('json-fold-view');
  });

  it('only closes a fenced block with a matching marker of sufficient length', () => {
    const source = '````python\nprint("still code")\n~~~\n````';
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(markup).toContain('print(');
    expect(markup).toContain('code-token-string');
    expect(markup).toContain('&quot;still code&quot;');
    expect(markup).toContain('~~~');
    expect(markup).toContain('>python</span>');
  });

  it('bounds every rendered content mode while keeping Raw and Copy as the full-value route', () => {
    const source = `${'# heading\n\n'}${'x'.repeat(70_000)}`;
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source, truncated: true }));
    expect(markup).toContain('Rendering is limited to the first 65,536 characters');
    expect(markup).toContain('use Raw or Copy for the complete value');
    expect(markup).not.toContain('x'.repeat(70_000));
  });

  it('raises the structural parse budget after an explicit full-value expansion', () => {
    const source = JSON.stringify({
      items: Array.from({ length: 200 }, () => 'x'.repeat(500)),
      tail: 'complete',
    });
    const preview = renderToStaticMarkup(React.createElement(ContentView, { text: source.slice(0, 8_000), truncated: true, defaultMode: 'json' }));
    const expanded = renderToStaticMarkup(React.createElement(ContentView, { text: source, defaultMode: 'json' }));
    expect(preview).not.toContain('"tail"');
    expect(expanded).toContain('&quot;tail&quot;');
    expect(expanded).not.toContain('Rich parsing is limited to the first 65,536 characters');
  });

  it('scans a long run of unclosed delimiters once instead of rescanning each start', () => {
    const source = '{'.repeat(64 * 1024);
    expect(extractEmbeddedJson(source)).toEqual([]);
  });

  it('recovers a valid inner object from an unclosed outer span', () => {
    const source = `${'{'.repeat(2_048)}{"ok":true}`;
    const candidates = extractEmbeddedJson(source);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.value).toEqual({ ok: true });
  });

  it('prefers a complete outer JSON value over its nested values', () => {
    const candidates = extractEmbeddedJson('payload: {"outer":{"inner":true}}');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.value).toEqual({ outer: { inner: true } });
  });

  it('resets after mismatched delimiters and finds a later valid value', () => {
    const candidates = extractEmbeddedJson('broken: {[oops} then {"ok":true}');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.value).toEqual({ ok: true });
  });

  it('does not let an ordinary prose quote hide a later JSON value', () => {
    const candidates = extractEmbeddedJson('The note says "payload" before {"ok":true}.');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.value).toEqual({ ok: true });
  });

  it('normalizes terminal colour codes and line-numbered Markdown only for rich views', () => {
    const source = '\u001b[32;1m2:# qwen\u001b[0m\n5:### model\n9:- **trained**';
    expect(normalizeMarkdownSource(source)).toBe('# qwen\n### model\n- **trained**');
    expect(classifyContent(source)).toBe('markdown');
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(markup).toContain('<h1>qwen</h1>');
    expect(markup).toContain('<h3>model</h3>');
    expect(markup).toContain('<strong>trained</strong>');
  });
});
