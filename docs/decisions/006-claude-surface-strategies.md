# ADR-006 Claude surface strategies

## Pressure

Claude writes more than one JSONL surface. A session transcript, a job
`timeline.jsonl`, and `history.jsonl` have different record contracts. The
adapter must recognize observed shapes without turning every `{text: ...}` log
or generic `{at,state,detail,text}` workflow event into a Claude session.

## Invariant

The source file remains authoritative. Record-shape classification is bounded
and pure; it never reads a sibling file. Automatic selection of the ambiguous
job-timeline shape additionally requires an ephemeral, host-supplied locator
hint matching `.claude/jobs/<id>/timeline.jsonl`; the hint is not persisted or
sent to the Webview. Unknown records remain visible, and a failed or ambiguous
classification falls back to Generic JSONL without changing byte offsets or
generations.

## Owner

`src/profiles/claude-record-strategy.ts` owns pure surface classification.
`ClaudeCodeProfile` owns semantic projection. The engine owns framing and
hydration. The extension/session layer may own a future, explicit companion
locator; Claude's daemon remains the external writer.

## Alternatives

- Keep all shape checks duplicated in the profile and Webview: rejected because
  the two paths already drifted.
- Register three public profiles immediately: deferred because it changes the
  profile-selection and correlation contract without a migration corpus.
- Infer a Claude surface from arbitrary directory names or `cwd`: rejected
  because path slugs, worktrees, stale state, and symlinks are not identity
  evidence. A narrowly validated `.claude/jobs/<id>/timeline.jsonl` hint is
  accepted only to disambiguate the otherwise generic timeline shape.
- Promote arbitrary `text` by a Markdown salience score: rejected because the
  proposed weights have no measured corpus and would misrender ordinary logs.

## Probe

Use redacted fixtures for transcript, job timeline, and history; add negative
records with missing fields, invalid timestamps, singleton samples, ordinary
`{text, state, detail}` application logs, and control types without identity.
Required results are stable transcript/history selection, timeline selection
only with its validated path hint, Generic fallback for content-only collisions,
explicit evidence paths, and unchanged raw records.

## Decision

Keep the stable profile id `claude-code-session`, bump its profile version to
`2`, and route records through an internal strategy classifier. The current
timeline boundary requires an ISO-like `at`, a known observed lifecycle state,
and string `detail` plus `text`; automatic selection also requires two records
from a validated `.claude/jobs/<id>/timeline.jsonl` hint. History requires
string `display`, numeric millisecond `timestamp`, string `project` and
`sessionId`, and an object `pastedContents`. Transcript evidence accepts the
repeated `type` plus nested role/message envelope used by standard exports
even when individual lines omit `sessionId`/`uuid`; those identity fields
remain a confidence signal and are used when available. Control records still
require a session and record identity together. These are observed
compatibility rules, not claims about an official stable Claude schema.
Timeline text is Markdown-capable only when the explicit timeline strategy
matches; history display remains ordinary text.

Path-aware `SourceDescriptor`, bounded companion snapshots, and separate
History/Timeline public profile ids are follow-up work gated by a corpus,
explicit user action, and lifecycle/failure tests.

## Evidence

- Runtime-observed local samples contain `{at,state,detail,text}` in
  `.claude/jobs/<job>/timeline.jsonl`, including `observed`, `working`,
  `blocked`, and `done` states.
- Runtime-observed `history.jsonl` rows contain `display`, `pastedContents`,
  numeric `timestamp`, `project`, and `sessionId`.
- Source review shows `AgentProfile.detect` receives bounded values plus an
  ephemeral host locator hint, while the engine owns immutable record
  references.
- Unit tests cover positive and adversarial shapes; no claim is made about
  undocumented future Claude versions.

## Boundary

This decision does not add filesystem I/O, companion-file linking, a new shared
event kind, WASM, MCP, or an automatic Markdown scoring model. It also does not
change JSONL framing: one physical line remains one record candidate.

## Revisit Trigger

Revisit after a versioned public Claude schema or a redacted corpus shows a
stable additional surface, after users request explicit companion navigation,
or when measured classification false positives exceed the accepted threshold.

## Rollback

Disable the specialized strategy branch and retain the previous Generic/raw
path. If the profile version migration causes stale correlation state, discard
only the derived state keyed by `claude-code-session@2`; source bytes and record
references remain untouched.
