export type QueryStudioShortcut = 'close' | 'cancel' | 'run' | undefined;

export interface QueryStudioKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly insideStudio: boolean;
  readonly pending?: boolean;
  readonly disabled?: boolean;
}

export function queryStudioShortcut(event: QueryStudioKeyEvent): QueryStudioShortcut {
  if (!event.insideStudio || event.isComposing) return undefined;
  if (event.key === 'Escape') return event.pending ? 'cancel' : 'close';
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.pending && !event.disabled) return 'run';
  return undefined;
}
