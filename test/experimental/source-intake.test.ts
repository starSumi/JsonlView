import { lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  dialog: vi.fn(), create: vi.fn(), open: vi.fn(), post: vi.fn(), reveal: vi.fn(),
  receive: undefined as undefined | ((message: unknown) => void),
  close: undefined as undefined | (() => void),
  html: '',
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
        fsPath: url.protocol === 'file:' && url.host === '' ? fileURLToPath(url) : url.pathname };
    },
  },
  ViewColumn: { Active: -1 },
  window: { createWebviewPanel: host.create, showOpenDialog: host.dialog },
  commands: { executeCommand: host.open },
}));

import { parseSourceIntakeMessage, SOURCE_INTAKE_MAX_BYTES, SourceIntakePanel, type SourceIntakeHandler, validateLocalSourceUri, validatePastedJsonl } from '../../src/experimental/session-navigator/source-intake';
import { getSourceIntakeHtml } from '../../src/experimental/session-navigator/source-intake-html';

let directory: string;
let intake: SourceIntakePanel;
let onSource: ReturnType<typeof vi.fn<SourceIntakeHandler>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'jsonlview-source-intake-test-'));
  onSource = vi.fn<SourceIntakeHandler>().mockResolvedValue(undefined);
  intake = new SourceIntakePanel(onSource);
  host.dialog.mockReset().mockResolvedValue(undefined);
  host.open.mockReset().mockResolvedValue(undefined);
  host.post.mockReset().mockResolvedValue(true);
  host.reveal.mockReset();
  host.create.mockReset().mockImplementation(() => ({
    webview: {
      set html(value: string) { host.html = value; },
      postMessage: host.post,
      onDidReceiveMessage: (listener: typeof host.receive) => { host.receive = listener; return { dispose() {} }; },
    },
    reveal: host.reveal,
    onDidDispose: (listener: typeof host.close) => { host.close = listener; return { dispose() {} }; },
    dispose: () => host.close?.(),
  }));
});

afterEach(async () => { await intake.dispose(); await rm(directory, { recursive: true, force: true }); });

async function send(message: unknown): Promise<void> {
  host.post.mockClear();
  host.receive!(message);
  await vi.waitFor(() => expect(host.post.mock.calls.at(-1)?.[0].state).toMatch(/^(idle|success|error)$/u));
  await Promise.resolve();
}

describe('bounded source intake validation', () => {
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

  it('rejects messages outside the exact discriminated schema and bounded URI list', () => {
    for (const message of [null, [], { type: 'clipboard' }, { type: 'pick-files', text: 'extra' },
      { type: 'import-jsonl', text: 1 }, { type: 'drop-uris', uris: [] }, { type: 'drop-uris', uris: [12] },
      { type: 'drop-uris', uris: Array(33).fill('file:///source.jsonl') }, { type: 'drop-uris', uris: ['x'.repeat(8_193)] }]) {
      expect(() => parseSourceIntakeMessage(message)).toThrow();
    }
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

describe('Add Source panel host lifecycle', () => {
  it('creates its themed panel lazily and reuses it without granting local resource access', () => {
    expect(host.create).not.toHaveBeenCalled();
    intake.show(); intake.show();
    expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.reveal).toHaveBeenCalledTimes(1);
    expect(host.create.mock.calls[0]?.[3]).toMatchObject({ enableScripts: true, localResourceRoots: [] });
    expect(host.html).toContain('Paste JSONL');
    expect(host.html).toContain('--vscode-editor-background');
  });

  it('makes cancelled native file selection a no-op', async () => {
    intake.show();
    await send({ type: 'pick-files' });
    expect(host.dialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true }));
    expect(onSource).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
    expect(host.post.mock.calls.at(-1)?.[0].text).toBe('No source selected.');
  });

  it('uses a separate folder picker and sends only validated source URIs to authorization', async () => {
    host.dialog.mockResolvedValue([fileUri(directory)]);
    intake.show();
    await send({ type: 'pick-folder' });
    expect(host.dialog).toHaveBeenCalledWith(expect.objectContaining({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }));
    expect(onSource).toHaveBeenCalledWith(expect.objectContaining({ fsPath: directory }), expect.any(AbortSignal));
  });

  it('validates the whole URI drop before authorizing any source', async () => {
    intake.show();
    await send({ type: 'drop-uris', uris: [pathToFileURL(directory).toString(), 'https://example.com/source.jsonl'] });
    expect(onSource).not.toHaveBeenCalled();
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('error');
    await send({ type: 'drop-uris', uris: [pathToFileURL(directory).toString(), pathToFileURL(directory).toString()] });
    expect(onSource).toHaveBeenCalledTimes(1);
  });

  it('creates a private session preview, keeps it when intake closes, and cleans only owned files on disposal', async () => {
    const content = '{"text":"<img src=x onerror=alert(1)>"}\n';
    intake.show();
    await send({ type: 'import-jsonl', text: content });
    expect(host.open).toHaveBeenCalledWith('vscode.openWith', expect.anything(), 'jsonlView.editor');
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    const previewDirectory = dirname(uri.fsPath);
    expect(await readFile(uri.fsPath, 'utf8')).toBe(content);
    expect(onSource).not.toHaveBeenCalled();
    expect(host.html).not.toContain(content);
    host.close!();
    expect(await readFile(uri.fsPath, 'utf8')).toBe(content);
    const unrelated = join(previewDirectory, 'user-file.txt');
    await writeFile(unrelated, 'preserve');
    await intake.dispose();
    await expect(lstat(uri.fsPath)).rejects.toThrow();
    expect(await readFile(unrelated, 'utf8')).toBe('preserve');
    await rm(previewDirectory, { recursive: true });
  });

  it('rejects invalid pasted content before opening or authorizing a source', async () => {
    intake.show();
    await send({ type: 'import-jsonl', text: '{broken}' });
    expect(host.open).not.toHaveBeenCalled();
    expect(onSource).not.toHaveBeenCalled();
    expect(host.post.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'error', text: 'Line 1 is not valid JSON.' });
  });

  it('preserves a replacement file at a former preview path during cleanup', async () => {
    intake.show();
    await send({ type: 'import-jsonl', text: '{}' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    const previewDirectory = dirname(uri.fsPath);
    await rename(uri.fsPath, join(previewDirectory, 'retained-original.jsonl'));
    await writeFile(uri.fsPath, '{"user":"replacement"}');
    await intake.dispose();
    expect(await readFile(uri.fsPath, 'utf8')).toBe('{"user":"replacement"}');
    await rm(previewDirectory, { recursive: true });
  });

  it('preserves a temporary preview that the user changed through another editor', async () => {
    intake.show();
    await send({ type: 'import-jsonl', text: '{}' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    await writeFile(uri.fsPath, '{"user":"edited"}');
    await intake.dispose();
    expect(await readFile(uri.fsPath, 'utf8')).toBe('{"user":"edited"}');
    await rm(dirname(uri.fsPath), { recursive: true });
  });

  it('removes a preview when opening the editor fails', async () => {
    host.open.mockRejectedValue(new Error('Editor unavailable'));
    intake.show();
    await send({ type: 'import-jsonl', text: '{}' });
    const uri = host.open.mock.calls[0]?.[1] as vscode.Uri;
    expect(await readdir(dirname(uri.fsPath))).toEqual([]);
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('error');
    await intake.dispose();
    await expect(lstat(dirname(uri.fsPath))).rejects.toThrow();
  });

  it('ignores a late dialog result after panel closure and never reopens after disposal', async () => {
    let resolveDialog!: (uris: vscode.Uri[]) => void;
    host.dialog.mockReturnValue(new Promise<vscode.Uri[]>((resolve) => { resolveDialog = resolve; }));
    intake.show();
    host.receive!({ type: 'pick-folder' });
    await vi.waitFor(() => expect(host.dialog).toHaveBeenCalled());
    host.close!();
    resolveDialog([fileUri(directory)]);
    await vi.waitFor(() => expect(host.post).toHaveBeenCalledTimes(1));
    await intake.dispose();
    expect(onSource).not.toHaveBeenCalled();
    intake.show();
    expect(host.create).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight authorization and waits for its completion before disposal', async () => {
    let finish!: () => void;
    onSource.mockImplementation((_uri: vscode.Uri, signal: AbortSignal) => new Promise<void>((resolve) => {
      finish = resolve;
      signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    intake.show();
    host.receive!({ type: 'drop-uris', uris: [pathToFileURL(directory).toString()] });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await intake.dispose();
    expect((onSource.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    expect(host.post.mock.calls.at(-1)?.[0].state).toBe('busy');
  });
});

it('ships a nonce-only static document without HTML injection or automatic clipboard reads', () => {
  const html = getSourceIntakeHtml();
  const nonce = html.match(/<script nonce="([^"]+)"/u)?.[1];
  expect(nonce).toBeTruthy();
  expect(html).toContain(`script-src 'nonce-${nonce}'`);
  expect(html).toContain(`style-src 'nonce-${nonce}'`);
  expect(html).not.toMatch(/innerHTML|readText|navigator\.clipboard|unsafe-eval|https?:\/\//u);
  expect(html).toContain('textContent = message');
  expect(html).toContain('file.size > maxBytes');
  expect(() => new Script(html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/u)![1]!)).not.toThrow();
});
