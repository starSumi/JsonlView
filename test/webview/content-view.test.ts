import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { classifyContent, ContentView, extractEmbeddedJson } from '../../src/webview/content-view';

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

  it('bounds rich parsing while keeping the Text mode available', () => {
    const source = `${'# heading\n\n'}${'x'.repeat(70_000)}`;
    const markup = renderToStaticMarkup(React.createElement(ContentView, { text: source }));
    expect(markup).toContain('Rich parsing is limited to the first 65,536 characters');
    expect(markup).toContain('Text keeps the complete value');
  });
});
