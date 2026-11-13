import * as vscode from 'vscode';
import { SOURCE_INTAKE_MAX_SOURCES } from './source-intake-limits';

/** Bound and validate a whole file-picker selection before any authorization UI is shown. */
export async function validateSourceSelection(
  selection: readonly vscode.Uri[],
  validate: (value: string) => Promise<vscode.Uri>,
  cancelled: () => boolean = () => false,
): Promise<readonly vscode.Uri[] | undefined> {
  if (selection.length > SOURCE_INTAKE_MAX_SOURCES) {
    throw new Error(`Choose up to ${String(SOURCE_INTAKE_MAX_SOURCES)} sources at a time.`);
  }

  const unique = new Map<string, vscode.Uri>();
  for (const uri of selection) unique.set(uri.toString(), uri);
  const canonical: vscode.Uri[] = [];
  for (const uri of unique.values()) {
    if (cancelled()) return undefined;
    canonical.push(await validate(uri.toString()));
  }
  return cancelled() ? undefined : canonical;
}
