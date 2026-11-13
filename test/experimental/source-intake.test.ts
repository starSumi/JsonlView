import { lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  create: vi.fn(), info: vi.fn(), open: vi.fn(), post: vi.fn(), reveal: vi.fn(),
  receive: undefined as undefined | ((message: unknown) => void),
  close: undefined as undefined | (() => void),
  html: '', title: '',
}));
function fileUri(path: string): vscode.Uri {
  return { scheme: 'file', authority: '', query: '', fragment: '', fsPath: path, toString: () => pathToFileURL(path).toString() } as vscode.Uri;
}
vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => fileUri(path),
    parse: (value: string) => {
      const url = new URL(value);
      return { scheme: url.protocol.slice(0, -1), authority: url.host, query: url.search.slice(1), fragment: url.hash.slice(1),
        fsPath: url.protocol === 'file:' && url.host === '' ? fileURLToPath(url) : url.pathname,
        toString: () => value };
    },
  },
  ViewColumn: { Active: -1 },
  window: { createWebviewPanel: host.create, showInformationMessage: host.info },
  env: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
  commands: { executeCommand: host.open },
}));

import { parseSourceIntakeMessage, SOURCE_INTAKE_MAX_BYTES, SourceIntakePanel, validateLocalSourceUri, validatePastedJsonl } from '../../src/experimental/session-navigator/source-intake';
import { getSourceIntakeHtml } from '../../src/experimental/session-navigator/source-intake-html';
import { createIntakeFocusMessage, createIntakeStatusReply, isIntakeFocusMessage, isIntakeMessage, isIntakeStatusReply, validateIntakeMessage } from '../../src/shared/contracts/intake';
import type { SessionPreviews } from '../../src/experimental/session-navigator/session-previews';

let directory: string;
let intake: SourceIntakePanel;

describe('source intake protocol', () => {
  it('owns a bounded, explicitly versioned Host-to-Webview status contract', () => {
    const reply = createIntakeStatusReply('success', 'Opened.', true);
    expect(reply).toEqual({ intakeProtocolVersion: 1, type: 'status', state: 'success', text: 'Opened.', clearText: true });
    expect(isIntakeStatusReply(reply)).toBe(true);
    expect(isIntakeStatusReply({ type: 'status', state: 'success', text: 'old host' })).toBe(false);
    expect(isIntakeStatusReply({ ...reply, intakeProtocolVersion: 2 })).toBe(false);
    expect(isIntakeStatusReply({ ...reply, state: 'other' })).toBe(false);
    expect(isIntakeStatusReply({ ...reply, text: 'x'.repeat(4_097) })).toBe(false);
    expect(createIntakeStatusReply('error', 'x'.repeat(4_097)).text).toHaveLength(4_096);
    expect(isIntakeStatusReply({ ...reply, extra: true })).toBe(false);
    const focus = createIntakeFocusMessage();
    expect(focus).toEqual({ intakeProtocolVersion: 1, type: 'focus' });
    expect(isIntakeFocusMessage(focus)).toBe(true);
    expect(isIntakeFocusMessage({ ...focus, extra: true })).toBe(false);
    expect(isIntakeFocusMessage({ ...focus, intakeProtocolVersion: 2 })).toBe(false);
  });

  it('requires an explicit supported intake version', () => {
    expect(parseSourceIntakeMessage({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"ok":true}' }))
      .toEqual({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"ok":true}' });
    expect(() => parseSourceIntakeMessage({ type: 'import-jsonl', text: '{"ok":true}' })).toThrow();
    expect(() => parseSourceIntakeMessage({ intakeProtocolVersion: 2, type: 'import-jsonl', text: '{"ok":true}' })).toThrow();
    expect(() => parseSourceIntakeMessage({ intakeProtocolVersion: 2, type: 'webview-diagnostic', name: 'Error', message: 'x' })).toThrow();
  });

  it('accepts only one bounded URI in the versioned preview request', () => {
    const valid = { intakeProtocolVersion: 1, type: 'preview-uris', uris: ['file:///tmp/source.jsonl'] };
    expect(parseSourceIntakeMessage(valid)).toEqual(valid);
    expect(isIntakeMessage(valid)).toBe(true);
    expect(validateIntakeMessage(valid)).toEqual({ ok: true, message: valid });
    expect(validateIntakeMessage({ intakeProtocolVersion: 2, type: 'import-jsonl', text: '{}' })).toEqual({ ok: false, error: 'unsupported-version' });
    expect(validateIntakeMessage({ intakeProtocolVersion: 1, type: 'import-jsonl', text: 'x'.repeat(SOURCE_INTAKE_MAX_BYTES + 1) })).toEqual({ ok: false, error: 'oversized' });
    expect(validateIntakeMessage({ intakeProtocolVersion: 1, type: 'pick-files' })).toEqual({ ok: false, error: 'invalid' });
    expect(isIntakeMessage({ ...valid, uris: [] })).toBe(false);
    expect(isIntakeMessage({ ...valid, uris: ['file:///a.jsonl', 'file:///b.jsonl'] })).toBe(false);
    expect(isIntakeMessage({ ...valid, uris: ['x'.repeat(8_193)] })).toBe(false);
    expect(() => parseSourceIntakeMessage({ ...valid, uris: ['file:///a.jsonl', 'file:///b.jsonl'] })).toThrow();
    expect(() => parseSourceIntakeMessage({ ...valid, intakeProtocolVersion: 2 })).toThrow();
  });

  it('rejects stale versions before busy state, preview, prompt, or clipboard effects', async () => {
    intake.show();
    vi.mocked(vscode.env.clipboard.writeText).mockClear();
    await send({ intakeProtocolVersion: 2, type: 'webview-diagnostic', name: 'Error', message: 'old panel' });
    expect(host.post.mock.calls.map((call) => call[0].state)).toEqual(['error']);
    expect(host.post.mock.calls[0]?.[0].text).toContain('Close and reopen');
    expect(host.open).not.toHaveBeenCalled();
    expect(host.info).not.toHaveBeenCalled();
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();

    host.post.mockClear();
    await send({ type: 'import-jsonl', text: '{}' });
    expect(host.post.mock.calls.map((call) => call[0].state)).toEqual(['error']);
    expect(host.open).not.toHaveBeenCalled();
    host.post.mockClear();
    await send({ intakeProtocolVersion: 2, type: 'preview-uris', uris: ['file:///source.jsonl'] });
    expect(host.post.mock.calls.map((call) => call[0].state)).toEqual(['error']);
    expect(host.open).not.toHaveBeenCalled();
  });

  it('rejects an unsupported version before the busy response while another intake is pending', async () => {
    let finishPrompt!: (value: undefined) => void;
    host.info.mockImplementationOnce(() => new Promise(resolve => { finishPrompt = resolve; }));
    intake.show();
    host.receive!({ intakeProtocolVersion: 1, type: 'webview-diagnostic', name: 'Error', message: 'pending' });
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledOnce());
    host.post.mockClear();

    host.receive!({ intakeProtocolVersion: 2, type: 'import-jsonl', text: '{}' });
    await vi.waitFor(() => expect(host.post.mock.calls.at(-1)?.[0].state).toBe('error'));
    expect(host.post.mock.calls.at(-1)?.[0].text).toContain('Close and reopen');

    finishPrompt(undefined);
  });
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jsonlview-source-intake-test-'));
  intake = new SourceIntakePanel();
  host.info.mockReset().mockResolvedValue(undefined);
  host.open.mockReset().mockResolvedValue(undefined);
  host.post.mockReset().mockResolvedValue(true);
  vi.mocked(vscode.env.clipboard.writeText).mockReset().mockResolvedValue(undefined);
  host.reveal.mockReset();
  host.html = '';
  host.title = '';
  host.create.mockReset().mockImplementation((_view: string, title: string) => {
    host.title = title;
    return {
      webview: {
        set html(value: string) { host.html = value; },
        postMessage: host.post,
        onDidReceiveMessage: (listener: typeof host.receive) => { host.receive = listener; return { dispose() {} }; },
      },
      reveal: host.reveal,
      onDidDispose: (listener: typeof host.close) => { host.close = listener; return { dispose() {} }; },
      dispose: () => host.close?.(),
    };
  });
});

afterEach(async () => { await intake.dispose(); await rm(directory, { recursive: true, force: true }); });

async function send(message: unknown): Promise<void> {
  host.post.mockClear();
  host.receive!(message);
  await vi.waitFor(() => expect(host.post.mock.calls.at(-1)?.[0].state).toMatch(/^(idle|success|error)$/u));
  expect(isIntakeStatusReply(host.post.mock.calls.at(-1)?.[0])).toBe(true);
  await Promise.resolve();
}

describe('bounded paste validation', () => {
  it('accepts bounded diagnostics without accepting source content', () => {
    expect(parseSourceIntakeMessage({ intakeProtocolVersion: 1, type: 'webview-diagnostic', name: 'InvalidStateError', message: 'The object is in an invalid state.' })).toEqual({
      intakeProtocolVersion: 1, type: 'webview-diagnostic', name: 'InvalidStateError', message: 'The object is in an invalid state.',
    });
    expect(() => parseSourceIntakeMessage({ intakeProtocolVersion: 1, type: 'webview-diagnostic', name: 'Error', message: 'x'.repeat(513) })).toThrow();
    expect(() => parseSourceIntakeMessage({ type: 'authorize-agent', provider: 'codex' })).toThrow();
    expect(() => parseSourceIntakeMessage({ type: 'connect-agent' })).toThrow();
    expect(() => parseSourceIntakeMessage({ type: 'pick-files' })).toThrow();
  });

  it('accepts JSON values and CRLF without changing record content', () => {
    expect(validatePastedJsonl('{"event":"started"}\r\n[1,2]\r\nnull\r\n')).toBe(3);
    expect(validatePastedJsonl('"<script>never run</script>"')).toBe(1);
    expect(validatePastedJsonl(Array(10_000).fill('{}').join('\n'))).toBe(10_000);
  });

  it('rejects malformed, blank, BOM, invalid Unicode, oversized and too many records', () => {
    expect(() => validatePastedJsonl('')).toThrow('at least one');
    expect(() => validatePastedJsonl('{}\n\n{}')).toThrow('Line 2 is blank');
    expect(() => validatePastedJsonl('{}\n{"unfinished"}')).toThrow('Line 2 is not valid JSON');
    expect(() => validatePastedJsonl('\uFEFF{}')).toThrow('Line 1 is not valid JSON');
    expect(() => validatePastedJsonl('"\uD800"')).toThrow('valid Unicode');
    expect(() => validatePastedJsonl(JSON.stringify('文'.repeat(350_000)))).toThrow('1 MiB');
    expect(() => validatePastedJsonl(' '.repeat(SOURCE_INTAKE_MAX_BYTES + 1))).toThrow('1 MiB');
    expect(() => validatePastedJsonl(Array(10_001).fill('{}').join('\n'))).toThrow('10,000');
  });

  it('checks local file and folder reality while rejecting remote, command, missing and linked paths', async () => {
    const file = join(directory, 'source.jsonl');
    await writeFile(file, '{}\n');
    expect((await validateLocalSourceUri(pathToFileURL(file).toString())).fsPath).toBe(file);
    expect((await validateLocalSourceUri(pathToFileURL(directory).toString())).fsPath).toBe(directory);
    for (const uri of ['https://example.com/log.jsonl', 'command:workbench.action.closeWindow',
      'file://remote-host/share/log.jsonl', pathToFileURL(file).toString() + '?read=1', pathToFileURL(file).toString() + '#L1',
      pathToFileURL(join(directory, 'missing.jsonl')).toString()]) {
      await expect(validateLocalSourceUri(uri)).rejects.toThrow();
    }
    const junction = join(directory, 'link');
    await symlink(directory, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(validateLocalSourceUri(pathToFileURL(junction).toString())).rejects.toThrow('symbolic link');
  });
});

describe('Paste JSONL panel', () => {
  it('opens a paste-only themed panel lazily and reuses it without local resource access', () => {
    expect(host.create).not.toHaveBeenCalled();
    intake.show(); intake.show();
    expect(host.title).toBe('Paste JSONL');
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.reveal).toHaveBeenCalledTimes(1);
    expect(host.create.mock.calls[0]?.[3]).toMatchObject({ enableScripts: true, localResourceRoots: [] });
    expect(host.html).toContain('Paste JSONL');
    expect(host.html).toContain('--vscode-editor-background');
    expect(host.html).not.toContain('Connect known local agents');
    expect(host.html).not.toContain('Connect Codex');
    expect(host.html).not.toContain('pick-files');
    expect(host.html).not.toContain('pick-folder');
  });

  it('sends a versioned focus command when reusing the Paste panel', async () => {
    intake.show();
    host.post.mockClear();
    intake.show();
    await vi.waitFor(() => expect(host.reveal).toHaveBeenCalledOnce());
    expect(host.post).toHaveBeenCalledWith({ intakeProtocolVersion: 1, type: 'focus' });
  });

  it('opens a bounded pasted preview without authorizing a source', async () => {
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"text":"safe"}\n' });
    expect(host.open).toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'jsonlView.editor');
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    expect(await readFile(uri.fsPath, 'utf8')).toBe('{"text":"safe"}\n');
    expect(host.html).not.toContain('{"text":"safe"}');
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'success', clearText: true });
  });

  it('offers Save As only after publishing the successful temporary preview status', async () => {
    const events: string[] = [];
    let finishPrompt!: (choice: string | undefined) => void;
    host.post.mockImplementation(async (reply) => { if (reply.state === 'success') events.push('success'); return true; });
    host.info.mockImplementationOnce(async (...args: unknown[]) => {
      events.push('prompt');
      expect(args[0]).toContain('Agent Sessions > Recent Previews');
      expect(args.slice(1)).toEqual(['Save As…', 'Keep Temporary Only']);
      return await new Promise(resolve => { finishPrompt = resolve; }) as string | undefined;
    });
    intake.show();
    host.receive!({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"saved":true}\n' });

    await vi.waitFor(() => expect(host.info).toHaveBeenCalledOnce());
    expect(events).toEqual(['success', 'prompt']);
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'success', clearText: true });
    finishPrompt('Keep Temporary Only');
  });

  it('runs explicit Save As for the selected prompt action without implying Collection membership', async () => {
    const saveAs = vi.spyOn(intake.previews, 'saveAs').mockResolvedValue('cancelled');
    host.info.mockResolvedValueOnce('Save As…');
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"saved":true}\n' });

    await vi.waitFor(() => expect(saveAs).toHaveBeenCalledOnce());
    expect(saveAs).toHaveBeenCalledWith(expect.anything(), expect.any(Function));
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    expect(saveAs.mock.calls[0]?.[0].toString()).toBe(uri.toString());
    expect(host.info.mock.calls[0]?.[0]).toContain('Save As keeps a permanent copy');
    expect(host.info.mock.calls[0]?.slice(1)).toEqual(['Save As…', 'Keep Temporary Only']);
  });

  it('offers each opened preview independently while an earlier notification is unanswered', async () => {
    let finishPrompt!: (choice: undefined) => void;
    host.info.mockImplementationOnce(() => new Promise(resolve => { finishPrompt = resolve; }));
    const signal = new AbortController().signal;
    const first = await intake.previewText('{}\n', signal);
    const second = await intake.previewText('{}\n', signal);
    if (first === undefined || second === undefined) throw new Error('Expected two previews');

    intake.offerPreviewSaveAs(first, signal);
    intake.offerPreviewSaveAs(second, signal);

    await vi.waitFor(() => expect(host.info).toHaveBeenCalledTimes(2));
    finishPrompt(undefined);
  });

  it('suppresses a late Save As choice after the importing panel closes', async () => {
    let finishPrompt!: (choice: string) => void;
    const saveAs = vi.spyOn(intake.previews, 'saveAs').mockResolvedValue('cancelled');
    host.info.mockImplementationOnce(() => new Promise(resolve => { finishPrompt = resolve; }));
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}\n' });
    await vi.waitFor(() => expect(host.info).toHaveBeenCalledOnce());

    host.close!();
    finishPrompt('Save As…');
    await new Promise(resolve => setImmediate(resolve));

    expect(saveAs).not.toHaveBeenCalled();
    expect(intake.previews.list()).toHaveLength(1);
  });

  it('opens a dropped local URI through the temporary preview owner and rejects remote URIs', async () => {
    const file = join(directory, 'uri-drop.jsonl');
    await writeFile(file, '{"via":"uri"}\n');
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'preview-uris', uris: [pathToFileURL(file).toString()] });
    expect(host.open).toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'jsonlView.editor');
    const previewUri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    expect(await readFile(previewUri.fsPath, 'utf8')).toBe('{"via":"uri"}\n');

    host.open.mockClear();
    await send({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['https://example.invalid/source.jsonl'] });
    expect(host.open).not.toHaveBeenCalled();
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'error', text: 'Only local file and folder URIs are supported.' });
  });

  it('rejects invalid pasted content before opening a preview', async () => {
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{broken}' });
    expect(host.open).not.toHaveBeenCalled();
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'error', text: 'Line 1 is not valid JSON.' });
  });

  it('opens a native TreeView JSONL drop as a temporary preview', async () => {
    const file = join(directory, 'dropped.jsonl');
    await writeFile(file, '{}\n');
    await intake.previewUri(fileUri(file), new AbortController().signal);
    expect(host.open).toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'jsonlView.editor');
    expect(host.post).not.toHaveBeenCalled();
  });

  it('rejects non-JSONL files before reading them for a native drop preview', async () => {
    const file = join(directory, 'dropped.txt');
    await writeFile(file, '{}\n');
    await expect(intake.previewUri(fileUri(file), new AbortController().signal)).rejects.toThrow('JSONL or NDJSON');
    expect(host.open).not.toHaveBeenCalled();
  });

  it('returns to idle when the diagnostic notification is dismissed', async () => {
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'webview-diagnostic', name: 'Error', message: 'The paste view could not initialize.' });
    expect(host.info).toHaveBeenCalledTimes(1);
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'status', state: 'idle' });
  });

  it('keeps a preview after its panel closes and cleans only files owned by this session', async () => {
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"a":1}\n' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    const previewDirectory = dirname(uri.fsPath);
    host.close!();
    expect(await readFile(uri.fsPath, 'utf8')).toBe('{"a":1}\n');
    const unrelated = join(previewDirectory, 'user-file.txt');
    await writeFile(unrelated, 'preserve');
    await intake.dispose();
    await expect(lstat(uri.fsPath)).rejects.toThrow();
    expect(await readFile(unrelated, 'utf8')).toBe('preserve');
    await rm(previewDirectory, { recursive: true });
  });

  it('preserves a replacement file at a former preview path during cleanup', async () => {
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    const previewDirectory = dirname(uri.fsPath);
    await rename(uri.fsPath, join(previewDirectory, 'retained-original.jsonl'));
    await writeFile(uri.fsPath, '{"user":"replacement"}');
    await intake.dispose();
    expect(await readFile(uri.fsPath, 'utf8')).toBe('{"user":"replacement"}');
    await rm(previewDirectory, { recursive: true });
  });

  it('preserves a temporary preview changed through another editor', async () => {
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    await writeFile(uri.fsPath, '{"user":"edited"}');
    await intake.dispose();
    expect(await readFile(uri.fsPath, 'utf8')).toBe('{"user":"edited"}');
    await rm(dirname(uri.fsPath), { recursive: true });
  });

  it('removes a preview when opening its editor fails', async () => {
    host.open.mockRejectedValue(new Error('Editor unavailable'));
    intake.show();
    await send({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    expect(await readdir(dirname(uri.fsPath))).toEqual([]);
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('error');
  });

  it('removes a preview created just as its intake operation is cancelled without opening it', async () => {
    const controller = new AbortController();
    const id = 'cancelled-preview';
    const previews = {
      create: vi.fn(async (_text: string, _records: number, _signal: AbortSignal) => {
        controller.abort();
        return { id, sourceUri: fileUri(join(directory, 'cancelled-preview.jsonl')) };
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionPreviews;
    const cancelledIntake = new SourceIntakePanel(previews);

    await cancelledIntake.previewText('{}', controller.signal);

    expect(previews.remove).toHaveBeenCalledOnce();
    expect(previews.remove).toHaveBeenCalledWith(id);
    expect(host.open).not.toHaveBeenCalled();
    await cancelledIntake.dispose();
  });
});

it('ships a nonce-only static paste document with safe rendering and no duplicate source routes', () => {
  const html = getSourceIntakeHtml();
  const nonce = html.match(/<script nonce="([^"]+)"/u)?.[1];
  expect(nonce).toBeTruthy();
  expect(html).toContain(`script-src 'nonce-${nonce}'`);
  expect(html).toContain(`style-src 'nonce-${nonce}'`);
  expect(html).not.toMatch(/innerHTML|readText|navigator\.clipboard|unsafe-eval|https?:\/\//u);
  expect(html).toContain('textContent = message');
  expect(html).toContain('webview-diagnostic');
  expect(html).not.toContain('Connect ');
  expect(html).not.toContain('pick-files');
  expect(html).not.toContain('pick-folder');
  expect(html).toContain("text.addEventListener('keydown'");
  expect(html).toContain("event.ctrlKey || event.metaKey");
  expect(html).toContain("document.addEventListener('dragover'");
  expect(html).toContain("document.addEventListener('drop'");
  expect(html).toContain("type: 'preview-uris'");
  expect(html).toContain('file.arrayBuffer()');
  expect(html).toContain("type === 'focus'");
  const source = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!;
  expect(() => new Script(source)).not.toThrow();
});

it('validates dropped browser text through the existing preview owner without opening a paste panel', async () => {
  const signal = new AbortController().signal;
  await expect(intake.previewText('not json', signal)).rejects.toThrow('Line 1');
  expect(host.open).not.toHaveBeenCalled();
  const content = '{"source":"browser"}\r\n';
  await intake.previewText(content, signal);
  const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
  expect(await readFile(uri.fsPath, 'utf8')).toBe(content);
  expect(host.create).not.toHaveBeenCalled();
});

it('keeps paste controls busy only until the host reports a terminal status', async () => {
  const html = getSourceIntakeHtml();
  const source = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!;
  type PasteEvent = { data?: unknown; key?: string; ctrlKey?: boolean; metaKey?: boolean; preventDefault?: () => void };
  const listeners = new Map<string, (event: PasteEvent) => unknown>();
  const button = { disabled: false, addEventListener: (_type: string, listener: (event: PasteEvent) => unknown) => { listeners.set('click', listener); } };
  const text = { value: '{}', readOnly: false, textContent: '', dataset: {} as Record<string, string>, addEventListener: (_type: string, listener: (event: PasteEvent) => unknown) => { listeners.set('keydown', listener); } };
  const nodes = new Map<string, object>([['preview', button], ['jsonl', text], ['status', text]]);
  const posted: unknown[] = [];
  let postAccepted = true;
  const windowListeners = new Map<string, (event: { data: unknown }) => void>();
  new Script(source).runInNewContext({
    document: { getElementById: (id: string) => nodes.get(id), querySelectorAll: () => [button], addEventListener: () => {} },
    window: { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => windowListeners.set(type, listener) },
    TextEncoder,
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(postAccepted); } }),
  });
  listeners.get('click')!({ data: undefined });
  expect(posted).toEqual([{ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}' }]);
  expect(button.disabled).toBe(true);
  expect(text.readOnly).toBe(true);
  windowListeners.get('message')!({ data: { intakeProtocolVersion: 1, type: 'status', state: 'success', text: 'Opened.' } });
  expect(button.disabled).toBe(false);
  expect(text.readOnly).toBe(false);
  let prevented = false;
  listeners.get('keydown')!({ key: 'Enter', ctrlKey: false, metaKey: true, preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true);
  expect(posted).toEqual([
    { intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}' },
    { intakeProtocolVersion: 1, type: 'import-jsonl', text: '{}' },
  ]);
  windowListeners.get('message')!({ data: { intakeProtocolVersion: 1, type: 'status', state: 'idle', text: 'Ready.' } });
  postAccepted = false;
  listeners.get('click')!({ data: undefined });
  await vi.waitFor(() => expect(text.dataset.state).toBe('error'));
  expect(button.disabled).toBe(false);
  expect(text.readOnly).toBe(false);
  expect(text.textContent).toContain('View connection closed');
  expect(posted).toHaveLength(3);
});

it('accepts one bounded browser File drop and leaves oversized drops local', async () => {
  const html = getSourceIntakeHtml();
  const source = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!;
  type DropTransfer = {
    items: Array<{ kind: string }>;
    types: string[];
    files: Array<{ name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
    getData: (format: string) => string;
  };
  type DropEvent = { dataTransfer?: DropTransfer; preventDefault?: () => void };
  const listeners = new Map<string, (event: DropEvent) => unknown>();
  const makeNode = (id: string) => ({
    value: '', readOnly: false, textContent: '', dataset: {} as Record<string, string>, disabled: false, hidden: false,
    addEventListener: (type: string, listener: (event: DropEvent) => unknown) => listeners.set(id + ':' + type, listener),
    focus: vi.fn(),
  });
  const ids = ['jsonl', 'status', 'preview', 'diagnostic', 'diagnostic-text', 'diagnostic-copy', 'diagnostic-send'];
  const nodes = new Map(ids.map(id => [id, makeNode(id)]));
  const buttons = ids.filter(id => id !== 'jsonl' && id !== 'status' && id !== 'diagnostic' && id !== 'diagnostic-text').map(id => nodes.get(id)!);
  const posted: unknown[] = [];
  const windowListeners = new Map<string, (event: { data: unknown }) => void>();
  new Script(source).runInNewContext({
    document: {
      getElementById: (id: string) => nodes.get(id), querySelectorAll: () => buttons,
      addEventListener: (type: string, listener: (event: DropEvent) => unknown) => listeners.set('document:' + type, listener),
    },
    window: { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => windowListeners.set(type, listener) },
    TextEncoder, TextDecoder, URL,
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { posted.push(message); return Promise.resolve(true); } }),
  });
  const bytes = new TextEncoder().encode('{"drop":true}\n');
  const validTransfer = {
    items: [{ kind: 'file' }], types: ['Files'], files: [{ name: 'dropped.NDJSON', size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }], getData: () => '',
  };
  const dragOver = { dataTransfer: validTransfer, preventDefault: vi.fn() };
  listeners.get('document:dragover')!(dragOver);
  expect(dragOver.preventDefault).toHaveBeenCalledOnce();
  listeners.get('document:drop')!({ dataTransfer: validTransfer, preventDefault: vi.fn() });
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toEqual({ intakeProtocolVersion: 1, type: 'import-jsonl', text: '{"drop":true}\n' });

  windowListeners.get('message')!({ data: { intakeProtocolVersion: 1, type: 'status', state: 'idle', text: 'Ready.' } });
  const uriTransfer = {
    items: [{ kind: 'string' }], types: ['text/uri-list'], files: [], getData: () => '# comment\r\nfile:///tmp/preview.jsonl\r\n',
  };
  listeners.get('document:drop')!({ dataTransfer: uriTransfer, preventDefault: vi.fn() });
  await vi.waitFor(() => expect(posted).toHaveLength(2));
  expect(posted[1]).toEqual({ intakeProtocolVersion: 1, type: 'preview-uris', uris: ['file:///tmp/preview.jsonl'] });

  windowListeners.get('message')!({ data: { intakeProtocolVersion: 1, type: 'status', state: 'idle', text: 'Ready.' } });
  const multipleUriTransfer = {
    items: [{ kind: 'string' }], types: ['text/uri-list'], files: [], getData: () => 'file:///tmp/a.jsonl\r\nfile:///tmp/b.jsonl',
  };
  listeners.get('document:drop')!({ dataTransfer: multipleUriTransfer, preventDefault: vi.fn() });
  expect(posted).toHaveLength(2);
  expect(nodes.get('status')!.textContent).toContain('one local JSONL');

  windowListeners.get('message')!({ data: { intakeProtocolVersion: 1, type: 'status', state: 'idle', text: 'Ready.' } });
  const oversizedTransfer = {
    items: [{ kind: 'file' }], types: ['Files'],
    files: [{ name: 'large.jsonl', size: SOURCE_INTAKE_MAX_BYTES + 1, arrayBuffer: vi.fn(async () => new ArrayBuffer(0)) }], getData: () => '',
  };
  listeners.get('document:drop')!({ dataTransfer: oversizedTransfer, preventDefault: vi.fn() });
  expect(posted).toHaveLength(2);
  expect(oversizedTransfer.files[0]!.arrayBuffer).not.toHaveBeenCalled();
  expect(nodes.get('status')!.textContent).toContain('1 MiB');
});

it('ignores unversioned and stale status replies in the embedded paste panel', () => {
  const html = getSourceIntakeHtml();
  const source = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!;
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const button = { disabled: false, addEventListener: (_type: string, listener: () => void) => { listeners.set('click', listener); } };
  const editor = { value: '{}', readOnly: false, textContent: '', dataset: {} as Record<string, string>, focus: vi.fn(), addEventListener: () => {} };
  const status = { textContent: '', dataset: {} as Record<string, string> };
  const nodes = new Map<string, object>([['preview', button], ['jsonl', editor], ['status', status]]);
  const windowListeners = new Map<string, (event: { data: unknown }) => void>();
  new Script(source).runInNewContext({
    document: { getElementById: (id: string) => nodes.get(id), querySelectorAll: () => [button], addEventListener: () => {} },
    window: { addEventListener: (type: string, listener: (event: { data: unknown }) => void) => windowListeners.set(type, listener) },
    TextEncoder,
    acquireVsCodeApi: () => ({ postMessage: () => Promise.resolve(true) }),
  });
  const deliver = (data: unknown) => windowListeners.get('message')!({ data });
  deliver({ type: 'status', state: 'success', text: 'unversioned' });
  deliver({ intakeProtocolVersion: 2, type: 'status', state: 'success', text: 'stale' });
  deliver({ intakeProtocolVersion: 2, type: 'focus' });
  expect(status.textContent).toBe('');
  expect(status.dataset.state).toBeUndefined();
  expect(editor.focus).not.toHaveBeenCalled();
  deliver({ intakeProtocolVersion: 1, type: 'status', state: 'success', text: 'current' });
  expect(status.textContent).toBe('current');
  expect(status.dataset.state).toBe('success');
  deliver({ intakeProtocolVersion: 1, type: 'focus' });
  expect(editor.focus).toHaveBeenCalledOnce();
});
