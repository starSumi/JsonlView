# Kimi persisted session profile

The `kimi-code-session` profile reads Kimi Code's agent-core-v2 persisted wire
journal. It projects one physical JSONL record into one bounded row. Opening a
journal never resumes a Kimi agent, executes tools, migrates storage, or changes
the active branch of the source session.

## Source and compatibility

Implementation evidence is MoonshotAI/kimi-code revision
`ef727e517923cb312cb48d42825c49dfacd528e7`, whose wire protocol version is 1.5.
The [session guide](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/docs/en/guides/sessions.md)
identifies `agents/*/wire.jsonl` as the persisted event stream. The
[record contract](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/wire/record.ts)
defines `type`, optional epoch-millisecond `time`, and metadata containing
`protocol_version` plus epoch-millisecond `created_at`.

This adapter recognizes the observed 1.x context journal family, including the
1.0 nested `toolCalls[].function` representation documented by the upstream
[1.0-to-1.1 migration](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/wire/migration/v1.1.ts).
It does not promise complete replay compatibility for every 1.x record, future
major versions, legacy Python `context.jsonl`, or live JSON-RPC/WebSocket
envelopes. Unknown records remain visible and retain their raw source.

## Detection

Detection uses the registry's bounded physical sample (default maximum 96 rows).
It requires either a valid 1.x metadata header and one structurally valid context
record, or at least three valid context records with two distinct event
signatures. Recognized metadata and context records must cover at least 60% of
the sample. Malformed and blank sampled physical lines remain in the denominator.

A filename, common role/content fields, a metadata record alone, or one isolated
context message cannot select Kimi automatically. Sparse or ambiguous evidence
keeps Generic available. Other durable event families may lower detection
coverage; manual profile selection remains possible.

## Projection contract

The source
[context events](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/agent/contextMemory/contextEvents.ts)
and [recorded loop union](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts)
define these mappings:

| Physical record | Row meaning and source fields |
| --- | --- |
| `metadata` | Session bookkeeping; protocol version and creation clock. No invented session ID. |
| `context.append_message` | Nested `message.role`, `content`, `id`, `toolCallId`, `origin.kind`, `isError`, `usage`. A tool message becomes a tool result; an assistant with tool calls becomes a tool call. |
| `context.append_loop_event` / `content.part` | Assistant text or reasoning; content text is `part.text`, reasoning text is `part.think`. |
| Loop `tool.call` | Tool name and exact `toolCallId`; event `uuid` is the call event identity. |
| Loop `tool.result` | Output preview, exact `toolCallId`, optional `parentUuid`, explicit `isError`. Missing error status does not assert success. |
| Loop `step.begin` / `step.end` | Turn lifecycle; `turnId`, step, finish reason and usage. Their shared `uuid` is a step identity, not a unique message identity. |
| `context.clear`, `context.undo`, `context.undone`, `context.apply_compaction` | Checkpoints preserving the historical physical rows and available count/token metadata. |
| `full_compaction.begin`, `.cancel`, `.complete` | Checkpoint status: running, cancelled or completed. |
| `turn.step.interrupted`, `.retrying` | Interruption/retry evidence, with the source turn identifier. |
| `prompt.completed`, `.aborted` | Prompt termination and source prompt identifier. A blocked or failed completion keeps that status. |
| Unknown/malformed records | An `other` row; physical evidence is retained. |

The interruption/retry events are durable in
[turnEvents.ts](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/agent/loop/turnEvents.ts),
prompt termination is durable in
[promptEvents.ts](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/agent/prompt/promptEvents.ts),
and compaction lifecycle records are durable in
[compactionOps.ts](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/agent/fullCompaction/compactionOps.ts).

An `agentId` is shown as source metadata; it is not relabeled as a session ID.
Numeric nonnegative safe-integer turn identifiers normalize to their exact
decimal string for correlation. Tool pairs use exact supplied IDs across
batches. A message containing multiple tool calls keeps the call count and raw
array; the shared singular `toolCallId` is left unset to avoid claiming one
call represents the entire message.

## Usage, budgets and inert references

Kimi's [token usage contract](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/human/llm/usage.ts)
splits input into `inputOther`, `inputCacheRead`, and `inputCacheCreation`.
Projected input is their sum only when all three are valid; cached is cache-read,
output is output, and total requires complete input plus output. Negative,
noninteger, nonfinite and unsafe summed counts are omitted. Missing buckets
remain unknown. Numeric wire clocks are interpreted as milliseconds without
guessing an alternate unit. Invalid clocks are omitted.

Content preview visits at most 16 blocks and reads at most 240 preview characters;
the final summary is at most 240 characters. Display metadata is similarly
bounded. Correlation identities longer than 2048 characters are omitted rather
than truncated, with `identityOmitted` metadata. Their full source remains in
Raw. This bounds a projection without creating false identity collisions.

The source [content-part union](https://github.com/MoonshotAI/kimi-code/blob/ef727e517923cb312cb48d42825c49dfacd528e7/packages/agent-core-v2/src/human/llm/message.ts)
includes image, audio, video and thinking parts. Semantic summaries emit media
reference labels; they never decode data URLs, fetch URLs, resolve files, or
follow tool `output_path` references. Hidden or encrypted thinking emits a
placeholder; the source bytes remain accessible in Raw.

Undo, clear, branch switches and compaction can affect Kimi's replayed active
context. This viewer does not replay those mutations or erase earlier rows. It
does not synthesize successful results for an interrupted or unmatched tool.

## Validation and rollback

Synthetic profile tests cover detection, mixed/malformed input, physical history,
tool pairing across batches, old nested tool calls, error/interruption status,
cache accounting, inert media and reference handling, oversized identities and
bounded content scanning. The existing profile registry tests cover retained
built-ins. These checks prove projection behavior, not live Kimi execution or
Session Navigator provider onboarding.

Rollback removes the Kimi registry entry and the profile exports. Generic JSONL
access remains available; no source files require migration or restoration.
