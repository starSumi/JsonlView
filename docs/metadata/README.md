# Documentation Metadata

This directory defines the machine-readable metadata contract for the public
product documentation. Markdown remains the human-facing body; YAML carries
stable identity, classification, ownership, lifecycle, evidence pointers, and
rollback/revisit metadata.

## Why a catalog first

Historical decision records are append-only records. Rewriting every record to
add front matter would create noisy diffs and could change their reviewable
history. `index.yaml` is therefore the migration-safe catalog for the current
set of documents. New documents may start with YAML front matter when their
metadata is naturally co-located; the validator will accept that migration
path once a document is removed from the catalog in a separate reviewed change.

The catalog is not a runtime registry and does not import harness reports,
private transcripts, machine paths, credentials, or generated screenshots.
Evidence entries identify an immutable receipt or public source and describe
the measurement boundary; the raw evidence remains outside the product tree.

## Contract

- `schema.yaml` is the versioned field and enum contract.
- `index.yaml` has one entry for every `docs/**/*.md` file, including this
  policy document.
- `id` is stable and human-readable; `path` is a repository-relative POSIX
  path.
- `kind`, `status`, `owner`, and `tags` support filtering without parsing prose.
- `evidence` is an array of bounded references. Keep it empty when a document
  has no measured claim.
- `revisit` and `rollback` are required even when the value is a short, honest
  statement such as `when the contract changes` or `supersede this record`.
- Additional fields must begin with `x-` so the schema can evolve without
  silently accepting typos.

Run `pnpm check:docs-index` to validate both the existing ADR index and this
metadata catalog.
