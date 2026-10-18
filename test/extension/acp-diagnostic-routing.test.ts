import { beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../package.json';
import packageNls from '../../package.nls.json';

const host = vi.hoisted(() => ({
  trusted: false,
  command: '',
  args: [] as string[],
  timeoutMs: 1_000,
  action: 'Send to side agent' as string | undefined,
  installed: [] as unknown[],
  outputLines: [] as string[],
  documents: [] as Array<{ language: string; content: string }>,
  clipboardWrite: vi.fn(),
  executeCommand: vi.fn(),
  showTextDocument: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: (line: string) => host.outputLines.push(line), dispose: vi.fn(), show: vi.fn() }),
    showErrorMessage: (...args: unknown[]) => host.showErrorMessage(...args),
    showInformationMessage: (...args: unknown[]) => host.showInformationMessage(...args),
    showTextDocument: (...args: unknown[]) => host.showTextDocument(...args),
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) => task({}, {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: vi.fn() }),
    }),
    tabGroups: { activeTabGroup: { activeTab: undefined } },
    activeTextEditor: undefined,
  },
  workspace: {
    get isTrusted() { return host.trusted; },
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key === 'command' ? host.command
        : key === 'args' ? host.args : key === 'timeoutMs' ? host.timeoutMs : fallback,
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
  TabInputText: class TabInputText {},
  TabInputCustom: class TabInputCustom {},
}));

describe('ACP side-agent diagnostic routing', () => {
  beforeEach(() => {
    vi.resetModules();
    host.trusted = false;
    host.command = '';
    host.args = [];
    host.timeoutMs = 1_000;
    host.action = 'Send to side agent';
    host.installed = [{
      id: 'Sumi-Sophia.jsonlview-data-studio',
      packageJSON: { contributes: { commands: [{ command: 'jsonlView.open' }] } },
    }];
    host.outputLines.length = 0;
    host.documents.length = 0;
    host.clipboardWrite.mockReset().mockResolvedValue(undefined);
    host.executeCommand.mockReset().mockRejectedValue(new Error('no MCP recipient'));
    host.showTextDocument.mockReset().mockResolvedValue(undefined);
    host.showInformationMessage.mockReset().mockResolvedValue(undefined);
    host.showErrorMessage.mockReset().mockImplementation(async () => host.action);
  });

  async function activateConflict(): Promise<void> {
    const extension = await import('../../src/extension/extension');
    extension.activate({
      extensionPath: 'D:/test/jsonlview',
      extensionMode: 3,
      extension: { id: 'Sumi-Sophia.jsonl-view', packageJSON: { version: '0.2.11' } },
      subscriptions: [],
    } as never);
  }

  it('marks ACP launch settings as restricted by the Workspace Trust manifest contract', () => {
    expect(manifest.capabilities.untrustedWorkspaces).toMatchObject({
      supported: 'limited',
      description: '%capabilities.untrustedWorkspaces.description%',
      restrictedConfigurations: ['jsonlView.acp.command', 'jsonlView.acp.args', 'jsonlView.acp.timeoutMs'],
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
    const transcript = JSON.parse(host.documents[0]!.content) as { result: { echo: string } };
    expect(transcript.result.echo).toContain('Another enabled extension declares jsonlView.open.');
    expect(host.clipboardWrite).not.toHaveBeenCalled();
    expect(host.executeCommand).not.toHaveBeenCalled();
    expect(host.showInformationMessage).toHaveBeenCalledWith('The bounded diagnostic was sent through the configured ACP agent.');
  }, 20_000);

  it('uses the existing MCP/clipboard fallback when no ACP command is configured', async () => {
    await activateConflict();

    await vi.waitFor(() => expect(host.clipboardWrite).toHaveBeenCalledTimes(1));
    expect(host.executeCommand).toHaveBeenCalled();
    expect(host.clipboardWrite.mock.calls[0]?.[0]).toContain('Another enabled extension declares jsonlView.open.');
    expect(host.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('No side-agent MCP bridge'));
  });
});
