/** Protocol request channels shared by independent workspace features. */
export type RequestKind = 'ready' | 'rows' | 'problems' | 'detail' | 'schema' | 'insights' | 'profile' | 'follow' | 'order' | 'rebuild' | 'graph' | 'graphReveal' | 'lineage';
export interface RequestState { id: string; kind: RequestKind }
