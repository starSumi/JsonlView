# Security Threat Model

## Scope and assets

The model covers the VS Code Extension Host, its sandboxed Webview, local
JSONL/NDJSON source files, the disposable index, the optional native scanner,
Session Navigator provider roots, and bounded diagnostic handoff to VS Code.
The source JSONL remains provider-owned and read-only.

## Ownership and Evidence

Product engineering owns this threat model, the controls named here, and the
negative tests that protect them. Validation produces immutable receipts for
host or release observations. Private paths, transcript bodies, screenshots,
raw logs, and incident timelines are never copied into this document; a
receipt ID may be cited as an audit pointer only.

## Trust boundaries

1. A local source file crosses into the bounded engine as untrusted bytes.
2. The Extension Host crosses into the Webview through versioned messages.
3. The Webview crosses into the host through validated requests.
4. The host crosses into the optional native addon through an ABI and
   capability contract.
5. A diagnostic may be handed to another VS Code surface only after bounded
   redaction and explicit user action.

## Threat and control map

| Threat class | Example | Product controls | Required evidence |
| --- | --- | --- | --- |
| Spoofing / elevation | forged Webview request or source identity | protocol version, document identity, generation and request validation | malformed and wrong-document tests |
| Tampering | source replacement during read or stale response after rebuild | source fingerprint, disposable generations, cancellation fencing | replacement, cancellation and stale-response tests |
| Repudiation | ambiguous release or diagnostic event | bounded output log, request IDs, provenance manifests | host/release readback |
| Information disclosure | prompt, local path, or record body copied into diagnostics | bounded redaction, read-only projections, explicit handoff | diagnostic redaction tests |
| Denial of service | oversized record, unbounded scan, or non-progressing cursor | byte/row budgets, pagination guards, abort signals | oversized and no-progress tests |
| Native execution risk | missing, incompatible, or invalid addon output | ABI/capability checks, offset validation, process fuse, Node fallback | native load/call failure tests |
| Agent-specific injection | hostile text in a local transcript influencing a user action | render as data, no implicit tool execution, explicit user gesture for handoff | fixture and UI acceptance review |
| Path escape | source root or asset path leaves its allowlist | resolved-root checks and Webview `localResourceRoots` | path traversal and untrusted-workspace tests |

The model uses STRIDE categories for system boundaries and the MITRE ATLAS
knowledge base as an additional vocabulary for AI-specific abuse cases. It does
not claim that JsonlView is an AI service or that every ATLAS technique applies.

## Security invariants

- No network transport, arbitrary command execution, source mutation, or
  provider database write is introduced by the read-only viewer.
- The Webview CSP, nonce, resource roots, and message validation remain in
  force; any relaxation requires a separate decision and negative test.
- Native failures degrade to the portable scanner and never become a reason to
  trust unchecked offsets or unbounded memory.
- Harness fixtures and private runtime evidence never enter this product docs
  tree or a release archive.

## References

- [MITRE ATLAS](https://atlas.mitre.org/)
- [Microsoft STRIDE threat categories](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats)
- [VS Code Webview security](https://code.visualstudio.com/api/extension-guides/webview#content-security-policy)
