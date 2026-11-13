import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import manifest from '../../../package.json';
import packageNls from '../../../package.nls.json';

const fixtureExtensionPath = resolve(tmpdir(), 'jsonlview-acp-test-extension');
const fixtureSourcePath = resolve(tmpdir(), 'jsonlview-acp-test-source.jsonl');

const host = vi.hoisted(() => ({
  trusted: false,
  command: '',
  args: [] as string[],
  timeoutMs: 1_000,
  profiles: undefined as unknown,
  activeUri: undefined as { scheme: string; fsPath: string; path: string } | undefined,
  action: 'Send to side agent' as string | undefined,
  installed: [] as unknown[],
  outputLines: [] as string[],
  progressMessages: [] as string[],
  statusItems: [] as Array<{ text: string; name: string; tooltip: string; command: string; show: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  cancelInitially: false,
  cancel: undefined as (() => void) | undefined,
  outputShow: vi.fn(),
  documents: [] as Array<{ language: string; content: string }>,
  clipboardWrite: vi.fn(),
  executeCommand: vi.fn(),
  showTextDocument: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: (line: string) => host.outputLines.push(line), dispose: vi.fn(), show: host.outputShow }),
    createStatusBarItem: () => {
      const item = { text: '', name: '', tooltip: '', command: '', show: vi.fn(), dispose: vi.fn() };
      host.statusItems.push(item);
      return item;
    },
    showErrorMessage: (...args: unknown[]) => host.showErrorMessage(...args),
    showInformationMessage: (...args: unknown[]) => host.showInformationMessage(...args),
    showQuickPick: (...args: unknown[]) => host.showQuickPick(...args),
    showTextDocument: (...args: unknown[]) => host.showTextDocument(...args),
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({
      report: (value: { message: string }) => host.progressMessages.push(value.message),
    }, {
      isCancellationRequested: host.cancelInitially,
      onCancellationRequested: (listener: () => void) => {
        host.cancel = listener;
        return { dispose: () => { host.cancel = undefined; } };
      },
    }),
    tabGroups: { activeTabGroup: { activeTab: undefined } },
    get activeTextEditor() { return host.activeUri === undefined ? undefined : { document: { uri: host.activeUri } }; },
  },
  workspace: {
    get isTrusted() { return host.trusted; },
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key === 'command' ? host.command
        : key === 'args' ? host.args : key === 'timeoutMs' ? host.timeoutMs : key === 'profiles' ? host.profiles : fallback,
    }),
    openTextDocument: async (document: { language: string; content: string }) => {
      host.documents.push(document);
      return document;
    },
  },
  env: { clipboard: { writeText: (...args: unknown[]) => host.clipboardWrite(...args) } },
  commands: { executeCommand: (...args: unknown[]) => host.executeCommand(...args), registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
  extensions: { get all() { return host.installed; } },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1 },
  TabInputText: class TabInputText {},
  TabInputCustom: class TabInputCustom {},
  CancellationTokenSource: class CancellationTokenSource {
    readonly token = { isCancellationRequested: false };
    cancel(): void { this.token.isCancellationRequested = true; }
    dispose(): void {}
  },
}));

describe('ACP side-agent diagnostic routing', () => {
  beforeEach(() => {
    vi.resetModules();
    host.trusted = false;
    host.command = '';
    host.args = [];
    host.timeoutMs = 1_000;
    host.profiles = undefined;
    host.activeUri = undefined;
    host.action = 'Send to side agent';
    host.installed = [{
      id: 'Sumi-Sophia.jsonlview-data-studio',
      packageJSON: { contributes: { commands: [{ command: 'jsonlView.open' }] } },
    }];
    host.outputLines.length = 0;
    host.progressMessages.length = 0;
    host.statusItems.length = 0;
    host.cancelInitially = false;
    host.cancel = undefined;
    host.outputShow.mockReset();
    host.documents.length = 0;
    host.clipboardWrite.mockReset().mockResolvedValue(undefined);
    host.executeCommand.mockReset().mockRejectedValue(new Error('no MCP recipient'));
    host.showTextDocument.mockReset().mockResolvedValue(undefined);
    host.showInformationMessage.mockReset().mockResolvedValue(undefined);
    host.showQuickPick.mockReset().mockImplementation(async (items: unknown[]) => items[0]);
    host.showErrorMessage.mockReset().mockImplementation(async () => host.action);
  });

  async function activateConflict(): Promise<void> {
    const extension = await import('../../../src/extension/extension');
    extension.activate({
      extensionPath: fixtureExtensionPath,
      extensionMode: 3,
      extension: { id: 'Sumi-Sophia.jsonl-view', packageJSON: { version: '0.2.11' } },
      subscriptions: [],
    } as never);
  }

  it('marks ACP launch settings as restricted by the Workspace Trust manifest contract', () => {
    expect(manifest.capabilities.untrustedWorkspaces).toMatchObject({
      supported: 'limited',
      description: '%capabilities.untrustedWorkspaces.description%',
      restrictedConfigurations: ['jsonlView.acp.command', 'jsonlView.acp.args', 'jsonlView.acp.timeoutMs', 'jsonlView.acp.profiles'],
    });
    expect(packageNls['capabilities.untrustedWorkspaces.description']).toContain('trusted workspace');
    expect(manifest.files).toContain('package.nls.json');
    expect(manifest.contributes.menus.commandPalette).toContainEqual({
      command: 'jsonlView.sendLastDiagnosticViaAcp',
      when: 'isWorkspaceTrusted',
    });
  });

  it('keeps the ACP configuration blocked in an untrusted workspace and copies the toast diagnostic', async () => {
    host.command = '__must_not_launch_in_untrusted_workspace__';
    await activateConflict();
    await vi.waitFor(() => expect(host.clipboardWrite).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    expect(host.executeCommand).not.toHaveBeenCalled();
    expect(host.clipboardWrite.mock.calls[0]?.[0]).toContain('Another enabled extension declares jsonlView.open.');
    expect(host.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('workspace is untrusted'));
  }, 15_000);

  it('sends the notification-captured diagnostic through ACP when configured and trusted', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);const result=q.method==='initialize'?{protocolVersion:1}:q.method==='session/new'?{sessionId:'test-session'}:{stopReason:'end_turn',echo:q.params.prompt[0].text};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+String.fromCharCode(10));});"];
    await activateConflict();

    await vi.waitFor(() => expect(host.documents).toHaveLength(1), { timeout: 5_000 });
    const transcript = JSON.parse(host.documents[0]!.content) as { schema: string; adapterId: string; agentProfileId: string; protocolVersion: string; transport: string; executionTarget: string; result: { echo: string } };
    expect(transcript.result.echo).toContain('Another enabled extension declares jsonlView.open.');
    expect(transcript).toMatchObject({ schema: 'jsonlview.acp-transcript.v2', adapterId: 'generic.acp-v1', agentProfileId: 'legacy', protocolVersion: '1', transport: 'stdio', executionTarget: 'local' });
    expect(host.clipboardWrite).not.toHaveBeenCalled();
    expect(host.executeCommand).not.toHaveBeenCalled();
    expect(host.showInformationMessage).toHaveBeenCalledWith('The bounded diagnostic was sent through the configured ACP agent.');
    expect(host.progressMessages.join('\n')).toMatch(/handshake.*initialize/s);
    expect(host.progressMessages.join('\n')).toMatch(/session.*session\/new/s);
    expect(host.progressMessages.join('\n')).toMatch(/response.*session\/prompt/s);
    expect(host.statusItems[0]?.command).toBe('jsonlView.showOutput');
    expect(host.statusItems[0]?.show).toHaveBeenCalled();
    expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
  }, 20_000);

  it('lets the user choose among explicitly configured local ACP agents', async () => {
    host.trusted = true;
    host.profiles = [
      { id: 'missing-agent', label: 'Unavailable', command: '__must_not_be_selected__', args: [], timeoutMs: 1000 },
      { id: 'chosen-agent', label: 'Chosen Agent', command: process.execPath, args: ['-e', "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);const result=q.method==='initialize'?{protocolVersion:1}:q.method==='session/new'?{sessionId:'chosen-session'}:{stopReason:'end_turn',profile:'chosen'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});"], timeoutMs: 1000 },
    ];
    host.showQuickPick.mockImplementation(async (items: Array<{ profileId?: string }>, options: { title?: string }) =>
      options.title === 'Choose an ACP agent' ? items[1] : items[0]);

    await activateConflict();
    await vi.waitFor(() => expect(host.documents).toHaveLength(1), { timeout: 5_000 });

    expect(host.showQuickPick).toHaveBeenCalledWith([
      { label: 'Unavailable', description: 'ACP v1 · local stdio', profileId: 'missing-agent' },
      { label: 'Chosen Agent', description: 'ACP v1 · local stdio', profileId: 'chosen-agent' },
    ], expect.objectContaining({ title: 'Choose an ACP agent' }), expect.objectContaining({ isCancellationRequested: false }));
    expect(JSON.parse(host.documents[0]!.content)).toMatchObject({
      schema: 'jsonlview.acp-transcript.v2',
      adapterId: 'generic.acp-v1',
      agentProfileId: 'chosen-agent',
      executionTarget: 'local',
      result: { profile: 'chosen' },
    });
    expect(host.outputLines.join('\n')).not.toContain('__must_not_be_selected__');
  }, 20_000);

  it('starts no process and publishes no prompt when the ACP profile picker is canceled', async () => {
    host.trusted = true;
    host.profiles = [
      { id: 'agent-one', label: 'Agent One', command: '__must_not_launch__', args: [], timeoutMs: 1000 },
      { id: 'agent-two', label: 'Agent Two', command: '__must_not_launch__', args: [], timeoutMs: 1000 },
    ];
    host.showQuickPick.mockImplementation(async (_items: unknown[], options: { title?: string }) =>
      options.title === 'Choose an ACP agent' ? undefined : undefined);

    await activateConflict();
    await vi.waitFor(() => expect(host.showQuickPick).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ title: 'Choose an ACP agent' }), expect.objectContaining({ isCancellationRequested: false })));

    expect(host.statusItems).toHaveLength(0);
    expect(host.documents).toHaveLength(0);
    expect(host.clipboardWrite).not.toHaveBeenCalled();
    expect(host.executeCommand).not.toHaveBeenCalled();
  }, 15_000);

  it.each(['initialize', 'session/new', 'session/prompt'] as const)('identifies a timeout at %s without exposing adapter stderr', async (operation) => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', `const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);if(q.method===${JSON.stringify(operation)}){process.stderr.write('private-agent-secret\\n');return;}const result=q.method==='initialize'?{protocolVersion:1}:{sessionId:'s'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`];
    host.showErrorMessage.mockImplementation(async (message: string) => message.startsWith('ACP ') ? 'Open Output' : host.action);
    await activateConflict();
    await vi.waitFor(() => expect(host.showErrorMessage.mock.calls.some((call) => String(call[0]).includes(`(${operation})`))).toBe(true), { timeout: 5_000 });
    const message = host.showErrorMessage.mock.calls.find((call) => String(call[0]).includes(`(${operation})`))?.[0];
    expect(message).toMatch(/timed out.*1 s/);
    expect(message).toContain(operation === 'session/prompt' ? 'already submitted' : 'No diagnostic was sent');
    expect(host.outputLines.join('\n')).toContain(`"stage":"${operation}"`);
    expect(host.outputLines.join('\n')).not.toContain('private-agent-secret');
    expect(host.showErrorMessage.mock.calls.flat().join('\n')).not.toContain('private-agent-secret');
    expect(host.outputShow).toHaveBeenCalled();
    expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
    expect(host.documents).toHaveLength(0);
  }, 15_000);

  it('reports a missing executable with a concrete configuration action', async () => {
    host.trusted = true;
    host.command = '__missing_acp_executable__';
    await activateConflict();
    await vi.waitFor(() => expect(host.showErrorMessage.mock.calls.some((call) => String(call[0]).includes('jsonlView.acp.command'))).toBe(true), { timeout: 5_000 });
    expect(host.outputLines.join('\n')).toContain('ENOENT');
    expect(host.outputLines.join('\n')).not.toContain('__missing_acp_executable__');
    expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
  }, 15_000);

  it('distinguishes authentication-required from transport failure without disclosing the RPC error body', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);const response=q.method==='initialize'?{result:{protocolVersion:1}}:{error:{code:-32000,message:'private-provider-credential'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...response})+'\\n');});"];
    await activateConflict();
    await vi.waitFor(() => expect(host.showErrorMessage.mock.calls.some((call) => String(call[0]).includes('requires authentication'))).toBe(true), { timeout: 5_000 });
    expect(host.outputLines.join('\n')).toContain('-32000');
    expect(host.outputLines.join('\n')).not.toContain('private-provider-credential');
    expect(host.showErrorMessage.mock.calls.flat().join('\n')).not.toContain('private-provider-credential');
  }, 15_000);

  it('does not launch when progress is already cancelled', async () => {
    host.trusted = true;
    host.cancelInitially = true;
    host.command = '__must_not_launch__';
    await activateConflict();
    await vi.waitFor(() => expect(host.showInformationMessage).toHaveBeenCalledWith('The ACP diagnostic request was cancelled.'), { timeout: 5_000 });
    expect(host.outputLines.join('\n')).not.toContain('acp-error');
    expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
  }, 15_000);

  it('closes a rejected prompt while the error notification is still awaiting a choice', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);const response=q.method==='initialize'?{result:{protocolVersion:1}}:q.method==='session/new'?{result:{sessionId:'s'}}:{error:{code:-32603,message:'request failed'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...response})+'\\n');});"];
    let dismiss: (choice: string | undefined) => void = () => {};
    const notification = new Promise<string | undefined>((resolve) => { dismiss = resolve; });
    host.showErrorMessage.mockImplementation((message: string) => message.startsWith('ACP ') ? notification : Promise.resolve(host.action));
    const { AcpSessionManager } = await import('../../../src/extension/acp/session-manager');
    const close = vi.spyOn(AcpSessionManager.prototype, 'close');
    try {
      await activateConflict();
      await vi.waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 2_000 });
      expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
      expect(host.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('RPC -32603'), 'Open Output');
    } finally {
      dismiss(undefined);
      await vi.waitFor(() => expect(close).toHaveBeenCalled());
      close.mockRestore();
    }
  }, 15_000);

  it('cancels a stalled handshake and clears its visible progress', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', "process.stdin.resume();"];
    await activateConflict();
    await vi.waitFor(() => expect(host.cancel).toBeTypeOf('function'), { timeout: 5_000 });
    host.cancel?.();
    await vi.waitFor(() => expect(host.showInformationMessage).toHaveBeenCalledWith('The ACP diagnostic request was cancelled.'));
    expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
    expect(host.outputLines.join('\n')).not.toContain('acp-error');
  }, 15_000);

  it('retires the previous connection quietly when another explicit send supersedes it', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', 'process.stdin.resume();'];
    await activateConflict();
    await vi.waitFor(() => expect(host.progressMessages.join('\n')).toContain('initialize'), { timeout: 5_000 });
    host.args = ['-e', "const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);const result=q.method==='initialize'?{protocolVersion:1}:q.method==='session/new'?{sessionId:'new'}:{stopReason:'end_turn'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});"];
    await activateConflict();
    await vi.waitFor(() => expect(host.documents).toHaveLength(1), { timeout: 5_000 });
    expect(host.showErrorMessage.mock.calls.flat().join('\n')).not.toMatch(/ACP failed|did not accept/);
    expect(host.statusItems).toHaveLength(2);
    for (const status of host.statusItems) expect(status.dispose).toHaveBeenCalledOnce();
  }, 15_000);

  it('closes an active ACP session when the extension deactivates', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', 'process.stdin.resume();'];
    const { AcpSessionManager } = await import('../../../src/extension/acp/session-manager');
    const close = vi.spyOn(AcpSessionManager.prototype, 'close');
    const extension = await import('../../../src/extension/extension');

    try {
      await activateConflict();
      await vi.waitFor(() => expect(host.progressMessages.join('\n')).toContain('initialize'), { timeout: 5_000 });

      await extension.deactivate();

      expect(close).toHaveBeenCalled();
      expect(host.documents).toHaveLength(0);
      expect(host.statusItems[0]?.dispose).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      await extension.deactivate();
    }
  }, 15_000);

  it('waits for a pending ACP picker during deactivation without launching its selected profile', async () => {
    host.trusted = true;
    host.profiles = [
      { id: 'agent-one', label: 'Agent One', command: process.execPath, args: ['-e', 'process.stdin.resume();'], timeoutMs: 1000 },
      { id: 'agent-two', label: 'Agent Two', command: process.execPath, args: ['-e', 'process.stdin.resume();'], timeoutMs: 1000 },
    ];
    let resolvePicker!: (value: unknown) => void;
    host.showQuickPick.mockImplementation(() => new Promise((resolve) => { resolvePicker = resolve; }));
    await activateConflict();
    await vi.waitFor(() => expect(resolvePicker).toBeTypeOf('function'));

    const extension = await import('../../../src/extension/extension');
    let closed = false;
    const closing = extension.deactivate().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolvePicker({ label: 'Agent One', profileId: 'agent-one' });
    await closing;

    expect(closed).toBe(true);
    expect(host.progressMessages).toEqual([]);
    expect(host.statusItems).toHaveLength(0);
    expect(host.outputLines.join('\n')).not.toContain('acp-stage');
  });

  it('uses the existing MCP/clipboard fallback when no ACP command is configured', async () => {
    await activateConflict();

    await vi.waitFor(() => expect(host.clipboardWrite).toHaveBeenCalledTimes(1));
    expect(host.executeCommand).toHaveBeenCalled();
    expect(host.clipboardWrite.mock.calls[0]?.[0]).toContain('Another enabled extension declares jsonlView.open.');
    expect(host.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('No side-agent MCP bridge'));
  });

  it('does not wait for an unresolved optional side-agent command during deactivation', async () => {
    let resolveCommand!: () => void;
    host.executeCommand.mockImplementation(() => new Promise<void>((resolve) => { resolveCommand = resolve; }));
    await activateConflict();
    await vi.waitFor(() => expect(resolveCommand).toBeTypeOf('function'));

    const extension = await import('../../../src/extension/extension');
    await extension.deactivate();
    const closedOutput = [...host.outputLines];

    resolveCommand();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.outputLines).toEqual(closedOutput);
    expect(host.clipboardWrite).not.toHaveBeenCalled();
    expect(host.showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining('No side-agent MCP bridge'));
  });

  it('passes the active JSONL MCP server in the official ACP v1 stdio shape to an authenticated adapter', async () => {
    host.trusted = true;
    host.activeUri = { scheme: 'file', fsPath: fixtureSourcePath, path: decodeURIComponent(pathToFileURL(fixtureSourcePath).pathname) };
    host.command = process.execPath;
    host.args = ['-e', "let servers;const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);let result;if(q.method==='initialize')result={protocolVersion:1,authMethods:[{id:'native',name:'Native login'}]};else if(q.method==='session/new'){servers=q.params.mcpServers;const ok=servers.every(s=>typeof s.name==='string'&&typeof s.command==='string'&&Array.isArray(s.args)&&Array.isArray(s.env)&&s.env.every(e=>typeof e.name==='string'&&typeof e.value==='string'));if(!ok){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'ACP v1 env must be an array'}})+'\\n');return;}result={sessionId:'official-v1'};}else result={stopReason:'end_turn',servers};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});"];
    await activateConflict();
    await vi.waitFor(() => expect(host.documents).toHaveLength(1), { timeout: 5_000 });
    const transcript = JSON.parse(host.documents[0]!.content) as { result: { servers: unknown[] } };
    expect(transcript.result.servers).toEqual([{
      name: 'jsonlview', command: process.execPath, args: [resolve(fixtureExtensionPath, 'dist', 'mcp-server.cjs')],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'JSONLVIEW_EXTENSION_PATH', value: fixtureExtensionPath },
        { name: 'JSONLVIEW_MCP_SOURCE_ID', value: 'active-jsonl' },
        { name: 'JSONLVIEW_MCP_SOURCE_PATH', value: fixtureSourcePath },
      ],
    }]);
  }, 20_000);

  it('traces source path and record data across an explicit synthetic ACP-to-MCP session', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'jsonlview-acp-mcp-data-classification-'));
    const sourcePath = join(tempRoot, 'source.jsonl');
    const recordText = 'A02_SENTINEL_RECORD_TEXT_47';
    await writeFile(sourcePath, `${JSON.stringify({ role: 'assistant', text: recordText })}\n`, 'utf8');
    host.trusted = true;
    host.activeUri = { scheme: 'file', fsPath: sourcePath, path: sourcePath.replaceAll('\\', '/') };
    host.command = process.execPath;
    host.args = [resolve(process.cwd(), 'test/fixtures/acp-mcp-dataflow-agent.mjs')];

    try {
      await activateConflict();
      await vi.waitFor(() => expect(host.documents).toHaveLength(1), { timeout: 10_000 });
      const transcript = JSON.parse(host.documents[0]!.content) as {
        updates: unknown[];
        result: {
          sourceId: string;
          sourcePathProvided: boolean;
          sourcePathReadable: boolean;
          promptContainsSourcePath: boolean;
          promptContainsRecord: boolean;
          toolName: string;
          initialized: boolean;
          toolSchemaArgumentNames: string[];
          toolArguments: Record<string, unknown>;
          mcpResult: { structuredContent: { sourceId: string; rows: Array<{ text: string }> }; observedArguments: Record<string, unknown> };
        };
      };
      const transcriptText = JSON.stringify(transcript);
      expect(transcript.result).toMatchObject({
        sourceId: 'active-jsonl',
        sourcePathProvided: true,
        sourcePathReadable: true,
        promptContainsSourcePath: false,
        promptContainsRecord: false,
        toolName: 'jsonlview_query_records',
        initialized: true,
        toolSchemaArgumentNames: ['sourceId', 'limit'],
        toolArguments: { sourceId: 'active-jsonl', limit: 1 },
        mcpResult: {
          structuredContent: { sourceId: 'active-jsonl', rows: [{ text: recordText }] },
          observedArguments: { sourceId: 'active-jsonl', limit: 1 },
        },
      });
      expect(transcript.updates).toContainEqual(expect.objectContaining({
        update: expect.objectContaining({ text: recordText }),
      }));
      expect(transcriptText).toContain(recordText);
      expect(transcriptText).not.toContain(sourcePath);
      expect(host.outputLines.join('\n')).not.toContain(sourcePath);
      expect(host.outputLines.join('\n')).not.toContain(recordText);
    } finally {
      const extension = await import('../../../src/extension/extension');
      await extension.deactivate();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it('routes an adapter permission request through a native once-only picker', async () => {
    host.trusted = true;
    host.command = process.execPath;
    host.args = ['-e', "let prompt;const r=require('node:readline').createInterface({input:process.stdin});r.on('line',s=>{const q=JSON.parse(s);if(q.method==='session/prompt'){prompt=q.id;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'s',toolCall:{toolCallId:'read-1',title:'Read authorized records'},options:[{optionId:'always',name:'Always allow',kind:'allow_always'},{optionId:'once',name:'Allow this read',kind:'allow_once'},{optionId:'no',name:'Reject this read',kind:'reject_once'}]}})+'\\n');return;}const result=q.id==='permission'?{stopReason:'end_turn',permission:q.result}:q.method==='initialize'?{protocolVersion:1}:{sessionId:'s'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id==='permission'?prompt:q.id,result})+'\\n');});"];
    await activateConflict();
    await vi.waitFor(() => expect(host.documents).toHaveLength(1), { timeout: 5_000 });
    expect(host.showQuickPick).toHaveBeenCalledWith([
      { label: 'Allow this read', description: 'Allow once', optionId: 'once' },
      { label: 'Reject this read', description: 'Reject once', optionId: 'no' },
    ], expect.objectContaining({ title: 'ACP tool permission', placeHolder: 'Read authorized records' }), expect.anything());
    expect(JSON.parse(host.documents[0]!.content).result.permission).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
  }, 20_000);
});
