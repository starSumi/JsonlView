# ADR-023: Native Build Reproducibility

Status: accepted, experimental

## Pressure

Two Windows native builds from the same clean 0.2.6 source revision produced
different addon bytes. The only archive entry that differed was the native
.node file: its PE timestamp and CodeView identity changed between runs.
That weakens artifact comparison and makes a release candidate harder to
reproduce, while native debug information remains useful for diagnosis.

## Invariant

The native addon remains an optional accelerator and keeps its debug metadata.
The build must preserve caller-supplied Rust flags, redact checkout paths, and
add the MSVC reproducibility flag only for the Windows native target. Non-
Windows builds keep their existing flag set.

## Owner

scripts/build-native.mjs owns the Cargo environment and linker flag boundary.
native/jsonl-core/ owns the Rust implementation. JsonlView-harness owns the
repeated-build measurements and artifact evidence.

## Alternatives

- Leave the drift in place: rejected because exact source candidates cannot be
  compared byte-for-byte.
- Strip all debug information with /DEBUG:NONE: rejected because it removes
  CodeView diagnostics and the local probe still observed a changing PE
  timestamp.
- Rewrite PE bytes after linking: rejected because post-build mutation hides
  the linker contract and risks invalidating signatures or debug relationships.
- Apply the flag on every platform: rejected because /Brepro is an MSVC/PE
  linker option and the portable build must not receive a target-specific flag.

## Probe

Build the same clean revision twice in separate output directories. Compare the
VSIX archive, embedded native addon, JavaScript/CSS bundle inventory, and the
native PE debug/timestamp metadata. The acceptance target is identical native
bytes and unchanged bundle content. Also exercise the pure flag builder for
Windows, non-Windows, inherited flags, and duplicate suppression.

## Decision

Use -C link-arg=/Brepro through Cargo's encoded Rust flag channel for Windows
native builds. The helper appends it after existing flags and before path
remaps, while avoiding a duplicate when an outer build already supplied it.
The source is import-safe so the helper can be unit-tested without starting a
native build process.

Rust documents link-arg as appending one argument to the linker invocation
and permits repeated uses:
https://doc.rust-lang.org/rustc/codegen-options/index.html#link-arg
Cargo documents CARGO_ENCODED_RUSTFLAGS as the unit-separator encoded flag
channel used for all compiler invocations:
https://doc.rust-lang.org/cargo/reference/environment-variables.html#environment-variables-cargo-reads
The LLVM COFF linker source describes /Brepro as using an executable hash for
the PE header timestamp:
https://github.com/llvm/llvm-project/blob/main/lld/COFF/Options.td
The current Microsoft Learn /Brepro page did not resolve during the 2026-10-06
source check, so the flag's acceptance for this MSVC toolchain is additionally
bounded by the local linker probe recorded in the harness evidence.

## Evidence

On the frozen revision 20f1f9ddc2355dde73a861555c07948ddaa48dfb, two baseline
packages had identical JS/CSS inventories but different native addon hashes:
8d0cf1da1ecc29cda130da4e1c1311e63c02883a2d60ee5341ed8a9c2201c0cd and
182cf3758669aee8c2eb00263431db2eecead3714e412fe384e76712bd991b73.
The controlled /Brepro probe produced the same native hash twice:
17C527B08D0099D8BDA7E1BC7EBA379063F32C7E0473CF51002480866E85E678.
The full post-change package result remains a release gate and is recorded in
the harness, not inferred from this decision record.

## Boundary

This decision changes native build metadata only. It does not make native
execution mandatory, alter scanner semantics, expose debug paths at runtime,
or authorize a release. A reproducible native file does not by itself prove
cross-platform behavior, signing, or registry publication.

## Revisit Trigger

Revisit when the Windows linker toolchain changes, PE signing is introduced,
the /Brepro contract changes, or repeated clean builds still diverge after
the flag is applied.

## Rollback

Remove the Windows-only flag addition and its focused tests. Existing path
remaps, native fallback, and release gates remain unchanged.
