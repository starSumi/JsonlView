import type { CatalogProviderId } from '@application/catalog/catalog-model';

export interface UserCollection {
  readonly collectionId: string;
  readonly displayName: string;
  readonly entryCount: number;
}

/** Exact, source-qualified session identity. It deliberately contains no path or content. */
export interface CollectionEntryReference {
  readonly entryId: string;
  readonly collectionId: string;
  readonly providerId: CatalogProviderId;
  readonly sourceId: string;
  readonly nativeId: string;
  readonly referenceKind: 'session' | 'file' | 'source';
  readonly displayAlias?: string;
  readonly localArchivedAtMs?: number;
}

export type CollectionReferenceIdentity = Pick<CollectionEntryReference, 'providerId' | 'sourceId' | 'nativeId' | 'referenceKind'>;

export interface CollectionsPageRequest { readonly limit?: number; readonly cursor?: string }
export interface CollectionsPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
  readonly metadataRevision: string;
}
export type CollectionsErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'SNAPSHOT_CHANGED' | 'STORE_BUSY' | 'METADATA_UNAVAILABLE' | 'MUTATION_CONFLICT' | 'RECEIPT_CAPACITY' | 'IDENTITY_CONFLICT' | 'SOURCE_UNAVAILABLE';
export class CollectionsError extends Error {
  public readonly code: CollectionsErrorCode;
  public constructor(code: CollectionsErrorCode) { super(code); this.code = code; this.name = 'CollectionsError'; }
}

export type CollectionsMutation =
  | { readonly action: 'createCollection'; readonly payload: { readonly displayName: string } }
  | { readonly action: 'renameCollection'; readonly payload: { readonly collectionId: string; readonly displayName: string } }
  | { readonly action: 'deleteCollection'; readonly payload: { readonly collectionId: string } }
  | { readonly action: 'addEntry'; readonly payload: { readonly collectionId: string; readonly identity: CollectionReferenceIdentity } }
  | { readonly action: 'removeEntry'; readonly payload: { readonly collectionId: string; readonly entryId: string } }
  | { readonly action: 'setAlias'; readonly payload: { readonly entryId: string; readonly displayAlias: string | null } }
  | { readonly action: 'setLocalArchive'; readonly payload: { readonly entryId: string; readonly archivedAtMs: number | null } }
  | { readonly action: 'rebindEntry'; readonly payload: { readonly entryId: string; readonly identity: CollectionReferenceIdentity } };
export type CollectionsMutationCommand = CollectionsMutation & {
  readonly requestId: string;
  readonly expectedRevision: string;
};
export interface CollectionsMutationReceipt {
  readonly requestId: string;
  readonly operation: CollectionsMutation['action'];
  readonly commandHash: string;
  readonly previousRevision: string;
  readonly metadataRevision: string;
  readonly changed: boolean;
  readonly result: UserCollection | CollectionEntryReference | boolean;
}
