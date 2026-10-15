# ADR-045: Table Query and Column Ownership

Status: accepted

## Pressure

Search, one field condition and an ungrouped column list shared the file header.
With an open detail drawer, those controls appeared to affect both panes. Nested
array content paths also obscured useful table columns and row-type choices.

## Invariant

Physical source records and the existing typed query AST remain authoritative.
Search, every field condition and the row discriminator query the current file
together in bounded scans. The table reports a limited scan through its existing
scan banner. Visible columns control projection and presentation independently.
Follow and selected-record recovery retain their existing lifecycle.

## Owner

The Webview record-query feature owns controls, selection and column catalog
presentation. Its controller captures query intent before React commits. The
engine owns predicate evaluation and scan bounds. Profile adapters own Event
classification; this change introduces no new classifier or protocol variant.

## Alternatives

- Keep table controls in the file header: rejected because their scope is unclear
  when the detail drawer is open.
- Use every schema path as a row type or a primary column: rejected because array
  items and large objects describe a record's contents rather than its row.
- Add a second filter protocol: rejected because existing `and`, `or`, record
  paths and `profile_field` predicates express the required behavior.

## Probe

Check a real engine query using a synthetic Codex profile file: Event `message`
  OR `tool_call`, AND a text search, AND two record conditions. Check scan limits,
legacy single-filter restoration, profile switching, independent group clearing,
selected column retention and a popup constrained to a narrow table pane.

## Decision

The file header retains file status, Profile and Follow. The Table pane owns
Search, Row types, Field filters, Columns and the scan banner. Each native
disclosure anchors to its own button and is horizontally constrained to the
Table pane, including after splitter resizing.

Field conditions match ALL, up to 16. One discriminator matches ANY of up to 32
selected values and combines with the search and field conditions using AND.
When available, its default source is the active profile's Event category.
Generic uses the sampled top-level string `$.type`, explicitly labeled Record
type; nested type fields remain ordinary field conditions. Unseen raw record
types can be added explicitly. Legacy persisted `filter` restores as a one-item
`filters` list, and a retained compatibility field mirrors its first condition.

Columns starts with ordinal and the current profile's common columns. Extra
record fields are searchable. Short scalar samples with stable, unindexed paths
and sufficient observed presence receive priority. Indexed paths, objects,
arrays, long or multiline samples and sparse fields appear in Advanced fields
after a path search. Already selected fields remain visible in the chooser and
retain their projection regardless of classification. Configured canonical
record paths restore independently of schema samples and profile switches.
The request column cap bounds projection; overflow selections remain visible
and removable in the chooser. Visibility changes remain local without issuing a
row query when the current page projection contains every required field.
Missing fields, including configured overflow promoted into the projection,
retain the existing bounded viewport refresh. This retains only the current
page projection and does not cache the file or predicate results. Sampling
describes observed shapes, not a guaranteed whole-file schema.

The controls use native checkboxes, labels, fieldsets and details disclosures,
following the established [checkbox](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/)
and [disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) interaction
patterns. This does not claim a full accessibility audit.

## Evidence

Focused tests exercise the real engine and profile projection, controller/client/
reducer commit lag, persistence migration, column classification, disclosure
labels and pane geometry. Type checking verifies the existing protocol remains
compatible. Full product checks and installed-host acceptance belong to the
integrated candidate gate.

## Boundary

Search and filters operate on a bounded source window, not only the rows already
displayed and not a promise to inspect every file byte in one request. Schema
values and column suitability remain sampled. No source writes, package changes
or new external dependencies are introduced.

## Revisit Trigger

Revisit when the query AST, profile Event vocabulary, scan-continuation contract
or a measured wide-schema workload changes.

## Rollback

Revert the affected Webview files and tests together. Keep source bytes intact.
The persisted compatibility `filter` retains the first field condition for an
older Webview; new `filters` and `rowTypes` values remain saved for re-adoption.
