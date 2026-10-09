# ADR-036: Pi Coding Agent Session Adapter

Status: experimental

## Pressure

The pi coding agent keeps append-only session JSONL files under a provider-owned
home. Its directory layout and fork metadata differ from Codex and Claude, so a
generic line-oriented projection cannot preserve session identity or cross-file
forks reliably.

## Invariant

- Pi remains the authority for session IDs, timestamps, titles, parentSession
  fork edges, and transcript contents.
- JsonlView reads only bounded metadata and stores no transcript bodies in its
  catalog.
- A pi source is detected only after Session Navigator opt-in, from the
  provider-owned default home or its documented environment overrides.
- Parent paths are resolved inside the authorized root before a relation is
  emitted. Missing or paged parents remain explicit orphan roots.
- The adapter is read-only and uses the same generation, fingerprint,
  cancellation, pagination, and reveal guards as other native providers.

## Owner

The session-navigator native-provider module owns pi discovery and metadata
projection. The catalog owns product labels, sorting, and cached generations.
The tree provider owns explicit authorization and reveal. The JsonlView editor
remains the transcript surface.

## Decision

Support the standard pi agent home at ~/.pi/agent and the environment override
PI_CODING_AGENT_DIR. When PI_CODING_AGENT_SESSION_DIR is set, it is used as
the session root while the agent root remains provider context. Each JSONL file
is summarized from its session header and a bounded metadata prefix. The
header's parentSession creates a cross-file fork relation; in-file parentId
chains are not promoted to separate session entities.

Activity is the newest bounded provider timestamp, with start time and a short
stable ID fallback. Pagination is file-based and fingerprint-bound so a source
change invalidates a stale continuation instead of skipping or duplicating
sessions.

## Alternatives

1. Treat each pi JSONL record as a tree node: rejected because it exposes
   message internals and loses the session boundary.
2. Import pi transcripts into the product catalog: rejected because source
   JSONL is the physical authority and catalog storage is metadata-only.
3. Require users to browse to ~/.pi/agent: rejected because the provider owns a
   stable standard home and explicit opt-in already gates discovery.

## Evidence

- Pi source study: F:/playground/pi.
- Pi path and configuration notes:
  E:/Zero_Base/01-Vault/Syntax/00_Project/JsonlView/pi/packages coding-agent src utils paths.ts config.ts.md.
- The adapter tests use synthetic JSONL fixtures and do not read private user
  sessions.

## Boundary

This is a local, opt-in, read-only adapter. It adds no MCP transport, watcher,
source mutation, daemon, or provider database write.

## Revisit trigger

Revisit when pi changes its session header, environment override, or fork path
contract, or when installed-host acceptance covers restart persistence,
pagination under mutation, and reveal of a child session.

## Rollback

Remove pi from the session navigator provider registry and manifest enum, or
disable the Navigator. Existing catalog rows are product-owned metadata and
provider files are never deleted by rollback.
