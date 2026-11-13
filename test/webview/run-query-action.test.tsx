import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunQueryAction, type RunQueryActionProps } from '../../src/webview/features/record-query/RunQueryAction';

function action(overrides: Partial<RunQueryActionProps> = {}) {
  const props = { pending: false, disabled: false, onRun: vi.fn(), onCancel: vi.fn(), ...overrides };
  const element = RunQueryAction(props);
  const children = React.Children.toArray(element.props.children as React.ReactNode);
  const button = children[1] as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>;
  return { props, element, button, markup: renderToStaticMarkup(element) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Run query capsule', () => {
  it('runs from an enabled native button with a platform shortcut hint', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const { props, button, markup } = action();
    button.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(props.onRun).toHaveBeenCalledOnce();
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(button.type).toBe('button');
    expect(button.props.type).toBe('button');
    expect(markup).toContain('aria-label="Run query"');
    expect(markup).toContain('Control+Enter Meta+Enter');
    expect(markup).toContain('Ctrl+Enter</kbd>');
  });

  it('disables Run and guards its callback even when called programmatically', () => {
    const { props, button } = action({ disabled: true });
    button.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(button.props.disabled).toBe(true);
    expect(button.props['aria-disabled']).toBe(true);
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it('keeps Cancel enabled while pending and never runs again', () => {
    const { props, button, markup } = action({ pending: true, disabled: true });
    button.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(button.props.disabled).toBe(false);
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(markup).toContain('Scanning…');
    expect(markup).not.toContain('<kbd');
    expect(markup).not.toMatch(/Scanning[^<]*\d/u);
  });

  it('separates live status from its one native button and keeps button position stable', () => {
    const ready = action();
    const pending = action({ pending: true });
    for (const { element, markup } of [ready, pending]) {
      const children = React.Children.toArray(element.props.children as React.ReactNode);
      expect((children[0] as React.ReactElement).type).toBe('span');
      expect((children[1] as React.ReactElement).type).toBe('button');
      expect(markup.match(/<button /gu)).toHaveLength(1);
      expect(markup).toMatch(/role="status"[^>]*>[\s\S]*?<\/span><button/u);
    }
  });

  it('provides normal and compact geometry and a Mac shortcut hint', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(action().markup).toContain('size-normal');
    const compact = action({ size: 'compact' }).markup;
    expect(compact).toContain('size-compact');
    expect(compact).toContain('⌘↵</kbd>');
    expect(compact).toContain('Run query (⌘+Enter)');
  });
});
