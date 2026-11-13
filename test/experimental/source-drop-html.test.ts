import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getSourceDropHtml } from '../../src/experimental/session-navigator/source-drop-html';

function harness() {
  const listeners = new Map<string, (event: any) => unknown>();
  const classes = new Set<string>();
  const nodes = new Map(['dropzone', 'paste-editor', 'paste-text', 'show-paste', 'status', 'pick-files', 'pick-folder', 'cancel-paste', 'preview-paste'].map(id => [id, {
    disabled: false, hidden: id === 'paste-editor', value: '', textContent: '', dataset: {} as Record<string, string>, attributes: {} as Record<string, string>,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
    setAttribute(name: string, value: string) { this.attributes[name] = value; }, focus: vi.fn(),
    addEventListener: (type: string, listener: (event: any) => unknown) => listeners.set(id + ':' + type, listener),
  }]));
  const post = vi.fn().mockResolvedValue(undefined);
  const html = getSourceDropHtml();
  new Script(html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!).runInNewContext({
    acquireVsCodeApi: () => ({ postMessage: post }), TextDecoder,
    document: {
      getElementById: (id: string) => nodes.get(id),
      querySelector: () => undefined,
      querySelectorAll: () => [...nodes.values()],
      addEventListener: (type: string, listener: (event: any) => unknown) => listeners.set('document:' + type, listener),
    },
    window: { addEventListener: (type: string, listener: (event: any) => unknown) => listeners.set('window:' + type, listener) },
  });
  const event = (dataTransfer = {}) => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), relatedTarget: {}, dataTransfer: {
    items: [{ kind: 'file' }], files: [], dropEffect: 'none', getData: () => '', ...dataTransfer,
  } });
  return { html, nodes, classes, post, event, fire: (key: string, value: any = event()) => listeners.get(key)?.(value) };
}

describe('source import canvas document', () => {
  it('keeps CSP nonce-only and exposes the three actions in the wide centered canvas', () => {
    const host = harness();
    const nonce = host.html.match(/<script nonce="([^"]+)"/u)![1]!;
    expect(host.html).toContain(`script-src 'nonce-${nonce}'`);
    expect(host.html).toContain(`style-src 'nonce-${nonce}'`);
    expect(host.html).toContain('Use Resources');
    expect(host.html).toContain('1120px');
    expect(host.html).toContain('aria-label="Choose files"');
    expect(host.html).toContain('aria-label="Choose folder"');
    expect(host.html).toContain('aria-label="Paste JSONL"');
    expect(host.html).toContain('id="paste-editor"');
    expect(host.html).not.toMatch(/innerHTML|navigator\.clipboard|unsafe-eval|https?:\/\//u);
  });

  it('keeps the drag affordance active across child boundaries and resets on leave or blur', () => {
    const host = harness();
    host.fire('document:dragenter'); host.fire('document:dragenter');
    host.fire('document:dragleave');
    expect(host.classes.has('dragging')).toBe(true);
    host.fire('document:dragleave');
    expect(host.classes.has('dragging')).toBe(false);
    host.fire('document:dragenter'); host.fire('window:blur');
    expect(host.classes.has('dragging')).toBe(false);
  });

  it('opens paste inline and sends text only after the explicit preview action', () => {
    const host = harness();
    host.fire('show-paste:click');
    expect(host.nodes.get('paste-editor')!.hidden).toBe(false);
    expect(host.nodes.get('paste-text')!.focus).toHaveBeenCalledOnce();
    expect(host.post).not.toHaveBeenCalled();
    host.nodes.get('paste-text')!.value = '{"message":"user supplied"}';
    host.fire('preview-paste:click');
    expect(host.post).toHaveBeenCalledWith({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"message":"user supplied"}' });
  });

  it('routes explicit file and folder picker actions to the host', () => {
    const host = harness();
    host.fire('pick-files:click'); host.fire('pick-folder:click');
    host.fire('window:message', { data: { intakeProtocolVersion: 1, type: 'status', state: 'idle', text: 'Ready.' } });
    host.fire('pick-folder:click');
    expect(host.post.mock.calls.map((call) => call[0])).toEqual([
      { intakeProtocolVersion: 1, type: 'pick-files' }, { intakeProtocolVersion: 1, type: 'pick-folder' },
    ]);
  });

  it('activates the large-canvas drop affordance and preserves exact UTF-8 input', async () => {
    const host = harness();
    const drag = host.event();
    host.fire('document:dragover', drag);
    expect(drag.preventDefault).toHaveBeenCalledOnce();
    expect(drag.dataTransfer.dropEffect).toBe('copy');
    expect(host.classes.has('dragging')).toBe(true);

    const text = '{"value":"界"}\r\n';
    const bytes = new TextEncoder().encode(text);
    const transfer = host.event({ files: [{ name: 'sample.NDJSON', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }] });
    await host.fire('document:drop', transfer);
    expect(transfer.stopPropagation).toHaveBeenCalledOnce();
    expect(host.post).toHaveBeenCalledWith({ intakeProtocolVersion: 1, type: 'import-jsonl', text });
  });

  it('routes one local URI or a directory to the existing native validator and picker', async () => {
    const host = harness();
    const uri = host.event({ getData: () => '# comment\r\nfile:///example.jsonl\r\n' });
    await host.fire('document:drop', uri);
    expect(host.post).toHaveBeenCalledWith({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['file:///example.jsonl'] });
    host.fire('window:message', { data: { intakeProtocolVersion: 1, type: 'status', state: 'idle', text: 'Ready.' } });
    const folder = host.event({ items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] });
    await host.fire('document:drop', folder);
    expect(host.post).toHaveBeenLastCalledWith({ intakeProtocolVersion: 1, type: 'pick-folder' });
  });

  it('recognizes a file drag when the host exposes only a text/uri-list item', async () => {
    const host = harness();
    const drag = host.event({
      items: [{ kind: 'string' }],
      types: ['text/uri-list'],
      getData: () => 'file:///example.jsonl',
    });
    host.fire('document:dragover', drag);
    expect(drag.preventDefault).toHaveBeenCalledOnce();
    expect(drag.dataTransfer.dropEffect).toBe('copy');
    expect(host.classes.has('dragging')).toBe(true);
    await host.fire('document:drop', drag);
    expect(host.post).toHaveBeenCalledWith({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['file:///example.jsonl'] });
  });

  it('rejects multiple files, unsupported extensions, oversized reads and invalid UTF-8', async () => {
    const host = harness();
    const read = vi.fn();
    for (const files of [
      [{ name: 'a.jsonl' }, { name: 'b.jsonl' }],
      [{ name: 'a.txt', size: 2, arrayBuffer: read }],
      [{ name: 'a.jsonl', size: 1048577, arrayBuffer: read }],
      [{ name: 'a.jsonl', size: 2, arrayBuffer: async () => new ArrayBuffer(1048577) }],
      [{ name: 'a.jsonl', size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer }],
    ]) {
      await host.fire('document:drop', host.event({ files }));
      expect(host.nodes.get('status')!.dataset.state).toBe('error');
      expect(host.nodes.get('pick-files')!.disabled).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
    expect(host.post).not.toHaveBeenCalled();
  });
});
