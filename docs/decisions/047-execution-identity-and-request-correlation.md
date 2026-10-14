# ADR-046: Execution Identity and Request Correlation

Status: accepted

## Pressure

An activation log could identify the extension by name but could not prove which
source and build inputs produced the running Extension Host and Webview. Async
request handling also retained only generation; when an epoch advanced inside
the same generation, a late result could be stamped with the current epoch and
appear to belong to a lifecycle it never observed.

## Invariant

One generated ExecutionIdentity v1 is embedded in both JavaScript bundles and
written as a frozen distribution manifest. Startup evidence is accepted only
when the Webview reports the exact identity expected by the Extension Host. A
request freezes documentId, generation and epoch at acceptance. Its completion
either echoes that tuple unchanged while it is current or publishes nothing.

## Owner

The build owns identity derivation and distribution verification. Shared code
owns the versioned identity shape. The Extension Host owns request acceptance,
late-result rejection and startup receipt validation. The Webview reports its
embedded identity without deriving or overriding it.

## Alternatives

- Hash a completed bundle into a constant inside that bundle: rejected because
  the value changes the bytes it attempts to identify.
- Report only package version and Git HEAD: rejected because dirty or otherwise
  different build inputs can share both values.
- Read current epoch when sending a response: rejected because it relabels work
  accepted under an earlier lifecycle.

## Probe

Build production bundles and statically verify that the complete canonical
identity matches the manifest. Separately execute controlled generated CJS and
IIFE fixtures to check the generator's runtime import binding. Alter or omit a runtime
field, retain an incidental digest comment, duplicate the binding, mix two build
rounds, or package old dist against changed source and require rejection. Change
an input between the two compilations and require no frozen manifest. Hold a
rows request or recovery publication pending, advance only epoch, release the
result and require that no response is sent.

## Decision

ExecutionIdentity v1 records source extension id and version, a
`development`/`production`/`test` buildMode, Git source revision and clean/modified state, a
bounded aggregate SHA-256 of repository build inputs, and a canonical manifest
digest. The aggregate covers source, package and build configuration without
listing local paths. The input set includes the identity generator itself.

A production build derives one identity before either compilation. Each bundle
has one canonical top-level immutable binding, and the generated runtime import
consumes that binding. A controlled `"use strict"` directive precedes the binding
so a banner cannot displace the compiler's directive prologue or relax language
semantics. The build re-derives source identity after both
compilations; changed inputs, revision or source state prevent finalization.
Watch output is development-only: the two incremental compilers are independent
and never publish a frozen-pair manifest or inventory.

Verification parses JavaScript without execution using the pinned build-only
[@babel/parser API](https://babeljs.io/docs/babel-parser). It extracts the unique
literal binding, validates exact fields and canonical digest, checks that the
binding is referenced, and compares every field against the selected manifest.
The identity is the first non-directive statement after the single controlled
strict directive.
The reference check rejects an obviously unused marker; it does not prove the
semantics of arbitrary rewritten JavaScript. Comments containing a digest do
not qualify. The controlled generator connects its virtual runtime import to the
binding; a separate trusted synthetic compilation/execution test checks that
connection. The independent postbuild
`execution-bundle-inventory.json` hashes the completed manifest, Extension Host,
Webview and stylesheet bytes. Its own bytes are excluded, so no digest is
embedded into the bytes it hashes. The distribution has five files including
this inventory.

Candidate assembly first verifies these artifacts, then re-derives the selected
checkout identity and compares source revision, state and build input digest.
Release candidates require a production identity from clean source. Local npm
assembly may use modified source only when it exactly matches its selected
build. Packaging rechecks source after assembly. The source extension identity
stays under source provenance; npm scope and VSIX target metadata remain separate
package identities. No arbitrary target manifest can redefine the source build.

The host separately captures runtimeIdentity from ExtensionContext: actual
extension id/version and extensionMode (`production`, `development`, `test`, or
`unknown`). Build optimization never implies installation mode. A production
bundle loaded through a Development Host reports development. Missing host
metadata remains unknown; it is never inferred from the manifest. These values
come from the [VS Code API contract](https://code.visualstudio.com/api/references/vscode-api#ExtensionMode)
and the project's installed `@types/vscode` declarations.

Activation emits both identities as a bounded, complete JSON Output-channel
receipt. Every startup stage carries the embedded build identity and the same
host-captured runtimeIdentity, passed through escaped Webview bootstrap data. The
host rejects missing or mismatched values before recording the stage.

The read-only artifact verifier accepts optional sanitized receipt evidence:
`node scripts/execution-identity.mjs --dist <dist-directory> --receipt <receipt.json>
--extension-id <id> --extension-version <version> --extension-mode <mode>`. It
requires an explicitly pinned known runtime and exact build identity, rejecting
unknown/missing identity or mismatched fields. It reads no private source records.

For accepted requests, the controller freezes `{documentId, generation, epoch}`.
Async success and failure paths compare all three values immediately before
delivery and reuse the frozen values in the envelope. Rebuild is an explicit
identity transition: it may publish the returned snapshot only after all three
returned values match the session's current snapshot.
Recovery admission and summary broadcasts use the same complete tuple.
Broadcast callers provide the summary's own identity, and delayed per-panel
delivery rechecks it; a current envelope never wraps a stale summary.

## Evidence

Build-helper tests cover canonical digests, tampered/invalid manifests, missing
and duplicate runtime bindings, mixed bundle identities, changed bundle bytes,
stale dist and source mutation during real esbuild compilation. Controlled CJS
and IIFE tests compare strict receiver and undeclared-assignment behavior with
and without the identity plugin. Startup and
harness-verifier tests cover exact
identity acceptance, missing/mismatched rejection and the same production
bundle in production/development/test hosts. Deferred-result tests cover same
generation, new epoch and late success/failure without timers. Tests construct
the real document class to check recovery, progress and broadcast boundaries.
Full type, test, contract, formatting, documentation and production build gates
remain required.

## Boundary

Execution identity records a digest of the selected bounded repository build
inputs. The static verifier checks the complete canonical declaration, manifest
and inventory byte consistency; it does not prove that arbitrary JavaScript
consumes that declaration. An actor able to rewrite bundles and recompute the
unsigned inventory can create a different self-consistent artifact. Generator
source and trusted generated-fixture execution cover the controlled import
connection; real-host receipts provide a separate runtime readback. Source
matching is a separate selected-checkout packaging gate. These checks are neither
a signature nor proof that arbitrary JavaScript is benign.
runtimeIdentity reports host API
metadata and does not cryptographically attest installation. Neither identity
attests the operating system, VS Code binary or
native addon; release provenance retains those owners. Output receipts contain
no source record, prompt, media, credential or absolute path.

## Revisit Trigger

Revisit when the build gains another runtime bundle, source inputs leave the
bounded repository set, a signed attestation replaces local manifests, or the
wire protocol makes epoch mandatory.

## Rollback

Revert the generated identity module, manifest distribution entry and startup
receipt field together. Retain all-three request correlation; reverting it would
reintroduce cross-epoch relabeling.
