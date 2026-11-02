---
id: "navigator-collections-contracts"
path: "docs/designs/navigator-collections-contracts.md"
title: "Navigator Collections Domain Types and Store API"
kind: "design"
status: "proposed"
owner: "product"
tags: ["application-contract", "collections", "store-api", "types"]
evidence: ["product-revision:14f7bfcd75edf25232c932da0dddf58a3682896f"]
revisit: "before implementation and when provider identity or persistence contracts change"
rollback: "withdraw the proposal and retain the source-preserving metadata boundary"
x-priority: "P1"
x-freshness: "current"
x-review-cadence: "before implementation and at each contract change"
x-last-reviewed: "2026-11-01"
---
## 2. Domain types (proposed)

These declarations are proposed contract shapes, not shipped types. Public
interfaces in this contract use the `I...` prefix; existing catalog interfaces
retain their established names. The provider remains authoritative. A native
archived row does not need a durable metadata anchor merely to appear in a
read-only list.

```ts
export type ReferenceKind = 'session' | 'file' | 'source';
export type ProviderArchiveObservation = 'active' | 'archived' | 'not-applicable' | 'unknown';
export type ItemDisplayState = 'unfiled' | 'filed' | 'archived' | 'unavailable';
export type EntryResolution = 'resolved' | 'authorization-required' | 'coverage-pending' | 'missing' | 'identity-conflict' | 'unsupported';
export type EntryTarget = { entryId: string } | { targetToken: string };

export interface ICollection {
  collectionId: string;
  displayName: string;
  rowRevision: string;
}
export interface IEntryProjection {
  referenceKind: ReferenceKind;
  displayAlias: string | null; // null whenever authorization is absent
  resolvedDisplayName?: string; // omitted whenever authorization is absent
  resolution: EntryResolution;
  providerObservedArchived: ProviderArchiveObservation;
  displayState: ItemDisplayState;
}
export interface IDurableCollectionEntry extends IEntryProjection {
  kind: 'durable';
  entryId: string;
  localArchiveIntent: boolean;
  membershipCount: string;
  rowRevision: string;
}
export interface INativeObservedEntry extends IEntryProjection {
  kind: 'native-observed';
  referenceKind: 'session';
  providerObservedArchived: 'archived';
  targetToken: string;
  localArchiveIntent: false;
  membershipCount: '0';
}
export type CollectionEntry = IDurableCollectionEntry | INativeObservedEntry;

// Infrastructure-only. Never serialize identity/path data to list/Webview DTOs.
export interface IQualifiedReferenceIdentity {
  providerId: string;
  sourceId: string;
  nativeId: string;
  referenceKind: ReferenceKind;
  identityQuality: 'provider-stable' | 'location-bound';
}
export interface ICollectionPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  metadataRevision: string;
  authorizationEpoch: string;
  catalogEpoch: string;
  providerStatusEpoch: string;
  coverage: 'complete' | 'partial' | 'unknown';
  coverageNotice?: 'identity-pending' | 'provider-status-pending' | 'provider-status-conflict';
  count: { known: string; exact: boolean };
}
export interface ICollectionMutationResult<T> {
  value: T;
  metadataRevision: string;
  changed: boolean;
  replayed: boolean;
  invalidation: 'metadata' | 'none';
}
```

A native-observed row can Open through the current safety chain, or File into,
Alias, or Archive locally using its current `targetToken`; those mutations
establish the durable anchor exactly once. Move/Unfile require an actual
membership and are absent for a native-only row. Local Restore is absent if no
local intent exists. Provider-native Restore is not a local metadata command.

An adapter without native-archive capability reports `not-applicable`, which
contributes false to effective archive; it does not make Claude/Pi/generic items
unavailable. `unknown` means a normally supported status cannot currently be
established under authorization/coverage, not lack of provider capability. Only
`archived` contributes true; local intent is independent, while authorization
always controls data redaction.

The pinned Codex adapter currently selects `threads.archived` only when that
column exists, then maps every value other than integer `1` to `available`.
That behavior does not satisfy this contract for schemas with no archive column,
NULL values, or unrecognized values. Before this contract is implemented, the
Codex observation must become tri-state: only a recognized active value is
`active`, only a recognized archived value is `archived`, and absent or
unrecognized evidence is `unknown`. Until then, collection composition must not
use that adapter result to claim an item is unarchived or place it in Unfiled.

## 3. Store API and application command ports

The application read port composes provider observations with stored metadata.
The store reads/writes only its metadata database: its raw page has no provider
archive status, resolved title, authorization decision, or permission to open.
The trusted synchronous guard carries verified target identity and rechecks
epochs before the effect; it cannot perform provider I/O in a transaction.
Classes may `implements` these interfaces; no class is introduced here.

```ts
export interface ICommandContext {
  contractVersion: 1;
  requestId: string;
  lifecycleEpoch: string;
}
export interface IMutationContext extends ICommandContext { expectedRevision: string; }
export interface IReadContext extends ICommandContext { atRevision?: string; limit: number; cursor?: string; }
export interface ICommandError { requestId: string; code: string; retryable: boolean; currentRevision?: string; }
export interface ICommandSuccess<T> { requestId: string; authorizationEpoch: string; catalogEpoch: string; providerStatusEpoch: string; result: T; }
export interface ICreateCollectionRequest extends IMutationContext { displayName: string; }
export interface IUpdateCollectionRequest extends IMutationContext { collectionId: string; displayName: string; }
export interface IDeleteCollectionRequest extends IMutationContext { collectionId: string; }
export interface IListCollectionsRequest extends IReadContext { search?: string; entryId?: string; }
export interface IListEntriesRequest extends IReadContext { scope: { kind: 'collection'; collectionId: string } | { kind: 'filed' } | { kind: 'archived' }; search?: string; }
export interface ISetEntryAliasRequest extends IMutationContext { target: EntryTarget; displayAlias: string | null; }
export interface IFileIntoCollectionRequest extends IMutationContext { collectionId: string; target: EntryTarget; }
export interface IUnfileEntryRequest extends IMutationContext { collectionId: string; entryId: string; }
export interface IMoveEntryRequest extends IMutationContext { entryId: string; fromCollectionId: string; toCollectionId: string; }
export interface IRebindEntryRequest extends IMutationContext { entryId: string; targetToken: string; }
export interface ISetLocalArchiveIntentRequest extends IMutationContext { target: EntryTarget; archived: boolean; }
export interface IResetEntryMetadataRequest extends IMutationContext { entryId: string; clearAlias: boolean; clearMemberships: boolean; clearLocalArchiveIntent: boolean; }
export interface IEntryMetadataResult { entryId: string; rowRevision: string; }
export interface IDeleteCollectionResult { deletedCollectionId: string; removedLinkCount: string; }
export interface IFileIntoResult { entryId: string; collectionId: string; linked: boolean; }
export interface IUnfileResult { unlinked: boolean; remainingMembershipCount: string; }
export interface IMoveEntryResult { entryId: string; fromCollectionId: string; toCollectionId: string; remainingMembershipCount: string; }
export interface IRebindEntryResult { entryId: string; resolution: 'pending'; }
export interface ISetLocalArchiveIntentResult { entryId: string; localIntent: boolean; providerMutation: 'none'; }
export interface IResetEntryMetadataResult { entryId: string; remainingMembershipCount: string; localIntent: boolean; providerMutation: 'none'; }

export interface IStoreEffectGuard {
  resolvedTarget?: IQualifiedReferenceIdentity;
  assertCurrentAndNotCancelled(): void;
}
export interface IStoredEntry {
  entryId: string;
  identity: IQualifiedReferenceIdentity;
  displayAlias: string | null;
  localArchiveIntent: boolean;
  membershipCount: string;
  rowRevision: string;
}
export interface IStoredMetadataPage<T> { items: readonly T[]; nextKey: string | null; metadataRevision: string; }
export interface IStoreEntryPageRequest { scope: { kind: 'collection'; collectionId: string } | { kind: 'filed' } | { kind: 'local-archive' }; limit: number; afterKey?: string; atRevision?: string; }
export interface INavigatorCollectionsStore {
  createCollection(r: ICreateCollectionRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<ICollection>>;
  updateCollection(r: IUpdateCollectionRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<ICollection>>;
  deleteCollection(r: IDeleteCollectionRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IDeleteCollectionResult>>;
  setEntryAlias(r: ISetEntryAliasRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IEntryMetadataResult>>;
  fileIntoCollection(r: IFileIntoCollectionRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IFileIntoResult>>;
  unfileEntry(r: IUnfileEntryRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IUnfileResult>>;
  moveEntry(r: IMoveEntryRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IMoveEntryResult>>;
  rebindEntry(r: IRebindEntryRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IRebindEntryResult>>;
  setLocalArchiveIntent(r: ISetLocalArchiveIntentRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<ISetLocalArchiveIntentResult>>;
  resetEntryMetadata(r: IResetEntryMetadataRequest, g: IStoreEffectGuard): Promise<ICollectionMutationResult<IResetEntryMetadataResult>>;
  listCollections(r: IListCollectionsRequest): Promise<IStoredMetadataPage<ICollection>>;
  listMetadataEntries(r: IStoreEntryPageRequest): Promise<IStoredMetadataPage<IStoredEntry>>;
}
export interface INavigatorCollectionsPort {
  createCollection(r: ICreateCollectionRequest): Promise<ICollectionMutationResult<ICollection>>;
  updateCollection(r: IUpdateCollectionRequest): Promise<ICollectionMutationResult<ICollection>>;
  deleteCollection(r: IDeleteCollectionRequest): Promise<ICollectionMutationResult<IDeleteCollectionResult>>;
  setEntryAlias(r: ISetEntryAliasRequest): Promise<ICollectionMutationResult<IEntryMetadataResult>>;
  fileIntoCollection(r: IFileIntoCollectionRequest): Promise<ICollectionMutationResult<IFileIntoResult>>;
  unfileEntry(r: IUnfileEntryRequest): Promise<ICollectionMutationResult<IUnfileResult>>;
  moveEntry(r: IMoveEntryRequest): Promise<ICollectionMutationResult<IMoveEntryResult>>;
  rebindEntry(r: IRebindEntryRequest): Promise<ICollectionMutationResult<IRebindEntryResult>>;
  setLocalArchiveIntent(r: ISetLocalArchiveIntentRequest): Promise<ICollectionMutationResult<ISetLocalArchiveIntentResult>>;
  resetEntryMetadata(r: IResetEntryMetadataRequest): Promise<ICollectionMutationResult<IResetEntryMetadataResult>>;
  listCollections(r: IListCollectionsRequest): Promise<ICollectionPage<ICollection>>;
  listEntries(r: IListEntriesRequest): Promise<ICollectionPage<CollectionEntry>>;
}
```

Store page keys are host-internal metadata scan continuations. They are never
public cursors: composition applies current authorization/provider archive
filters **before** the public page/keyset/count, within bounded query ownership.
It must not take one store page and hide disallowed rows afterward. Provider-only
archived items come from the existing native catalog without creating metadata.
### Application port and transport mapping

Proposed `INavigatorCollectionsPort` sits alongside the existing catalog ports;
it imports no VS Code API, Webview implementation, or provider-private database.
It owns bounded DTO requests/results, not authorization policy or raw source
reads. Infrastructure implements persistence; the host validates user gestures,
trust and source authorization, then calls the same application methods from
native commands and the upper Webview. These are local application calls,
**not REST endpoints**. No MCP/ACP mutation exposure is included.

Proposed native command families are
`jsonlView.sessionNavigator.collections.{create,update,delete,list,listEntries,alias,fileInto,unfile,move,rebind,resetEntryMetadata}`
and `jsonlView.sessionNavigator.archive.setLocalIntent`.
These names are additions requiring normal command registration in a future
implementation. Existing add/authorize/remove-source, preview, reveal, sort,
and load-more commands keep their current behavior. The upper intake's bounded
exact decoder gets a separate versioned collection request/response discriminant
delegating to the same methods. `OPEN_SESSION_NAVIGATOR` remains a handoff and
must not be overloaded as CRUD. Future wire additions belong to `src/shared/`
and must be validated before dispatch; this proposal adds no runtime messages.

All IDs below are opaque DTO IDs. `targetToken` is a bounded, host-issued
reference to a current authorized catalog/file selection. It binds reference
kind, the exact `(providerId, sourceId, nativeId)` identity, authorization
epoch, current generation where relevant, and host lifecycle. It is not a
caller-supplied URI. Expiry or source change requires fresh selection; the
token is not stored as membership. A token authorizes only its selected source;
matching native IDs in other source registrations neither resolve this token
nor transfer authorization. The Store rechecks the source-qualified uniqueness
match.

The transport envelope is `{ contractVersion: 1, requestId, lifecycleEpoch, args }`;
the host flattens validated `args` into the typed local call above.
Mutations also require `expectedRevision` (decimal string). Reads can include
`atRevision` to continue a known projection; absent means start at current.
The global optimistic revision intentionally makes unrelated concurrent edits
conflict in v1; it is simpler than a new per-field merge mechanism.

Public entry DTOs contain a decimal membership count, never an unbounded array
of linked IDs. To view relationships, page `listCollections({ entryId, ... })`.
Every changed mutation invalidates metadata scope at its shared revision, rather
than materializing all affected entries/collections in a receipt or IPC packet.
Delete/reset remain bounded in returned data even when SQL affects many links;
they are one writer transaction and must be benchmarked for lock time before
runtime acceptance. V1 does not invent a silent membership cardinality limit.

Transport success wraps the typed local result as `{ requestId,
authorizationEpoch, catalogEpoch, providerStatusEpoch, result }`. The result
contains `metadataRevision`; mutations additionally return `changed`, `replayed`,
a bounded `invalidation:'metadata'|'none'` scope. Revisions/counters that may
exceed JavaScript safe integers cross IPC as canonical decimal strings.
An error is `{ requestId, code, retryable, currentRevision? }`, with no raw
exception/path. On error no mutation or successful visibility change is implied.

| Method and args | Result / precise effect | Additional guards and errors |
| --- | --- | --- |
| `createCollection({ displayName })` | Mutation `value: ICollection`; create UUID collection. | Metadata write capability; `INVALID_ARGUMENT`, `REVISION_CONFLICT`. Duplicate names allowed. |
| `updateCollection({ collectionId, displayName })` | Mutation `value: ICollection`; rename this container only. | Existing metadata object; `NOT_FOUND`. Does not rename sources or remove memberships. |
| `deleteCollection({ collectionId })` | `{ deletedCollectionId, removedLinkCount }`; cascade that collection's links only. | `NOT_FOUND` for a new request against absent ID. Replay of its original request returns its committed receipt. No source authorization needed to discard owned metadata. |
| `listCollections({ search?, entryId?, limit, cursor? })` | `ICollectionPage<ICollection>`; bounded names and collection-scope count; optional entryId returns only that entry's collections with the same keyset/cursor. | Metadata read capability; current authorization redaction. Read-only, no revision advance. |
| `listEntries({ scope: { kind: 'collection', collectionId } | { kind: 'filed' } | { kind: 'archived' }, search?, limit, cursor? })` | `ICollectionPage<CollectionEntry>`; unarchived collection links / filed union, or archived items with preserved membership counts and paged relationship lookup. The application read port composes authorized native archived rows with local intent rows; native-only items need no durable bridge until a metadata mutation. | `NOT_FOUND` for absent collection; current native archive status is visible only under effective authorization. Native-only rows carry a current opaque target token, not an invented persistent entry ID. Search never matches hidden source text. |
| `setEntryAlias({ target: { entryId } | { targetToken }, displayAlias: string|null })` | `{ entryId, rowRevision }`; rename/reset our display overlay only; applies wherever this durable entry is shown. A fresh authorized target can create entry/ref without a membership and stays Unfiled. | Owned entry or authorized current target; `NOT_FOUND`, `TARGET_STALE`, `AUTHORIZATION_REQUIRED`. No underlying filename or vendor title write. Alias is redacted when the target is unauthorized. |
| `fileIntoCollection({ collectionId, target: { entryId } | { targetToken } })` | `{ entryId, collectionId, linked }`; resolve or create entry/ref and add exact membership. Existing same pair succeeds with `linked:false`. | Creating a reference requires current source authorization and identity verification. Relinking an already owned restricted entry may alter metadata only and reveals no target details. `TARGET_STALE`, `AUTHORIZATION_REQUIRED`, `IDENTITY_CONFLICT`, `NOT_FOUND`, `TEMPORARY_SOURCE`. |
| `unfileEntry({ collectionId, entryId })` | `{ unlinked, remainingMembershipCount }`; absent pair is a successful no-op if both objects exist. Last unlink makes an eligible lower item Unfiled. | Metadata write capability; no source access required. `NOT_FOUND` for absent entry/collection. |
| `moveEntry({ entryId, fromCollectionId, toCollectionId })` | `{ entryId, fromCollectionId, toCollectionId, remainingMembershipCount }`; add destination if needed and remove exactly the source link in one transaction. Other links remain. | Both collections and the source link must exist; `NOT_FOUND`/`MEMBERSHIP_NOT_FOUND`. Same collection is a successful no-op. Concurrent destination deletion fails atomically. |
| `rebindEntry({ entryId, targetToken })` | `{ entryId, resolution:'pending' }`; replace current qualified reference, preserving entry, alias, local intent and links. Re-resolve before opening/analysis. | Explicit recovery gesture plus fresh authorization/verification; `TARGET_STALE`, `AUTHORIZATION_REQUIRED`, `TARGET_ALREADY_REFERENCED`, `IDENTITY_CONFLICT`. With a local archive intent the target must remain a session. A target owned by another entry is not silently merged. |
| `setLocalArchiveIntent({ target: { entryId } | { targetToken }, archived: boolean })` | `{ entryId, localIntent: boolean, providerMutation:'none' }`; insert/delete one owned intent, preserving all memberships and aliases. A fresh target creates only the identity bridge/intent. | Archive intent is supported for sessions only. Entry-ID updates need metadata write capability but no source read. New targets need current session authorization. The result never claims effective archive state or provider modification. |
| `resetEntryMetadata({ entryId, clearAlias, clearMemberships, clearLocalArchiveIntent })` | `{ entryId, remainingMembershipCount, localIntent, providerMutation:'none' }`; at least one flag must be true; clear only those owned values in one transaction. Preserve identity bridge and all sources. | Metadata write capability; `NOT_FOUND`, `REVISION_CONFLICT`. Does not clear provider-native archive. A local-intent-only reset preserves placement; clearing all memberships restores lower only when effective archive is false. Global/source/collection bulk reset is queued, not implied. |
| Existing `getChildrenPage` with proposed `{ projection:'unfiled'|'all-active'|'archived', ...existingQuery }` | Existing bounded native page plus common revision identity and exact/partial counts. Default `unfiled`; `all-active` includes filed but not effectively archived items; `archived` returns only provider-observed or locally intended archived items. | Current source authorization, generation/parent/sort/lifecycle guards retained. Filing/local-intent predicates and provider-status filter run before sorting/limit; `CURSOR_*`, `SNAPSHOT_CHANGED`. Does not rewrite provider parent relations. |

The command names and DTOs are contract proposals, not advertised callable
commands. All methods share the error/transaction/pagination rules below.
The initial collection/file link never silently saves a temporary preview:
return `TEMPORARY_SOURCE` and route the user through existing explicit Save As,
registration and readback before a fresh link request.

Search has an explicit scope: `{ kind:'lower', projection:'unfiled'|'all-active'|'archived',
sourceIds? }` or `{ kind:'collection', collectionId }` or `{ kind:'filed' }` or
`{ kind:'archived' }`.
The text is at most 256 Unicode characters/1024 UTF-8 bytes, parameter-bound,
and searches current authorized catalog/display metadata plus permitted owned
names. It is not arbitrary SQL or a new content-query grammar. Lower search
retains existing catalog filter/sort semantics. Collection source/folder
references do not expand a search into unobserved or unauthorized children.
Analysis/content-query expansion uses the existing analysis owner and requires
its own current bounded scope; Markdown parsing and new analysis adapters are
queued. Clearing a search does not change any membership or selection.
