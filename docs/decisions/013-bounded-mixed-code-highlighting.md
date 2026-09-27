# ADR-013: Bounded Mixed-Code Highlighting

Status: accepted

## Pressure

Agent events can contain shell commands, PowerShell, TypeScript or JavaScript,
and explicit `apply_patch` documents that mix an outer shell invocation with
per-file code. Plain formatting is not enough, but a general-purpose editor
runtime would add bundle, memory, CSP, and rendering costs to a bounded detail
view.

## Invariant

Highlighting is a display-only projection. It never executes, rewrites, or
replaces source text; unknown syntax remains source; work is bounded by the
existing character and token budgets; and Raw/Copy remain authoritative.

## Owner

`src/webview/code-syntax.tsx` owns lexical display classification.
`src/webview/event-presentation.tsx` enables patch mode only for a structured
`exec_command` whose command explicitly starts an `apply_patch` envelope.
`src/webview/diff-view.tsx` continues to own structured diff presentation.

## Alternatives

- VS Code TextMate grammars: not used in the Webview. The official grammar
  contribution point targets editor language tokenization; a custom Webview
  does not inherit those grammars automatically.
- Semantic tokens: not used. They enrich editor documents and do not tokenize
  transient command strings rendered as DOM.
- Shiki, Prism, or Tree-sitter: deferred. Their runtime, grammar/parser assets,
  CSP integration, and DOM cost are not justified without measured need.
- A language server: rejected for display-only snippets; it adds lifecycle and
  protocol surface without owning an editable document.

## Probe

Keep scanner behavior linear in visible input, cap output at 128 KiB and 12,000
tokens, preserve exact text across CRLF and truncation, test incomplete patch
fallback, and verify shell/PowerShell/TypeScript roles plus nested patch files.
Revisit only with representative fixture and host frame/memory evidence.

## Decision

Extend the small Webview lexer with explicit JavaScript/TypeScript and
shell/PowerShell families, conservative command/function/type/variable/operator
roles, and a patch state machine. Patch mode requires a complete explicit
`apply_patch` envelope; each file header selects a bounded lexical family by
extension. Unknown files and malformed envelopes fall back to ordinary source
display. No dependency, IPC, native code, or runtime telemetry is added.

## Evidence

Focused Vitest coverage verifies token roles, exact reconstruction, explicit
patch activation, malformed fallback, CRLF, and token-budget behavior. Current
official API boundaries are described in the [VS Code syntax guide](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide),
the [semantic highlighting guide](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide),
and [Webview guide](https://code.visualstudio.com/api/extension-guides/webview).
Bundle and in-host acceptance remain separate validation gates.

## Boundary

This is a bounded lexical aid, not TextMate compatibility, a parser, LSP, or a
correctness signal. Heuristic command/function coloring may be incomplete.
The source string remains unchanged and selectable; unsupported languages stay
plain rather than being guessed.

## Revisit Trigger

Reconsider a grammar engine only if synthetic corpus coverage demonstrates
material misclassification and a measured bundle/frame/memory budget can be
met. Reconsider worker execution only if profiling shows the bounded scan
causes a Webview long task on supported hardware.

## Rollback

Pass `mode="code"` and/or remove the additional token categories. Keep the
source view, bounded preview, explicit full action, and structured `DiffView`
unchanged.
