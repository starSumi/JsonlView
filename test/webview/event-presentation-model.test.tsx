import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentEventPresentation } from '../../src/webview/features/event-presentation/AgentEventPresentation';
import { eventSectionKey, type AgentEventPresentationModel } from '../../src/webview/features/event-presentation/model';

describe('event presentation feature boundary', () => {
  it('keeps section identity stable while distinguishing display variants', () => {
    const base = { title: 'Message', text: 'hello' } as const;
    expect(eventSectionKey(base)).toBe(eventSectionKey({ ...base }));
    expect(eventSectionKey(base)).not.toBe(eventSectionKey({ ...base, contentMode: 'markdown' }));
    expect(eventSectionKey(base)).not.toBe(eventSectionKey({ ...base, copyText: 'alternate' }));
  });

  it('renders a bounded model supplied by the facade without owning provider parsing', () => {
    const model: AgentEventPresentationModel = {
      title: 'Agent · message',
      kind: 'message',
      metadata: [{ label: 'role', value: 'assistant' }],
      sections: [{ title: 'Message', text: 'feature-owned renderer' }],
    };
    const markup = renderToStaticMarkup(
      <AgentEventPresentation value={{ ignored: true }} buildModel={() => model} />,
    );
    expect(markup).toContain('feature-owned renderer');
    expect(markup).toContain('role');
  });
});
