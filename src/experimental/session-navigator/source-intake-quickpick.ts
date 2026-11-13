import type * as vscode from 'vscode';

export type SourceIntakeAction = 'files' | 'folder' | 'paste' | 'agent';
export type SourceIntakeQuickPickItem = vscode.QuickPickItem & {
  readonly action: 'import' | SourceIntakeAction;
};

const PRIMARY_ACTIONS: readonly SourceIntakeQuickPickItem[] = [
  {
    label: '$(cloud-download) Import',
    description: 'Choose files, a folder, or connect a local agent',
    action: 'import',
  },
  {
    label: '$(edit) Paste',
    description: 'Paste JSONL into a temporary preview',
    action: 'paste',
  },
];

const IMPORT_TARGETS: readonly SourceIntakeQuickPickItem[] = [
  {
    label: '$(file) Files',
    description: 'JSONL and NDJSON files',
    action: 'files',
  },
  {
    label: '$(folder) Folder',
    description: 'A local source folder',
    action: 'folder',
  },
  {
    label: '$(plug) Connect local agent',
    description: 'Explicitly choose and authorize an agent source',
    action: 'agent',
  },
];

/** Presents the native intake choices and returns only an explicit user choice. */
export async function chooseSourceIntakeAction(
  createQuickPick: () => vscode.QuickPick<SourceIntakeQuickPickItem>,
): Promise<SourceIntakeAction | undefined> {
  const action = await new Promise<SourceIntakeQuickPickItem['action'] | undefined>((resolve) => {
    const primary = createQuickPick();
    primary.title = 'Add source';
    primary.placeholder = 'Import a source, or paste a temporary draft';
    primary.items = PRIMARY_ACTIONS;
    primary.matchOnDescription = true;
    primary.canSelectMany = false;
    listen(primary, resolve);
  });
  return action === 'import' ? chooseSourceImportAction(createQuickPick) : action;
}

export function chooseSourceImportAction(
  createQuickPick: () => vscode.QuickPick<SourceIntakeQuickPickItem>,
): Promise<SourceIntakeAction | undefined> {
  return new Promise((resolve) => {
    const target = createQuickPick();
    target.title = 'Import sources';
    target.placeholder = 'Choose files, a folder, or connect a local agent';
    target.items = IMPORT_TARGETS;
    target.matchOnDescription = true;
    target.canSelectMany = false;
    listen(target, (action) => resolve(action === 'import' ? undefined : action));
  });
}

function listen(
  quickPick: vscode.QuickPick<SourceIntakeQuickPickItem>,
  onChoice: (action: SourceIntakeQuickPickItem['action'] | undefined) => void,
): void {
  let complete = false;
  const finish = (action: SourceIntakeQuickPickItem['action'] | undefined): void => {
    if (complete) return;
    complete = true;
    accepted.dispose();
    hidden.dispose();
    quickPick.dispose();
    onChoice(action);
  };
  const accepted = quickPick.onDidAccept(() => finish(quickPick.selectedItems[0]?.action));
  const hidden = quickPick.onDidHide(() => finish(undefined));
  quickPick.show();
}
