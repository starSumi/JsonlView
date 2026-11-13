import type { CollectionEntryReference, CollectionReferenceIdentity, CollectionsMutationCommand, CollectionsMutationReceipt, CollectionsPage, CollectionsPageRequest, UserCollection } from './collections-model';

/** Product-owned organization metadata. Implementations never access provider sources. */
export interface CollectionsPort {
  listCollections(request?: CollectionsPageRequest): CollectionsPage<UserCollection>;
  listEntries(collectionId: string, request?: CollectionsPageRequest): CollectionsPage<CollectionEntryReference>;
  /** Returns archived session identities from active collection memberships among the supplied page candidates. */
  listArchivedSessionReferences(identities: readonly CollectionReferenceIdentity[]): readonly CollectionReferenceIdentity[];
  createCollection(displayName: string, expectedRevision: string): UserCollection;
  renameCollection(collectionId: string, displayName: string, expectedRevision: string): UserCollection;
  deleteCollection(collectionId: string, expectedRevision: string): boolean;
  addEntry(collectionId: string, identity: CollectionReferenceIdentity, expectedRevision: string): CollectionEntryReference;
  removeEntry(collectionId: string, entryId: string, expectedRevision: string): boolean;
  /** Reject known invalid/stale input before accepting a durable pending command. */
  validateMutation(command: CollectionsMutationCommand): void;
  /** Shared durable acceptance journal; transactions are separate from metadata effects. */
  listPendingMutations(): readonly CollectionsMutationCommand[];
  acceptPendingMutation(command: CollectionsMutationCommand): void;
  completePendingMutation(command: CollectionsMutationCommand): void;
  /** Atomic import from the read-only legacy snapshot; matching receipts are skipped. */
  importLegacyMutations(commands: readonly CollectionsMutationCommand[]): void;
  /** Guard runs synchronously after replay/CAS checks and before a new metadata effect. */
  applyMutation(command: CollectionsMutationCommand, beforeApply?: () => void): CollectionsMutationReceipt;
  close(): void;
}
