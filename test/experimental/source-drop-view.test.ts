import type * as vscode from 'vscode';
import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SourceImportCanvas, parseSourceDropMessage, type SourceDropCallbacks } from '../../src/experimental/session-navigator/source-drop-view';
import { getSourceDropHtml } from '../../src/experimental/session-navigator/source-drop-html';
import { isIntakeStatusReply } from '../../src/shared/contracts/intake';
import type { SessionPreview } from '../../src/experimental/session-navigator/session-previews';

const previewReceipt = {
  id: 'synthetic-preview', createdAt: 1, recordCount: 1, sizeBytes: 3,
  sourceUri: { fsPath: 'C:/Temp/preview.jsonl', toString: () => 'file:///C:/Temp/preview.jsonl' }, status: 'temporary',
} as SessionPreview;

function harness(callbacks: Partial<SourceDropCallbacks> = {}) {
  let receive: ((message: unknown) => void) | undefined;
  let close: (() => void) | undefined;
  const post = vi.fn().mockResolvedValue(true);
  const actions = {
    action: vi.fn().mockResolvedValue(undefined),
    previewText: vi.fn().mockResolvedValue(previewReceipt),
    previewUri: vi.fn().mockResolvedValue(previewReceipt),
    offerPreviewSaveAs: vi.fn(),
    ...callbacks,
  };
  const webview = { html: '', options: {}, postMessage: post,
    onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; } };
  const panel = {
    webview,
    reveal: vi.fn(),
    dispose: vi.fn(() => close?.()),
    onDidDispose: (listener: typeof close) => { close = listener; return { dispose() {} }; },
  };
  const createPanel = vi.fn(() => panel as unknown as vscode.WebviewPanel);
  const view = new SourceImportCanvas(actions, createPanel);
  const send = async (message: unknown) => {
    receive?.(message);
    await vi.waitFor(() => expect(post.mock.calls.at(-1)?.[0].state).not.toBe('busy'));
    expect(isIntakeStatusReply(post.mock.calls.at(-1)?.[0])).toBe(true);
  };
  return { view, panel, webview, actions, post, createPanel, send, receive: (message: unknown) => receive?.(message), close: () => close?.() };
}

describe('source import canvas', () => {
  it('opens one isolated editor-area panel and renders without discovering or importing sources', () => {
    const host = harness();
    host.view.show();
    expect(host.createPanel).toHaveBeenCalledOnce();
    expect(host.webview.options).toEqual({ enableScripts: true, localResourceRoots: [] });
    expect(host.webview.html).toContain('Use Resources');
    expect(host.actions.action).not.toHaveBeenCalled();
    host.view.show();
    expect(host.createPanel).toHaveBeenCalledOnce();
    expect(host.panel.reveal).toHaveBeenCalledOnce();
  });

  it('routes the separate file and folder actions without discovery at render time', async () => {
    const host = harness();
    host.view.show();
    await host.send({ intakeProtocolVersion: 1, type: 'pick-files' });
    expect(host.actions.action).toHaveBeenLastCalledWith('files', expect.any(AbortSignal));
    expect(host.post.mock.calls[0]?.[0]).toMatchObject({ intakeProtocolVersion: 1, type: 'status', state: 'busy' });
    await host.send({ intakeProtocolVersion: 1, type: 'pick-folder' });
    expect(host.actions.action).toHaveBeenLastCalledWith('folder', expect.any(AbortSignal));
    expect(host.actions.previewText).not.toHaveBeenCalled();
  });

  it('rejects missing and unsupported intake versions before invoking source callbacks', async () => {
    const missing = harness();
    missing.view.show();
    await missing.send({ type: 'pick-files' });
    expect(missing.actions.action).not.toHaveBeenCalled();
    expect(missing.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'error', text: expect.stringContaining('Close and reopen') });
    const unsupported = harness();
    unsupported.view.show();
    await unsupported.send({ intakeProtocolVersion: 2, type: 'pick-files' });
    expect(unsupported.actions.action).not.toHaveBeenCalled();
  });

  it('waits for preview ownership before publishing success and rejects concurrent selections', async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<SessionPreview>(resolve => { finish = () => resolve(previewReceipt); }));
    const host = harness({ previewText: action });
    host.view.show();
    host.receive({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}\r\n' });
    await vi.waitFor(() => expect(action).toHaveBeenCalledWith('{}\r\n', expect.any(AbortSignal)));
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('busy');
    host.receive({ intakeProtocolVersion: 2, type: 'pick-files' });
    await vi.waitFor(() => expect(host.post.mock.calls.at(-1)?.[0].state).toBe('error'));
    expect(host.post.mock.calls.at(-1)?.[0].text).toContain('Close and reopen');
    host.receive({ intakeProtocolVersion: 1, type: 'pick-files' });
    expect(host.actions.action).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(host.post.mock.calls.at(-1)?.[0].state).toBe('success'));
    expect(host.actions.offerPreviewSaveAs).toHaveBeenCalledWith(previewReceipt, expect.any(AbortSignal));
  });

  it('publishes Import success before scheduling Save As and releases the canvas operation', async () => {
    const events: string[] = [];
    const host = harness({ offerPreviewSaveAs: vi.fn(() => { events.push('save-prompt'); }) });
    host.post.mockImplementation(async (reply) => { if (reply.state === 'success') events.push('success'); return true; });
    host.view.show();

    await host.send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}\n' });

    expect(events).toEqual(['success', 'save-prompt']);
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'success', text: expect.stringContaining('Save As') });
    expect(host.actions.offerPreviewSaveAs).toHaveBeenCalledWith(previewReceipt, expect.any(AbortSignal));
    await host.send({ intakeProtocolVersion: 1, type: 'pick-files' });
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('idle');
  });

  it('delegates URI validation and distinguishes folders from opened previews', async () => {
    const previewUri = vi.fn().mockResolvedValue('folder');
    const host = harness({ previewUri });
    host.view.show();
    await host.send({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['file:///selected-folder'] });
    expect(previewUri).toHaveBeenCalledWith('file:///selected-folder', expect.any(AbortSignal));
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('idle');
    previewUri.mockRejectedValueOnce(new Error('Only local file and folder URIs are supported.'));
    await host.send({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['https://example.invalid/source.jsonl'] });
    expect(host.post.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ state: 'error', text: 'Only local file and folder URIs are supported.' }));
  });

  it('offers the same explicit Save As action after a local URI preview opens', async () => {
    const host = harness();
    host.view.show();

    await host.send({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['file:///C:/synthetic.jsonl'] });

    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'success', text: expect.stringContaining('Save As keeps a copy') });
    expect(host.actions.offerPreviewSaveAs).toHaveBeenCalledWith(previewReceipt, expect.any(AbortSignal));
  });

  it('aborts a pending picker and suppresses late completion when the panel closes', async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const host = harness({ action: async (_action, current) => { signal = current; await new Promise<void>(resolve => { finish = resolve; }); } });
    host.view.show();
    host.receive({ intakeProtocolVersion: 1, type: 'pick-files' });
    await vi.waitFor(() => expect(signal).toBeDefined());
    host.panel.dispose();
    expect(signal.aborted).toBe(true);
    const count = host.post.mock.calls.length;
    finish();
    await new Promise(resolve => setImmediate(resolve));
    expect(host.post).toHaveBeenCalledTimes(count);
  });

  it('disposes the editor panel with its owner', () => {
    const host = harness();
    host.view.show();
    host.view.dispose();
    expect(host.panel.dispose).toHaveBeenCalledOnce();
    host.view.show();
    expect(host.createPanel).toHaveBeenCalledOnce();
  });
});

describe('source drop message bounds', () => {
  it.each([null, [], { type: 'command', command: 'anything' },
    { intakeProtocolVersion: 1, type: 'pick-folder', path: 'C:/private' }, { intakeProtocolVersion: 1, type: 'preview-uris', uris: [] }, { intakeProtocolVersion: 1, type: 'preview-uris', uris: ['a', 'b'] },
    { intakeProtocolVersion: 1, type: 'preview-uris', uris: ['a'.repeat(8193)] },
    { intakeProtocolVersion: 1, type: 'import-jsonl', text: '界'.repeat(349526) },
  ])('rejects invalid shape or oversized input', (message) => {
    expect(() => parseSourceDropMessage(message)).toThrow();
  });
});

it('ignores missing and stale status versions in the embedded Import canvas', () => {
  const html = getSourceDropHtml();
  const source = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!;
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const makeNode = () => ({
    addEventListener: () => {}, setAttribute: () => {}, focus: () => {},
    classList: { toggle: () => {} }, dataset: {} as Record<string, string>, disabled: false,
    hidden: false, value: '', textContent: '',
  });
  const ids = ['dropzone', 'paste-editor', 'paste-text', 'show-paste', 'status', 'pick-files', 'pick-folder', 'preview-paste', 'cancel-paste'];
  const nodes = new Map(ids.map(id => [id, makeNode()]));
  const buttons = ids.filter(id => id !== 'dropzone' && id !== 'paste-editor' && id !== 'paste-text' && id !== 'show-paste' && id !== 'status')
    .map(id => nodes.get(id)!);
  new Script(source).runInNewContext({
    document: { getElementById: (id: string) => nodes.get(id), querySelectorAll: () => buttons, addEventListener: () => {} },
    window: { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => listeners.set(type, listener) },
    acquireVsCodeApi: () => ({ postMessage: () => Promise.resolve(true) }),
  });
  const status = nodes.get('status')!;
  const deliver = (data: unknown) => listeners.get('message')!({ data });
  deliver({ type: 'status', state: 'success', text: 'unversioned' });
  deliver({ intakeProtocolVersion: 2, type: 'status', state: 'success', text: 'stale' });
  expect(status.textContent).toBe('');
  expect(status.dataset.state).toBeUndefined();
  deliver({ intakeProtocolVersion: 1, type: 'status', state: 'success', text: 'current' });
  expect(status.textContent).toBe('current');
  expect(status.dataset.state).toBe('success');
});
