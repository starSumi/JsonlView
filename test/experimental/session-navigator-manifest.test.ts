import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Session Navigator layout contract', () => {
  it('keeps exactly three compact primary actions and reserves intake to its dedicated view', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const primary = manifest.contributes.menus['view/title'].filter((item: { when: string; group: string }) => item.when.includes('jsonlView.sessionNavigator') && item.group.startsWith('navigation'));
    expect(primary.map((item: { command: string }) => item.command)).toEqual([
      'jsonlView.sessionNavigator.refresh', 'jsonlView.sessionNavigator.addSource', 'jsonlView.sessionNavigator.sort',
    ]);
    for (const item of primary) expect(manifest.contributes.commands.find((command: { command: string }) => command.command === item.command).icon).toMatch(/^\$\(/u);
    expect(manifest.contributes.viewsWelcome).toEqual([
      expect.objectContaining({
        view: 'jsonlView.sessionNavigator',
        when: '!config.jsonlView.sessionNavigator.enabled',
        contents: expect.stringContaining('[Enable Session Navigator](command:jsonlView.sessionNavigator.enable)'),
      }),
    ]);
    expect(manifest.contributes.views.jsonlViewSessionNavigator[0]).toMatchObject({ type: 'webview', id: 'jsonlView.sourceDrop' });
    expect(manifest.contributes.views.jsonlViewSessionNavigator.find((view: { id: string }) => view.id === 'jsonlView.sessionNavigator')).toBeTruthy();
    expect(manifest.contributes.views.jsonlViewSessionNavigator.find((view: { id: string }) => view.id === 'jsonlView.recentPreviews')).toBeUndefined();
  });

  it('keeps Agent Sessions as one fixed Activity Bar entry', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(manifest.contributes.viewsContainers)).toEqual(['activitybar']);
    expect(manifest.contributes.viewsContainers.activitybar).toEqual([
      { id: 'jsonlViewSessionNavigator', title: 'Agent Sessions', icon: '$(list-tree)' },
    ]);
    expect(manifest.contributes.commands.find((command: { command: string }) => command.command === 'jsonlView.sessionNavigator.open')).not.toHaveProperty('icon');
    const listTreeIcons = manifest.contributes.commands.filter((command: { icon?: string }) => command.icon === '$(list-tree)');
    expect(listTreeIcons).toHaveLength(0);
    expect(manifest.contributes.views.jsonlViewSessionNavigator.map((view: { id: string }) => view.id)).toEqual([
      'jsonlView.sourceDrop', 'jsonlView.sessionNavigator',
    ]);
  });

  it('keeps the Data Studio resource action without a duplicate title icon', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.contributes.menus['editor/title']).toBeUndefined();
    const explorerItem = manifest.contributes.menus['explorer/context'].find((item: { command: string }) => item.command === 'jsonlView.open');
    expect(explorerItem).toMatchObject({
      when: 'resourceExtname == .jsonl || resourceExtname == .ndjson',
      group: 'navigation@1',
    });
    expect(manifest.contributes.customEditors).toEqual(expect.arrayContaining([
      expect.objectContaining({ viewType: 'jsonlView.editor', displayName: 'JsonlView Data Studio' }),
    ]));
  });

  it('keeps entity context actions stable and file safe', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const entityItems = manifest.contributes.menus['view/item/context'].filter((item: { when: string }) => item.when.includes('viewItem == jsonlView.sessionNavigator.entity'));
    expect(entityItems.map((item: { command: string }) => item.command)).toEqual([
      'jsonlView.sessionNavigator.openEntity',
      'jsonlView.sessionNavigator.openEntityWith',
      'jsonlView.sessionNavigator.revealInFileExplorer',
      'jsonlView.sessionNavigator.openInIntegratedTerminal',
      'jsonlView.sessionNavigator.copyPath',
      'jsonlView.sessionNavigator.copyRelativePath',
      'jsonlView.sessionNavigator.copySessionId',
      'jsonlView.sessionNavigator.openTimeline',
    ]);
    expect(entityItems.map((item: { group: string }) => item.group)).toEqual([
      'navigation@1', 'navigation@2', 'navigation@3', 'navigation@4',
      'copy@1', 'copy@2', 'copy@3', 'timeline@1',
    ]);
    expect(entityItems.every((item: { when: string }) => item.when === 'view == jsonlView.sessionNavigator && viewItem == jsonlView.sessionNavigator.entity')).toBe(true);
    expect(entityItems.some((item: { command: string }) => /delete|remove/iu.test(item.command))).toBe(false);
    for (const item of entityItems) expect(manifest.contributes.commands.some((command: { command: string }) => command.command === item.command)).toBe(true);
  });

  it('gives source nodes only safe filesystem context actions, including partial sources', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const sourceItems = manifest.contributes.menus['view/item/context'].filter((item: { when: string }) => item.when.includes('viewItem =~ /^jsonlView\\.sessionNavigator\\.source'));
    expect(sourceItems.map((item: { command: string }) => item.command)).toEqual([
      'jsonlView.sessionNavigator.revealInFileExplorer',
      'jsonlView.sessionNavigator.openInIntegratedTerminal',
      'jsonlView.sessionNavigator.copyPath',
      'jsonlView.sessionNavigator.copyRelativePath',
    ]);
    expect(sourceItems.every((item: { when: string }) => item.when === 'view == jsonlView.sessionNavigator && viewItem =~ /^jsonlView\\.sessionNavigator\\.source(?:\\.partial)?$/')).toBe(true);
    expect(sourceItems.some((item: { command: string }) => /openEntity|openEntityWith|copySessionId|openTimeline/iu.test(item.command))).toBe(false);
  });

  it('keeps temporary preview actions inside the Sessions tree', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const previewItems = manifest.contributes.menus['view/item/context'].filter((item: { command: string }) => item.command.startsWith('jsonlView.previews.'));
    expect(previewItems.map((item: { command: string }) => item.command)).toEqual([
      'jsonlView.previews.saveAs', 'jsonlView.previews.openSavedCopy',
    ]);
    expect(previewItems.every((item: { when: string }) => item.when.startsWith('view == jsonlView.sessionNavigator && viewItem == jsonlView.preview.'))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('jsonlView.recentPreviews');
  });

  it('exposes an MCP capability inspection command without declaring a transport', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(manifest.contributes.commands.find((command: { command: string }) => command.command === 'jsonlView.sessionNavigator.mcpCapability')).toMatchObject({ icon: '$(symbol-interface)' });
    expect(JSON.stringify(manifest)).not.toMatch(/stdio|websocket|mcp-server/iu);
  });
});
