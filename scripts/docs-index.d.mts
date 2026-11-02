export interface DocumentationEntry {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly owner: string;
  readonly tags: readonly string[];
  readonly evidence: readonly string[];
  readonly revisit: string;
  readonly rollback: string;
  readonly 'x-priority'?: string;
  readonly 'x-freshness'?: string;
  readonly 'x-review-cadence'?: string;
  readonly 'x-last-reviewed'?: string;
  readonly 'x-supersedes'?: string;
  readonly 'x-superseded-by'?: string;
  readonly summary: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DocumentationIndex {
  readonly schema: 'jsonlview.documentation-index';
  readonly version: 1;
  readonly generated: true;
  readonly documents: readonly DocumentationEntry[];
}

export interface LoadedDocumentationIndex {
  readonly root: string;
  readonly indexPath: string;
  readonly index: DocumentationIndex;
}

export interface DocumentationFilters {
  readonly kind?: string;
  readonly status?: string;
  readonly tag?: string;
  readonly owner?: string;
}

export interface DocumentationSource extends DocumentationEntry {
  readonly metadata: Record<string, string | readonly string[]>;
  readonly body: string;
}

export interface DocumentationSummary {
  readonly schema: 'jsonlview.documentation-index';
  readonly version: 1;
  readonly documents: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byTag: Readonly<Record<string, number>>;
  readonly items: readonly Pick<DocumentationEntry, 'id' | 'title' | 'kind' | 'status' | 'summary'>[];
}

export function loadIndex(root?: string): Promise<LoadedDocumentationIndex>;
export function listDocuments(index: DocumentationIndex, options?: DocumentationFilters): DocumentationEntry[];
export function searchDocuments(index: DocumentationIndex, query: string, options?: DocumentationFilters): DocumentationEntry[];
export function readDocument(loaded: LoadedDocumentationIndex, id: string): Promise<DocumentationSource>;
export function summarizeIndex(index: DocumentationIndex): DocumentationSummary;
