import type { SourceRefreshKind } from '../engine';

export function shouldAutoFollow(kind: SourceRefreshKind): boolean {
  return kind === 'append';
}
