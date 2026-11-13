import * as vscode from 'vscode';
import type { CollectionsTreeNode } from './collections-tree-provider';
import { parseSessionReferenceDragPayload, SESSION_NAVIGATOR_TREE_MIME, SESSION_REFERENCE_DND_LIMIT, SESSION_REFERENCE_MIME, type SessionReferenceDragItem } from './session-reference-dnd';
import type { SessionNavigatorTreeNode } from './tree-provider';

type NavigatorDragNode = SessionNavigatorTreeNode | CollectionsTreeNode;

export interface SessionNavigatorDragAndDropHost {
  readonly isDisposed: () => boolean;
  readonly dragItemForNode: (node: NavigatorDragNode) => SessionReferenceDragItem | undefined;
  readonly isSessionTarget: (target: SessionNavigatorTreeNode | undefined) => boolean;
  readonly resolveDraggedSession: (reference: SessionReferenceDragItem) => SessionNavigatorTreeNode | undefined;
  readonly revealSession: (entity: SessionNavigatorTreeNode) => Promise<unknown>;
  readonly dropCollection: (target: CollectionsTreeNode, transfer: vscode.DataTransfer, token: vscode.CancellationToken) => Promise<void>;
}

/** Builds tree-specific controllers so an undefined target keeps its owning tree's root semantics. */
export function createSessionNavigatorDragAndDropControllers(host: SessionNavigatorDragAndDropHost): {
  readonly sessions: vscode.TreeDragAndDropController<SessionNavigatorTreeNode>;
  readonly collections: vscode.TreeDragAndDropController<CollectionsTreeNode>;
} {
  const create = (targetTree: 'sessions' | 'collections'): vscode.TreeDragAndDropController<NavigatorDragNode> => ({
    dropMimeTypes: [SESSION_REFERENCE_MIME, SESSION_NAVIGATOR_TREE_MIME],
    dragMimeTypes: [SESSION_REFERENCE_MIME],
    handleDrag: (source, transfer, token) => drag(source, transfer, token, host),
    handleDrop: async (target, transfer, token) => {
      const hasSessionReferences = transfer.get(SESSION_REFERENCE_MIME) !== undefined
        || transfer.get(SESSION_NAVIGATOR_TREE_MIME) !== undefined;
      if (hasSessionReferences) {
        if (targetTree === 'collections') {
          if (target !== undefined && 'kind' in target && target.kind === 'collection') await host.dropCollection(target, transfer, token);
        } else if (target === undefined || 'nodeKind' in target) {
          await dropOnSessions(target, transfer, token, host);
        }
        return;
      }
    },
  });

  return {
    sessions: create('sessions') as vscode.TreeDragAndDropController<SessionNavigatorTreeNode>,
    collections: create('collections') as vscode.TreeDragAndDropController<CollectionsTreeNode>,
  };
}

function drag(source: readonly NavigatorDragNode[], transfer: vscode.DataTransfer, token: vscode.CancellationToken, host: SessionNavigatorDragAndDropHost): void {
  if (token.isCancellationRequested || host.isDisposed() || source.length === 0 || source.length > SESSION_REFERENCE_DND_LIMIT) return;
  const references = new Map<string, SessionReferenceDragItem>();
  for (const node of source) {
    const reference = host.dragItemForNode(node);
    if (reference === undefined) return;
    references.set(JSON.stringify([reference.providerId, reference.sourceId, reference.nativeId, reference.generation]), reference);
  }
  if (token.isCancellationRequested || references.size === 0 || references.size > SESSION_REFERENCE_DND_LIMIT) return;
  transfer.set(SESSION_REFERENCE_MIME, new vscode.DataTransferItem(JSON.stringify({ version: 1, references: [...references.values()] })));
}

async function dropOnSessions(target: SessionNavigatorTreeNode | undefined, transfer: vscode.DataTransfer, token: vscode.CancellationToken, host: SessionNavigatorDragAndDropHost): Promise<void> {
  if (token.isCancellationRequested || host.isDisposed() || !host.isSessionTarget(target)) return;
  const item = transfer.get(SESSION_REFERENCE_MIME) ?? transfer.get(SESSION_NAVIGATOR_TREE_MIME);
  if (item === undefined) return;
  let text: string;
  try { text = await item.asString(); }
  catch {
    if (!token.isCancellationRequested && !host.isDisposed()) void vscode.window.showWarningMessage('Session Navigator: the session reference drop could not be read.');
    return;
  }
  if (token.isCancellationRequested || host.isDisposed() || !host.isSessionTarget(target)) return;
  const payload = parseSessionReferenceDragPayload(text);
  if (payload === undefined) {
    void vscode.window.showWarningMessage('Session Navigator: the session reference drop is invalid or exceeds its limit.');
    return;
  }
  let unavailable = 0;
  for (const reference of payload.references.slice(0, SESSION_REFERENCE_DND_LIMIT)) {
    if (token.isCancellationRequested || host.isDisposed() || !host.isSessionTarget(target)) break;
    const entity = host.resolveDraggedSession(reference);
    if (entity === undefined) {
      unavailable++;
      continue;
    }
    try { await host.revealSession(entity); }
    catch { unavailable++; }
    if (token.isCancellationRequested || host.isDisposed()) break;
  }
  if (unavailable > 0) void vscode.window.showWarningMessage(`${String(unavailable)} session reference(s) were stale or no longer authorized and were skipped.`);
}
