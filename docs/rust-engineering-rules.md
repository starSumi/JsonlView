# Rust Native Engineering Rules

These rules govern `native/jsonl-core/`. They are intentionally narrower than a
generic Rust style guide and match the current N-API scanner boundary.

## Rules

1. Make invalid states explicit with enums and typed errors. Do not encode a
   lifecycle or capability as unrelated booleans.
2. Keep the native crate a bounded accelerator. It may scan bytes and return
   validated offsets; it does not own source truth, profiles, UI state, MCP
   authority, or provider storage.
3. Treat caller-owned buffers and N-API values as untrusted. Validate input
   size, start offsets, output limits, integer conversions, and ABI/capability
   identity before touching the fast path.
4. Every native failure must return a typed error and select the portable Node
   fallback. Never silently return partial or unchecked offsets.
5. Preserve absolute byte semantics. Do not reinterpret UTF-8, BOM, CRLF, or a
   partial final record in the scanner. JavaScript values that may exceed safe
   integer precision cross the boundary as decimal strings.
6. Prefer borrowing and bounded allocation where the contract permits it, but
   do not claim zero-copy or memory mapping without a representative benchmark
   and a safe fallback.
7. Keep public exports and visibility narrow. Add a trait or helper only when a
   test, consumer, or contract requires it; document the invariant at the
   boundary.
8. Test the oracle and the accelerator together: empty input, CRLF, malformed
   tails, large offsets, output caps, cancellation/error mapping, and native vs
   portable equivalence are mandatory for scanner changes.

## Promotion gate

`native:fmt`, `native:check`, `native:clippy`, `native:test`, the TypeScript
typecheck, portable differential tests, and the production build must pass. A
native optimization remains opt-in or auto-calibrated until it shows a
repeatable end-to-end win without increasing peak memory or weakening failure
recovery. The current crate implements only the bounded LF scanner; sparse
segments, Roaring bitmaps, PieceTree/LSM staging, and memory mapping remain
separate experiments.
