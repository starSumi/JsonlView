# ADR-038: Claude Top-Level Tool Result Presentation

Status: experimental

## Pressure

Claude transcript rows can pair a message.content tool_result block with a
top-level toolUseResult. The result carries useful tool-specific fields such
as Read file text, Edit structured patches, shell streams, Search matches, and
NotebookEdit cell sources. Treating the envelope as generic JSON hides these
signals, while copying complete files into a derived view exceeds the Webview
budget.

## Invariant

- The source JSONL record and Raw view remain authoritative.
- Presentation uses an allow-list of observed fields and bounded character,
  block, hunk, line, and array budgets.
- Unified patches and NotebookEdit before/after sources use the shared DiffView
  path; no patch is applied and no complete original file is copied.
- Unknown result fields remain in bounded Tool metadata or Raw; source metadata
  such as taskId, backgroundTaskId, and interrupted is displayed verbatim
  without inferring task state.
- The adapter is read-only and never reads the private session fixture at
  runtime or stores transcript bodies.

## Decision

Keep the shape-aware extractor in src/profiles/claude-tool-projection.ts and
adapt its bounded sections in event-presentation.tsx. Recognize Read,
Write/Create, Edit structuredPatch, Search filenames/content, shell stdout/
stderr, NotebookEdit old_source/new_source, textual diff or patch, and the
bounded source metadata allow-list. Rendered previews remain separate from Raw
and use existing copy/expand behavior.

## Evidence

Read-only inspection of a real Claude JSONL session observed 17 top-level
toolUseResult records containing the field families above. Product tests use
synthetic redacted values only; no private record or path is copied into the
repository.

## Boundary and rollback

This is a Webview presentation change with no shared protocol or catalog schema
change. Roll back by removing the extractor import and adapter call; the
generic message content and Raw views continue to work.

## Revisit trigger

Revisit when Claude publishes a stable result schema, a new tool result family
needs a section, or installed-host evidence shows a budget or rendering issue.
