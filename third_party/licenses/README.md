# Locked native dependency notices

This directory is generated from the registry packages resolved by
`native/jsonl-core/Cargo.lock`. Each filename includes the exact crate name,
version, and upstream notice filename; the contents are copied unchanged from
the package extracted by Cargo.

Run `pnpm generate:cargo-notices` after an intentional Cargo lockfile change.
Run `pnpm check:cargo-notices` in CI and before release: it recomputes the
expected inventory and exact file contents and rejects missing, modified, or
unexpected files.

Some `napi-rs` crates declare MIT but omit a license file from the published
crate. Their exact upstream license is retained under
`third_party/license-overrides/` and bound to each crate's pinned
`.cargo_vcs_info.json` revision by the checker. Do not add an override without
pinning and reviewing its upstream revision.

JavaScript runtime dependency notices remain in `THIRD-PARTY-NOTICES.txt`.
