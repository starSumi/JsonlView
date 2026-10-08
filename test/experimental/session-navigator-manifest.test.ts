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
});
