export type QueryStudioShortcut = 'close' | 'run' | undefined;

export interface QueryStudioKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly insideStudio: boolean;
}

export function queryStudioShortcut(event: QueryStudioKeyEvent): QueryStudioShortcut {
  if (!event.insideStudio || event.isComposing) return undefined;
  if (event.key === 'Escape') return 'close';
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) return 'run';
  return undefined;
}
