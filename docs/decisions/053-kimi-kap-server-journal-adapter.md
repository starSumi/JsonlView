# ADR-053: Kimi KAP Server Journal Adapter

Status: accepted

## Pressure

Kimi Code has two local persistence layouts with different contracts: the
agent-core-v2 `sessions/**/agents/**/wire.jsonl` stream and the KAP server v1
`server/events/<sessionId>.jsonl` journal. Treating the server root as a wire
home leaves its latest session activity undiscovered and its physical
`kind`/`envelope` records in Generic JSONL.

## Invariant

The physical JSONL record remains authoritative. Server projection uses the
versioned journal boundary and exact evidence paths, preserves unknown data in
Raw, reads only explicitly authorized local sources, and never connects to the
server or executes source content.

## Alternatives

- Reuse the wire parser by flattening the server envelope: rejected because it
  loses source paths and confuses two different persisted protocols.
- Add an always-on network client or read the server database: rejected because
  the local journal already provides a read-only source and activation must
  remain dormant.
- Keep the server format as Generic only: rejected because the stable event
  envelope and event union support bounded, source-backed projections.

## Decision

Keep both Kimi layouts under the existing `kimi-code-session` profile ID while
advancing its profile revision. A strict decoder recognizes the KAP v1 header
and `{ kind: "event", seq, envelope }` records; the envelope type is the
dispatch key, and payload fields are never found through recursive search.
Typed projectors cover server session, prompt, turn, context, error, tool and
MCP status events. Unknown events remain `other`.

The Navigator scans both layouts inside an authorized Kimi home. For matching
session directory and journal identifiers, it keeps the existing session
identity and subagent relationships while preferring the journal location and
bounded current metadata. Unmatched journals remain separate sessions. An
explicit server or events root is supported as a journal-only source. Reads
sample bounded head and tail windows, choose the newest valid journal header as
the current recovery epoch, and never combine metadata across epochs. Global
journals and server runtime files are outside this adapter.

## Probe

Synthetic tests cover current and recovered journal epochs, conflicting or
malformed envelopes, wire compatibility, matching and unmatched sessions,
subagents, stale continuations, append invalidation, symbolic links, and byte,
record, file and time budgets. Focused Kimi profile, Navigator and Webview tests
are required alongside the repository's normal product gates.

## Evidence

The source contract is MoonshotAI/kimi-code revision
`4a82a07f08d0b135c4349c20aae53a2d51e5c3fa`:
[sessionEventJournal.ts](https://github.com/MoonshotAI/kimi-code/blob/4a82a07f08d0b135c4349c20aae53a2d51e5c3fa/packages/kap-server/src/transport/ws/v1/sessionEventJournal.ts)
defines persisted headers, event envelopes and recovery by appending a new
epoch; [events.ts](https://github.com/MoonshotAI/kimi-code/blob/4a82a07f08d0b135c4349c20aae53a2d51e5c3fa/packages/kap-server/src/transport/ws/v1/events.ts)
defines the producer event types. The local implementation pins that source
revision in `src/profiles/kimi-server-record.ts`.

## Boundary

This adapter is metadata-only in the Navigator and bounded per physical record
in profile/detail projections. It does not replay sessions, redact or rewrite
the source file, infer event schemas from arbitrary keys, or expose Kimi's local
credentials and runtime configuration.

## Revisit trigger

Revisit when Kimi changes the KAP journal version, recovery semantics, event
envelope, or server event definitions.

## Rollback

Remove KAP server layout discovery and server event registration while keeping
the existing wire profile and Generic JSONL access. No source migration or
provider-owned write is required.
