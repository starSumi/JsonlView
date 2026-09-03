# Changelog

## 0.1.0

- Added bounded JSONL byte indexing, lazy hydration, malformed-record retention,
  schema discovery, predicates, pagination, cancellation, and refresh detection.
- Added Codex rollout, Claude Code, generic Agent event, OpenTelemetry,
  software-engineering trajectory, traditional structured-log, and generic
  JSONL profiles.
- Added a virtualized VS Code Webview with table, timeline, schema, problems, and
  detail views, plus source follow and index rebuild workflows.
- Added stable tail-follow handoff: the prior page remains rendered while a
  verified append generation loads, then the new tail replaces it atomically.
- Added opt-in bounded Insights with category and time-bucket charts, filtering,
  cancellation, physical record/byte/time scan budgets, separate examined and
  matched counts, and overflow/truncation reporting.
- Added a resizable record detail pane, collapsible bounded JSON tree, safe JSON
  syntax highlighting, and Pretty/Source switching.
- Pretty and Derived JSON now use a line-numbered, syntax-highlighted fold view;
  Source remains the exact single-line record for provenance checks.
- Added domain event kinds for logs, spans, tasks, actions, observations,
  patches, tests, and results while keeping severity orthogonal.
- Added tolerant BOM recovery with an explicit `NON_STANDARD_BOM` warning.
- Added an experimental napi-rs/memchr newline scanner with ABI/output checks,
  adaptive calibration, and permanent Node fallback after native failure.
- Added bounded Agent content rendering with Auto/Text/Markdown/JSON modes,
  conservative fenced-code and embedded-JSON detection, safe Markdown blocks,
  explicit preview/rich-parsing truncation notices, semantic Codex
  `AgentMessage` Markdown defaults, per-code-block copy/Wrap controls, and
  bounded lexical highlighting for common agent-generated languages.
