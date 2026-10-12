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
    expect(manifest.contributes.viewsWelcome).toBeUndefined();
    expect(manifest.contributes.views.jsonlViewSessionNavigator[0]).toMatchObject({ type: 'webview', id: 'jsonlView.sourceDrop' });
    expect(manifest.contributes.views.jsonlViewSessionNavigator.find((view: { id: string }) => view.id === 'jsonlView.sessionNavigator')).toBeTruthy();
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

  it('keeps the JSONL navigator action ahead of the always-visible Data Studio title action', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const titleItems = manifest.contributes.menus['editor/title'];
    expect(titleItems).toEqual([
      {
        command: 'jsonlView.sessionNavigator.open',
        when: 'resourceExtname == .jsonl || resourceExtname == .ndjson',
        group: 'navigation@1',
      },
      {
        command: 'jsonlView.open',
        group: 'navigation@2',
      },
    ]);
    expect(titleItems.find((item: { command: string }) => item.command === 'jsonlView.open')).not.toHaveProperty('when');
    expect(titleItems.find((item: { command: string }) => item.command === 'jsonlView.sessionNavigator.open')).toMatchObject({
      when: 'resourceExtname == .jsonl || resourceExtname == .ndjson',
      group: 'navigation@1',
    });
    expect(Number(titleItems[0].group.split('@')[1])).toBeLessThan(Number(titleItems[1].group.split('@')[1]));
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
});
