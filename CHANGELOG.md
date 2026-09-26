# Changelog

## 0.2.2 - 2026-09-26

- Add the light JsonlView product icon to the packaged extension so the
  extension identity remains recognizable in supported registries and editor
  surfaces.

## 0.2.1 - 2026-09-25

- Preserve the existing Open VSX update identity as
  `Sumi-Sophia.jsonl-view` and publish the Visual Studio Marketplace build as
  `Sumi-Sophia.jsonlview-data-studio`, because `jsonl-view` is already owned by
  an unrelated Marketplace publisher.
- Generate both VSIX files from one frozen source, native addon, and production
  bundle. The release gate now proves that all non-identity archive entries are
  byte-for-byte equal and binds each artifact to its declared registry target.
- Keep `jsonlView.*` commands, settings, and custom-editor identifiers stable.
  The two registry builds are alternatives and must not be installed together.
- Record candidate-only native comparisons as not applicable instead of
  reporting an unperformed committed-binary comparison as a failed comparison.
- Require release changes to reach `main` through a reviewed pull request, then
  verify required checks, the GitHub latest pointer, release assets, and each
  registry independently after publication.

## 0.2.0 - 2026-09-23

- Release JsonlView under the MIT License.
- Build npm and VSIX packages from the same frozen JavaScript, CSS, and native
  inputs. The release gate now inspects the exact `.tgz` and VSIX archives,
  checks both embedded identities, and rejects duplicate or unexpected paths.
- Keep sorted views on the nearest valid page after a rebuild shrinks the
  result set; incomplete scans no longer guess a replacement offset.
- Bound array probing, command formatting, diff projection, Claude content
  blocks, syntax highlighting, and Raw rendering before they create large DOM
  trees. Large Raw records now use navigable source chunks while Copy keeps the
  complete hydrated value.
- Bind the rebuilt native addon's SHA-256 to both distribution manifests and
  re-open the finished VSIX to hash the embedded binary before promotion.
- Render Codex `FileChange` unified diffs in a dedicated bounded view with
  numbered context, green additions, red removals, and Raw/Copy preservation;
  support both path-keyed change maps and array-shaped changes.
- Render Codex command arrays as wrapped Shell/PowerShell code and format
  common one-line Code Mode JavaScript objects/statements for display while
  preserving the original command/input for Copy and Raw.
- Add an explicit, separately bounded full-record hydration action for oversized
  details; list hydration remains conservative and never becomes unbounded.
- Refresh React, virtual-list, icon, type, and napi-rs dependencies to current
  compatible releases; keep major-version migrations as separately validated
  work.
- Add a V8 coverage command and CI thresholds focused on product source files.
- Harden scheduled dependency freshness checks with compact registry requests,
  bounded retries, and visible degraded failures.
- Document the marketplace/private-gallery update boundary and reject an
  activation-time self-updater that would bypass editor trust semantics.
- Preserve the active physical page across manual rebuilds, including source
  invalidation, cancellation, shrinking files, and late generation messages;
  keep unfinished page drafts separate from submitted requests.
- Add a plan-only promotion coordinator that joins candidate provenance and
  leaves local VS Code, GitHub, npm, Open VSX, and Marketplace as independent
  authorization/readback lanes.
- Recognize Claude Code job timelines (`at/state/detail/text`) as lifecycle
  events, preserving timestamps and state evidence instead of rendering rows as
  `other`.
- Recognize the observed Claude command-history surface with normalized
  timestamps and explicit project/session evidence; keep the profile id stable
  while versioning its projection contract.
- Render Claude assistant and job-timeline text through the bounded Markdown
  container while keeping user prompts, tool output, and ordinary logs in their
  safer Auto/Text paths.
- Add pull-request CI, weekly dependency freshness reports, Dependabot upkeep,
  and an external benchmark trend report with comparable-workload baselines.
- Keep native benchmark probes on the shared ABI contract, record benchmark
  provenance, and run the packaged native smoke on Windows CI independently of
  the registry-backed freshness report.
- Harden pnpm-facing maintenance and promotion CLIs so one forwarded `--`
  separator is accepted while a second separator remains an explicit error.
- Bound sorted query candidates to lightweight index references, rehydrate only
  the visible window, and preserve a logical continuation when page hydration
  reaches its cap; sparse bounded scans no longer advertise a phantom next page.
- Mark filtered results as partial when a record cannot be inspected under the
  record hydration/parser boundary instead of silently treating it as a miss.
- Keep the additive scan-reason value backward-tolerant in the Webview, so a
  stale client shows a generic scan-limit label instead of rendering a blank
  status.
- Route structured tool output through JSON-aware containers, unwrap bounded
  double-serialized documents, and offer conservative Shell/PowerShell/Rust/
  Python/JavaScript code highlighting without changing the copied source.
- Keep the first structured output preview small, while `Show full` can render
  an ordinary object/array up to a separate finite expansion budget; larger
  values remain explicitly Raw-only instead of silently losing content.
- Align the extension engine and VS Code type baseline to the portable VS Code
  1.136 runtime so candidate VSIX packaging validates the actual acceptance host.

## 0.1.6

- Added reviewed product screenshots for the table, tree, schema, and Insights
  views.
- Moved synthetic fixtures and acceptance reports to the companion
  `JsonlView-harness` workspace.
- Added third-party license notices for bundled runtime dependencies.

## 0.1.5

- Removed a private benchmark-sized value from a public test fixture.

## 0.1.4

- Set the VS Code Marketplace and Open VSX publisher identity to
  `Sumi-Sophia`; the generated npm package remains `@sumi-labs/jsonl-view`.

## 0.1.3

- Removed private corpus size and performance metadata from the public
  acceleration roadmap; public claims now point to reproducible synthetic
  benchmark inputs.

## 0.1.2

- Corrected the generated npm package scope to `@sumi-labs/jsonl-view`.

## 0.1.1

- Separated the valid unscoped VS Code extension manifest from the generated
  scoped npm package metadata.
- Added reproducible native release path remapping to keep builder directories
  out of the distributed addon.

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
