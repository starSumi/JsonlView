export interface DocumentIndex {
  schema: 'jsonlview.documentation-index';
  version: 1;
  generated: true;
  documents: Array<Record<string, unknown>>;
}

export function buildIndex(root: string): Promise<DocumentIndex>;
export function stableJson(value: unknown): string;
