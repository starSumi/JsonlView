import { describe, expect, it } from 'vitest';
import { buildAgentEventPresentation, AgentEventPresentation } from '../../src/webview/event-presentation';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

describe('structured agent event presentation', () => {
  it('formats Codex response messages without losing the raw payload', () => {
    const value = {
      timestamp: '2026-08-19T03:09:01.349Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'first line\nsecond line' }],
        turn_id: 'turn-1',
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout',
      eventKind: 'message',
      summary: 'message',
      turnId: 'turn-1',
      evidence: [],
      confidence: 'source',
    });

    expect(model?.title).toBe('Codex · message');
    expect(model?.metadata).toContainEqual({ label: 'role', value: 'assistant' });
    expect(model?.sections[0]?.text).toContain('first line\nsecond line');
  });

  it('recognizes completed Codex AgentMessage Text blocks as rich Markdown content', () => {
    const value = {
      timestamp: '2026-09-02T10:48:17.959Z',
      ordinal: 24,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'AgentMessage',
          content: [{
            type: 'Text',
            text: '## Python\n\n> Indent blocks.\n\n```python\nprint("hello")\n```',
          }],
        },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source',
    });
    expect(model?.kind).toBe('AgentMessage');
    expect(model?.sections[0]).toMatchObject({ title: 'Message', richText: true });
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value,
      profile: { profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source' },
    }));
    expect(markup).toContain('<h2>Python</h2>');
    expect(markup).toContain('>Indent blocks.</blockquote>');
    expect(markup).toContain('>python</span>');
    expect(markup).toContain('print(');
    expect(markup).toContain('code-token-string');
    expect(markup).toContain('&quot;hello&quot;');
  });

  it('renders tool calls in a bounded container and ignores non-events', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value: {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: { command: 'pnpm test' } },
      },
      profile: {
        profileId: 'codex-rollout',
        eventKind: 'tool_call',
        summary: 'shell',
        evidence: [],
        confidence: 'source',
      },
    }));

    expect(markup).toContain('Structured event view');
    expect(markup).toContain('Tool call');
    expect(markup).toContain('pnpm test');
    expect(markup).toContain('aria-label="Copy Tool call"');
    expect(buildAgentEventPresentation({ message: 'plain record' })).toBeUndefined();
  });

  it('treats thread and turn items as structured containers', () => {
    const thread = buildAgentEventPresentation({
      type: 'thread_item',
      payload: { type: 'message', role: 'user', text: 'line one\nline two' },
    });
    const turn = buildAgentEventPresentation({
      type: 'turn_item',
      payload: { turn_id: 't-9', status: 'completed' },
    });

    expect(thread?.sections[0]?.text).toBe('line one\nline two');
    expect(turn?.metadata).toContainEqual({ label: 'turn', value: 't-9' });
  });

  it('keeps long event text available behind an explicit full-view control', () => {
    const longText = 'line\n'.repeat(2_500);
    const model = buildAgentEventPresentation({ type: 'message', role: 'developer', content: longText }, {
      profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source',
    });
    expect(model?.sections[0]?.truncated).toBe(true);
    expect(model?.sections[0]?.fullText).toBe(longText);
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value: { type: 'message', role: 'developer', content: longText },
      profile: { profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source' },
    }));
    expect(markup).toContain('Show full');
    expect(markup).toContain('[preview truncated]');
  });

  it('presents current Claude control records with their semantic prompt content', () => {
    const value = {
      type: 'last-prompt',
      lastPrompt: 'Explain OPFS',
      sessionId: 'session-redacted',
    };
    const profile = {
      profileId: 'claude-code-session', eventKind: 'message' as const, actor: 'user' as const,
      sessionId: 'session-redacted', summary: 'Last prompt: Explain OPFS', evidence: [], confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);

    expect(model).toMatchObject({ title: 'Claude · last-prompt', kind: 'last-prompt' });
    expect(model?.metadata).toContainEqual({ label: 'role', value: 'user' });
    expect(model?.sections[0]).toMatchObject({ title: 'Prompt', text: 'Explain OPFS' });
  });
});
