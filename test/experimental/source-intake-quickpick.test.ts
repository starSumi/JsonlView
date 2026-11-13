import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { chooseSourceImportAction, chooseSourceIntakeAction, type SourceIntakeQuickPickItem } from '../../src/experimental/session-navigator/source-intake-quickpick';

class QuickPickHarness {
  public items: readonly SourceIntakeQuickPickItem[] = [];
  public selectedItems: readonly SourceIntakeQuickPickItem[] = [];
  public title: string | undefined;
  public placeholder: string | undefined;
  public matchOnDescription = false;
  public canSelectMany = true;
  public shown = false;
  public disposed = false;
  readonly #accepted = new Set<() => void>();
  readonly #hidden = new Set<() => void>();

  public onDidAccept(listener: () => void): vscode.Disposable {
    this.#accepted.add(listener);
    return { dispose: () => this.#accepted.delete(listener) };
  }

  public onDidHide(listener: () => void): vscode.Disposable {
    this.#hidden.add(listener);
    return { dispose: () => this.#hidden.delete(listener) };
  }

  public show(): void {
    this.shown = true;
  }

  public dispose(): void {
    this.disposed = true;
  }

  public accept(action: SourceIntakeQuickPickItem['action']): void {
    const selected = this.items.find((item) => item.action === action);
    if (selected !== undefined) this.selectedItems = [selected];
    for (const listener of this.#accepted) listener();
  }

  public hide(): void {
    for (const listener of this.#hidden) listener();
  }
}

function createPickers(...pickers: QuickPickHarness[]): () => vscode.QuickPick<SourceIntakeQuickPickItem> {
  let index = 0;
  return () => pickers[index++] as unknown as vscode.QuickPick<SourceIntakeQuickPickItem>;
}

describe('source intake QuickPick', () => {
  it('keeps Import and Paste as peer choices, then routes Import to Files or Folder', async () => {
    const primary = new QuickPickHarness();
    const importTarget = new QuickPickHarness();
    const result = chooseSourceIntakeAction(createPickers(primary, importTarget));

    expect(primary.shown).toBe(true);
    expect(primary.items.map(({ label }) => label)).toEqual(['$(cloud-download) Import', '$(edit) Paste']);
    expect(primary.canSelectMany).toBe(false);
    primary.accept('import');
    await Promise.resolve();

    expect(importTarget.shown).toBe(true);
    expect(importTarget.items.map(({ label }) => label)).toEqual(['$(file) Files', '$(folder) Folder', '$(plug) Connect local agent']);
    importTarget.accept('folder');

    await expect(result).resolves.toBe('folder');
    expect(primary.disposed).toBe(true);
    expect(importTarget.disposed).toBe(true);
  });

  it('returns Paste directly without opening an import-target picker', async () => {
    const primary = new QuickPickHarness();
    const result = chooseSourceIntakeAction(createPickers(primary));

    primary.accept('paste');

    await expect(result).resolves.toBe('paste');
    expect(primary.disposed).toBe(true);
  });

  it('opens import targets directly from the card and returns only an explicit agent choice', async () => {
    const target = new QuickPickHarness();
    const result = chooseSourceImportAction(createPickers(target));
    expect(target.items.map(({ action }) => action)).toEqual(['files', 'folder', 'agent']);
    expect(target.selectedItems).toEqual([]);
    target.accept('agent');
    await expect(result).resolves.toBe('agent');
    expect(target.disposed).toBe(true);
  });

  it('treats Escape at either level as cancellation', async () => {
    const primary = new QuickPickHarness();
    const cancelledAtPrimary = chooseSourceIntakeAction(createPickers(primary));
    primary.hide();
    await expect(cancelledAtPrimary).resolves.toBeUndefined();

    const secondPrimary = new QuickPickHarness();
    const importTarget = new QuickPickHarness();
    const cancelledAtImport = chooseSourceIntakeAction(createPickers(secondPrimary, importTarget));
    secondPrimary.accept('import');
    await Promise.resolve();
    importTarget.hide();
    await expect(cancelledAtImport).resolves.toBeUndefined();
  });
});
