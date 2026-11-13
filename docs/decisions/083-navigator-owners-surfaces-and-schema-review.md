---
id: "083-navigator-owners-surfaces-and-schema-review"
path: "docs/decisions/083-navigator-owners-surfaces-and-schema-review.md"
title: "Navigator Owners, Surfaces and Schema Review"
kind: "decision"
status: "accepted"
owner: "product"
tags: ["architecture", "session-navigator", "collections", "persistence"]
evidence: ["source:package.json", "source:src/experimental/session-navigator/tree-provider.ts", "source:src/infrastructure/navigator/catalog-store.ts", "source:src/infrastructure/navigator/collections-schema.ts", "source:test/experimental/session-navigator-manifest.test.ts"]
revisit: "when a concrete feature requires another owner, view, command or metadata shape"
rollback: "revert this review record and its index entries; runtime and stored metadata are unaffected"
---
# ADR-083: Navigator Owners, Surfaces and Schema Review

## Pressure, probe and decision

The Navigator proposals use Add Source, Collections and Agent Sessions as three
product concepts. Their implementation already spans application ports, host
adapters and private persistence owners. Treating the proposals as a fresh
architecture would duplicate working boundaries and confuse database versions
with snapshot formats.

This review inspected the manifest, imports, DDL, command registrations and
existing tests at `ed1287f31f7a9b4410958b4ed23e4e2875f9461a` on
2026-11-11. It accepts the existing architecture. It records the owner matrix,
actual UI contract and schema baseline for the architecture and Collections
review tasks A-01, A-03, C-01 and C-02. This is a C0 documentation change about
existing cross-owner boundaries; it introduces no runtime, migration or
acceptance claim.

The four planes in [ADR-051](051-v2-plane-boundaries-and-engineering-gates.md)
remain authoritative. Add Source owns explicit intake and temporary previews;
Collections owns mutable product reference metadata; Agent Sessions projects
authorized source facts. Source bytes remain authoritative. A reference or
collection membership cannot authorize a source, start a provider scan or
rewrite provider content. The default-off archive projection in
[ADR-082](082-collection-archive-visibility.md) is the accepted, explicit
exception to the earlier lower-view visibility rule; its marker remains
Collections metadata.

## Owner and contract matrix

| Concern | Current owner and source | Boundary retained |
| --- | --- | --- |
| VS Code lifecycle, commands, source/document open and host delivery | `src/extension/extension.ts`; Navigator composition in `src/experimental/session-navigator/tree-provider.ts` | The host selects adapters, rechecks authorization and generation, owns cancellation and transports bounded messages. UI code cannot grant access by constructing a reference. |
| Catalog model, identity, pages and mutations | `src/application/catalog/catalog-model.ts`, `catalog-identity.ts`, `catalog-port.ts` | `SessionCatalogPort` is the application seam. Provider adapters supply bounded snapshots; native UI consumes the port rather than owning SQLite DDL. |
| Catalog SQLite persistence | `src/infrastructure/navigator/catalog-store.ts` | `CatalogStore` owns its configured database, SQL, metadata reconciliation and generation/cursor/fingerprint guards. Product title overlays do not edit provider files. |
| Versioned Catalog snapshot serialization | `src/application/catalog/migrations.ts`, `catalog-persistence.ts` | ADR-062 owns the snapshot migration chain and checksum/temp/readback/rename helper. This Node file helper is distinct from Navigator SQLite DDL and is not evidence that all application code is IO-free. |
| Collections commands and identity | `src/application/collections/collections-model.ts`, `collections-port.ts` | `CollectionsPort` exposes typed reference commands, revision/CAS and receipts. Identity is provider/source/native ID plus reference kind; labels and paths cannot substitute for identity. |
| Collections SQLite and durable journal | `src/infrastructure/navigator/collections-store.ts`, `collections-schema.ts`, `collections-journal.ts` | The persistence owner validates its exact private schema and makes accepted command, effect and receipt recovery durable. Native trees do not write SQL. |
| Collections native UI and recovery coordination | `src/experimental/session-navigator/collections-tree-provider.ts`, `collections-recovery.ts` | Prompts, selection, current authorization callbacks and host retirement stay at the host boundary. Recovery replays the original command through the port; it does not silently rebase CAS. |
| Add Source and temporary preview lifecycle | `source-drop-view.ts`, `source-intake.ts`, `session-previews.ts` under `src/experimental/session-navigator/` | Explicit user actions reach existing intake/authorization. Rendering does not discover, scan, read the clipboard or authorize. Save As must physically succeed before its result is used. |
| Provider read adapters | `provider-factory.ts`, `generic-provider.ts`, `native-provider.ts`, `kimi-provider.ts` and their bounded helpers in the same directory | Probe before scanning; honor budgets, cancellation, continuation, fingerprints and generations. Provider-private storage reads do not confer ownership of the product Catalog database. |
| Cross-process contracts and reveal result | `src/shared/protocol/reveal.ts`, `navigator-bridge.ts`, `source-registration.ts`, `wire.ts` | Shared validators/versioned envelopes own transport truth. Host reveal intent is separate from the Webview's eventual DOM confirmation. |
| Physical reads, semantic projection and rendering | `src/engine/`, `src/profiles/`, `src/webview/` | Engine owns bounded physical reads/query; profiles add semantics; Webview owns bounded state/rendering. Navigator metadata does not become a second source log. |

No structural rewrite, package split, new global service, second scan listener
or relocation of residual modules is approved by this review. A later move
must preserve the observable call contracts before changing import paths.

### Subsequent implementation boundaries

The review above is pinned to its stated source revision. Later implementation
work extracted the C-03 drag/drop controller while preserving its existing
Host authorization, generation and Catalog identity checks. Both directions
carry bounded identity-only references: Sessions to Collections files a
reference; Collections to Agent Sessions invokes the existing read-only reveal
path. Neither direction writes source data or turns Collections into a scan
provider. C-06 adds an in-process Host/Webview receipt fixture for expiry and
authorization revocation; it does not claim installed VS Code host acceptance.

The separately authorized module-layout passes group extension-owned families
under `src/extension/acp/`, `raw-export/`, `reveal-text/`, `trajectory/`,
`mcp/`, `integrated-session/`, `follow/`, `observability/`, and `diagnostics/`,
alongside matching focused test folders. These remain private folders in the
current owner plane. The grouping follows shared lifecycle, policy, or change
ownership; it does not imply that every related cross-feature integration test
moves into those folders. `src/extension/extension.ts` and `src/mcp-server.ts` remain
composition roots; shared wire contracts remain in `src/shared/`, and generic
process lifecycle remains in `packages/runtime/`. The changes reorganize
imports and tests without creating package boundaries or altering protocol,
export, persistence, or UI contracts.

The flat document, Navigator, and native-MCP managers remain separate where
they own distinct authorization, persistence, or host-command boundaries.
Large-file findings from module review are tracked as decomposition work;
directory grouping alone is not evidence that file complexity has been solved.

The ACP close contract now returns bounded process-tree settlement after
synchronously rejecting pending protocol work. Replacement and deactivation
await that settlement; unresolved cleanup is reported as `unknown`. Optional
side-agent command dispatch may finish after deactivation, but cannot publish
late Output, clipboard, or UI effects. Runtime tests include SIGTERM-resistant
descendants on POSIX and process-tree cleanup evidence on Windows.

## Actual views and entry surfaces

`package.json` owns the public contribution contract. Its
`contributes.viewsContainers.activitybar` contains one Navigator container:
`jsonlViewSessionNavigator`, titled **Agent Sessions**, with `$(list-tree)`.
`contributes.views.jsonlViewSessionNavigator` orders these three views:

| Product concept | Exact view ID and implementation | User-facing responsibility |
| --- | --- | --- |
| Add Source | `jsonlView.sourceIntake`, `type: webview`; `SourceDropView` registered through `registerWebviewViewProvider` in `tree-provider.ts` | Compact Import/Paste and whole-card drop intake. The Import menu reaches files, folder and local-agent connection; multiline paste uses `SourceIntakePanel`. |
| Collections | `jsonlView.sourceDrop`; native `CollectionsTreeProvider` through `createTreeView` | User collections, reference membership, alias/local archive/rebind and metadata recovery. The historical `sourceDrop` ID is retained for compatibility. |
| Agent Sessions | `jsonlView.sessionNavigator`; native `SessionNavigatorTreeProvider` through `createTreeView` | Authorized provider catalog, bounded pages, source status, entity open/reveal and recent temporary previews. |

[ADR-076](076-source-intake-stage.md) supplements ADR-064's earlier placement:
the compact Add Source Webview already exists above the two native trees.
`SourceNavigatorTreeProvider` remains an intake/drop adapter used by the host;
it is not the Collections data provider. Recent previews are a branch of the
Agent Sessions tree. There is no separately contributed Recent Previews view.

The following abbreviations apply only to this command inventory:
`N = jsonlView.sessionNavigator` and
`C = jsonlView.sessionNavigator.collections`. The full IDs are formed by
appending the displayed suffix, for example `C.create` means
`jsonlView.sessionNavigator.collections.create`.

| Surface / manifest key | Current commands and selection contract |
| --- | --- |
| Add Source actions; `contributes.commands` | `N.addSource` opens the source picker; `N.source.files`, `N.source.folder`, `N.source.paste`, `N.authorizeAgent` and `N.source.authorizeDetected` select explicit intake/authorization paths. `source-drop-view.ts` validates its local Webview action messages before invoking host callbacks. |
| Collections title; `contributes.menus["view/title"]`, `view == jsonlView.sourceDrop` | `N.addSource` is `navigation@1`; `C.create` and `C.refresh` are `collections@1` and `collections@2`. `jsonlView.exportRawSource`, `jsonlView.exportRawRecords`, `jsonlView.recoverRawExport` are `export@1..3`. Lower Catalog refresh is not contributed here. |
| Agent Sessions title; the same menu key, `view == jsonlView.sessionNavigator` | `N.refresh` and `N.addSource` occupy `navigation@1..2` when enabled; `N.sort` is `navigation@3`. `N.enable`/`N.disable` are conditional settings entries. `N.sortActivity`, `N.sortCreated`, `N.sortTitle`, `N.authorizeAgent` and `jsonlView.diagnoseWebview` use sort/sources/help groups. |
| Collection node; `contributes.menus["view/item/context"]`, `viewItem == jsonlView.collection` | `C.rename`, `C.delete`. Deleting a collection changes product metadata, not source files. |
| Collection reference; `viewItem` values prefixed `jsonlView.collection.entry.` | `C.fileInto`, `C.unfile`, `C.rebind` are reference actions; available session/file/source references expose `C.open`, `C.alias`. An unarchived session exposes `C.archive`; archived sessions, including unavailable archived entries, expose `C.restore`. Exact `when` expressions remain manifest-owned. |
| Agent entity; `viewItem == jsonlView.sessionNavigator.entity` | `N.openEntity`, `N.openEntityWith`, `N.revealInFileExplorer`, `N.openInIntegratedTerminal`, `N.copyPath`, `N.copyRelativePath`, `N.copySessionId`, `N.openTimeline`, and `C.fileInto`. There is no provider-session delete/remove action. |
| Agent source / partial page context | Source and partial nodes expose filesystem/path actions and `C.fileInto`; `N.removeSource` applies to the source node, while `N.loadMore` applies to a partial node. Source removal updates configured access; it does not delete the provider source. |
| Recent preview context inside Agent Sessions | `jsonlView.previews.open`, `jsonlView.previews.saveAs`, `jsonlView.previews.openSavedCopy` operate on temporary/saved preview state. |
| Command Palette; `contributes.menus.commandPalette` | The nine selection-dependent commands `C.rename`, `C.delete`, `C.fileInto`, `C.unfile`, `C.open`, `C.alias`, `C.archive`, `C.restore`, `C.rebind` are explicitly hidden with `when: false`. `C.create` and `C.refresh` are contributed without that suppression. Other declared Navigator commands remain subject to their own host checks. |
| Open/focus and keyboard | `N.open` is the public **Open Agent Sessions** command and has no list-tree icon. `jsonlView.revealSessionNode` is an internal host registration, absent from `contributes.commands`. `package.json` contributes no `keybindings`; this review adds no shortcut. |

### Differences from proposal names and remaining command scope

- The implementation uses `C.create`, not a proposed
  `jsonlView.collections.newCollection`. There is no second Collections command
  namespace or replacement view ID to introduce.
- `N.source.paste` and the older `N.addSourceFromClipboard` are both declared as
  **Paste JSONL Source** and both dispatch `handleSourceTreeAction('paste')`.
  Keep the compatibility alias until a separate deprecation decision accounts
  for callers; this review does not remove the duplicate Palette wording.
- There is no custom `.more` command; title groups use the host's native menu
  placement. Export commands appear on the Collections title but retain their
  document/source export owners rather than becoming membership commands.
- No contributed command implements a triage ledger, nested collection
  creation/reparenting, manual rank or provider-native archive. The present
  alias, archive and rebind actions are already implemented metadata commands,
  not future gaps. Intake is limited to its existing JSONL contracts.
- `N.settings` and `N.mcpCapability` are declared commands, not extra views.
  Future convenience commands or shortcuts require an explicit user-facing
  need, dispatch contract and manifest test; proposal labels alone do not
  establish missing functionality.

## Catalog and Collections DDL baseline

The physical DDL owner is distinct from snapshot shape owners:

| Artifact | Authoritative source / version marker | Reviewed baseline |
| --- | --- | --- |
| Navigator Catalog SQLite | `src/infrastructure/navigator/catalog-store.ts`, inline DDL in `CatalogStore.open` and `migrateMetadataPlane` | Base initialization inserts `catalog_meta.schema_version = '2'`; the additive metadata migration raises the current floor to **3**, retaining any higher stored marker and the legacy tables. This is not a claim that arbitrary future schemas are supported. |
| Versioned application Catalog snapshot | `src/application/catalog/migrations.ts`, `CATALOG_VERSION` | **2**; separate contiguous snapshot transformation/validation contract from ADR-062. |
| Provider Navigator snapshot | `src/experimental/session-navigator/types.ts`, `SESSION_NAVIGATOR_SCHEMA_VERSION` | **1**; `CatalogStore.getSnapshot` also emits `schemaVersion: 1`. Neither number is the SQLite schema marker. |
| Collections private SQLite | `src/infrastructure/navigator/collections-schema.ts`, `COLLECTIONS_SCHEMA` and `collections_state.schema_version` | **4**. `PRAGMA user_version` and `application_id` must both remain **0**; neither is the Collections schema version. |

Catalog uses WAL, `synchronous=NORMAL`, foreign keys and a 3,000 ms busy timeout.
Its existing tables and durable identity boundaries are:

| Catalog table | Key / stored purpose |
| --- | --- |
| `catalog_meta` | Key/value metadata, including the physical schema marker. |
| `sources` | `source_id`; provider, root URI, generation, capture/fingerprint/update state, bounded continuation flags/cursor. |
| `entities` | `(source_id, generation, native_id)`; entity hierarchy, catalog labels, provider metadata, activity/title provenance, relationship and project. |
| `entity_labels` | `(source_id, native_id)`; product title overlay and timestamp, independent of provider bytes. |
| `relations` | `(source_id, generation, from_native_id, to_native_id, kind)`; snapshot relations. |
| `locations` | `(source_id, generation, native_id)`; relative source path and decimal-text `row_ordinal`. |
| `source_registry` | `source_id`, unique `(provider_id, canonical_uri)`; `provider_home`/`folder`/`exact_file`, configuration revision, authorization/availability and metadata/entity scan state. |
| `index_checkpoint` | `(source_id, plane, scan_epoch)`; metadata/entity scan state, revision, cursor, fingerprint and terminal/commit status. |

There is no separate `catalog-schema.ts` DDL owner. Additive columns and
indexes, metadata reconciliation and compatibility tables remain owned by
`catalog-store.ts`; this record does not rename or consolidate them.

`CollectionsTreeProvider` derives `collections/metadata.sqlite` beneath the
extension global storage root. `CollectionsStore.open(path)` accepts that
database path, not a storage root. It verifies its exact owned DDL before
changing journal mode; foreign/future/extra objects fail with
`METADATA_UNAVAILABLE`. Accepted historical shapes are schema 1, 2, 3 and 4,
plus the exact known former v2 ALTER/RENAME spelling. Connections verify WAL,
foreign keys and `synchronous=FULL`.

| Collections v4 table | Key / constraint and purpose |
| --- | --- |
| `collections_state` | Singleton 1; schema version 4 and nonnegative safe-integer revision. |
| `user_collection` | `collection_id`; bounded display name and deterministic binary name/ID index. No parent/rank fields. |
| `collection_entry` | `entry_id`; unique `(provider_id, source_id, native_id, reference_kind)`. Kind is session/file/source; optional bounded alias and safe-integer local archive timestamp, permitted only for a session. |
| `collection_membership` | `(collection_id, entry_id)` with cascading foreign keys and reverse entry index; one anchor may have multiple collection links. |
| `collections_mutation_receipt` | Original `request_id`, 64-character command hash, operation, previous/result revision, changed flag and bounded result JSON. Effect and receipt commit atomically. |
| `collections_pending_command` | Original `request_id`, hash and bounded original command JSON; accepted work survives process/window interruption independently of effect/receipt commit. |

Schema 1 supplied normalized collection/entry/membership state; schema 2 added
receipt deduplication; schema 3 added file references, alias/archive/rebind;
schema 4 added the shared pending journal. The metadata semantics and recovery
contracts in [ADR-073](073-collections-entry-metadata.md) and
[ADR-074](074-collections-shared-journal.md) remain authoritative.

### Triage and tree-node decision

Retain the separate Catalog and Collections stores and the current normalized
reference model. Do not introduce `session_triage_ledger`,
`user_collection_nodes`, parent links, rank fields or a replacement tree schema
for the reviewed requirements. No current DDL contains those proposed tables.
Local archive intent already belongs to `collection_entry`; ADR-082's opt-in
lower projection matches currently linked provider/source/native identities,
fails open when metadata is unavailable and does not mutate Catalog rows.
Its manifest setting is
`contributes.configuration.properties["jsonlView.sessionNavigator.hideArchivedCollectionSessions"]`,
a boolean defaulting to `false`. It does not require a second archive ledger.

Flat collection membership, stable entry anchors and existing aliases cover
the present operations. Nested hierarchy and manual ordering remain product
questions until concrete interaction, identity and bounded-query requirements
justify a schema change. This decision therefore needs no new migration,
compatibility reader, backfill, database rename or version bump.

Existing recovery still matters: the Collections owner holds `BEGIN IMMEDIATE`,
reserves an exclusive same-directory `.pre-v4.<UUID>.bak`, takes and validates
an online backup (owned DDL, version, integrity, foreign keys and revision)
before migrating a recognized historical shape, and rolls back a failed
transaction. Canonical v4 copies preserve entries, memberships, receipts and
revision. Recovery reads legacy memento commands without rewriting them and
replays original UUID/hash/revision through the shared journal. A matching
receipt precedes CAS; unresolved corruption, identity/authorization failure or
revision conflict retains evidence and pauses writes. Refresh retries recovery
without promising repair or discarding commands. No automatic downgrade or
empty-database replacement is accepted.

If a future ledger or tree shape is accepted, its numbered migration decision
must first specify old-schema reads, verified backup, lock contention, preserved
pending/receipt evidence, reconciliation/repair and rollback compatibility.
Restoring an old backup alone can omit accepted commands; operational recovery
requires reviewed reconciliation, not deletion of the live metadata store.

## Residual Session Navigator module classification

The directory name `experimental` does not make all its contents a persistence
owner or justify a blanket move. The following inventory covers every current
`.ts` module in `src/experimental/session-navigator/` at the reviewed revision.
Names in the first column are relative to that directory.

| Module | Current role / disposition |
| --- | --- |
| `tree-provider.ts` | Host composition and native Agent Sessions adapter. Holds `SessionCatalogPort`, orchestrates providers, authorization, lifecycle, direct open/reveal, intake and Collections callbacks. Retain host ownership. |
| `collections-tree-provider.ts` | Native Collections UI/command adapter. Constructs the infrastructure implementation of `CollectionsPort` and owns prompts/display/recovery wiring; SQL ownership stays in infrastructure. |
| `collections-recovery.ts` | Host recovery coordinator over the Collections application port, including host queue/legacy input and validated replay; not a second database writer. |
| `catalog-store.ts` | Compatibility facade re-exporting the infrastructure `CatalogStore` and application port types/page constants. Retain until its consumers migrate. |
| `types.ts` | Provider/navigation integration types, source settings, bounded scan budgets and snapshot-v1 contract. Not the owner of shared wire envelopes or physical database versions. |
| `provider-factory.ts` | Host/provider composition selecting existing generic/native/Kimi read adapters. |
| `file-provider.ts` | Compatibility facade for generic provider/file scan/factory exports; preserve current callers. |
| `generic-provider.ts` | Bounded generic file provider adapter; uses existing profiles/scan contracts. |
| `native-provider.ts` | Bounded Codex/Claude/pi provider adapter, including provider-private file/SQLite reads. Does not own product Catalog persistence. |
| `kimi-provider.ts` | Bounded Kimi provider adapter and provider metadata integration. |
| `file-scan.ts` | Bounded filesystem scan support with cancellation/budget handling. |
| `provider-metadata.ts` | Bounded provider record metadata reader/parser. |
| `claude-metadata.ts` | Provider-specific Claude metadata/sidecar read adapter. |
| `kimi-server-journal.ts` | Provider-private read-only journal resolution/inventory. |
| `provider-errors.ts` | Provider failure classification; reusable local policy, no storage ownership. |
| `session-catalog-strategy.ts` | Provider-specific scan priority/retry, location-root and stale-open policy; does not define another catalog store. |
| `source-config.ts` | Host source configuration, authorization/discovery and filesystem identity adapter using application catalog identity helpers. Membership is not an authorization grant. |
| `source-controller-registry.ts` | Host source lifecycle/cancellation registry. |
| `source-selection-policy.ts` | Host picker/source selection validation and limits. |
| `source-tree-provider.ts` | Native intake/OS-drop adapter delegated by the host. Does not own membership or the Collections view's data. |
| `source-drop-view.ts` | Compact Add Source Webview host adapter, bounded message validation and single-flight cancellation. |
| `source-drop-html.ts` | Compact Add Source HTML/CSP/theme renderer; not a source list/catalog owner. |
| `source-intake.ts` | Host multiline-paste/local-URI validation and temporary preview adapter. |
| `source-intake-html.ts` | Separate multiline intake HTML renderer. |
| `source-intake-quickpick.ts` | Native source-action picker adapter. |
| `source-intake-contract.ts` | Local JSONL filename/extension validation policy shared by intake adapters. |
| `source-intake-limits.ts` | Local bounded-intake constants; no permission or persistence authority. |
| `session-previews.ts` | Host temporary-file/Save As lifecycle adapter and saved-copy state. |
| `recent-previews.ts` | Existing standalone native preview adapter, retained for compatibility/tests. Production composition uses the lower tree branch, not its separate view registration. |
| `reveal-intents.ts` | Host-local reveal intent, authorization, TTL and one-use lifecycle registry; shared result shape comes from `src/shared/protocol/reveal.ts`. |
| `session-reference-dnd.ts` | Bounded internal drag-reference protocol and validation. Carries source-qualified provider/source/native identity and generation; host resolution must recheck current catalog/authorization before a Collections command. |

Compatibility is observable: `src/experimental/index.ts` exports the catalog
and file-provider facades; `tree-provider.ts` and
`test/experimental/session-navigator-lifecycle.test.ts` consume the catalog
facade; `test/experimental/session-navigator.test.ts` asserts its class identity;
`test/experimental/session-navigator-provider-factory.test.ts` imports the
file-provider facade. `test/experimental/session-previews.test.ts` exercises
the standalone preview adapter. These callers block deleting the facades or
preview module merely because their directory is residual.

## Evidence, limits, alternatives and rollback

The reviewed source and tests provide these probes; this documentation-only
change does not claim that those runtime suites or a VS Code host acceptance
session were executed:

- `test/experimental/session-navigator-manifest.test.ts`: the single container,
  three views, native/title/context/Palette contribution boundaries, source
  actions and default-off archive configuration.
- `test/experimental/session-navigator.test.ts`,
  `session-navigator-lifecycle.test.ts`,
  `session-navigator-provider-factory.test.ts` in that directory: facade,
  catalog/source lifecycle and provider composition contracts.
- `test/application/catalog/migrations.test.ts` and Catalog persistence tests:
  separate snapshot migration/serialization contracts from ADR-062.
- `test/experimental/collections-store.test.ts`,
  `collections-metadata.test.ts`, `collections-journal.test.ts`,
  `collections-recovery.test.ts`: strict schemas, verified legacy backup,
  identity/CAS, durable replay and failure evidence.
- `test/experimental/reveal-intents.test.ts` and
  `test/shared/protocol-contract.test.ts`: host intent and shared protocol
  validation; they are distinct from Webview DOM confirmation.

Rejected alternatives are a wholesale Navigator rewrite, deleting compatibility
facades before their callers move, new view/command IDs copied from a proposal,
and speculative ledger/tree migrations. None supplies a demonstrated missing
capability for these review tasks. Runtime changes, performance claims,
bidirectional drag behavior and reveal feedback acceptance remain separate
implementation/evidence work.

Revisit when a concrete feature changes an owner/port, requires a new view or
command, needs nested collections/manual ordering, or changes source authority
or archive semantics. Roll back this ADR and its documentation index entries
to reverse this review. No runtime state, source bytes or metadata is changed.
