# JsonlView Decisions

These records capture durable engineering choices for the product. They are
short by design: implementation detail belongs in source and tests, while
volatile measurements and release evidence belong in `JsonlView-harness`.

Read these before changing a shared boundary:

1. [ADR-001 format and profile boundary](001-format-profile-boundary.md)
2. [ADR-002 generations and follow handoff](002-generations-and-follow.md)
3. [ADR-003 native acceleration](003-native-acceleration.md)
4. [ADR-004 Webview rendering](004-webview-rendering.md)
5. [ADR-005 release provenance](005-release-provenance.md)
6. [ADR-006 Claude surface strategies](006-claude-surface-strategies.md)
7. [ADR-007 source-backed format discovery](007-source-backed-format-discovery.md)
8. [ADR-008 promotion synchronization](008-promotion-synchronization.md)
9. [ADR-009 automatic update boundary](009-automatic-update-boundary.md)
10. [ADR-010 development toolchain baseline](010-toolchain-baseline.md)
11. [ADR-011 runtime topology and refactor shape](011-runtime-topology-and-refactor-shape.md)
12. [ADR-012 registry extension identities](012-registry-extension-identities.md)
13. [ADR-013 bounded mixed-code highlighting](013-bounded-mixed-code-highlighting.md)
14. [ADR-014 large module boundary governance](014-large-module-boundary-governance.md)
15. [ADR-015 curated release-note CI guard](015-changelog-ci-guard.md)
16. [ADR-016 OTLP metrics and columnar format gates](016-otlp-metrics-and-columnar-format-gates.md)
17. [ADR-017 physical order paging and incomplete results](017-physical-order-paging.md)
18. [ADR-018 accepted Webview snapshot identity](018-accepted-webview-snapshot-identity.md)
19. [ADR-019 Webview query and keyboard ownership](019-webview-query-and-keyboard-ownership.md)
20. [ADR-020 read-only indexing status strip](020-read-only-indexing-status-strip.md)
21. [ADR-021 explicit row-order toggle](021-explicit-row-order-toggle.md)
22. [ADR-022 read-only agent-history adapter roadmap](022-read-only-agent-history-adapter-roadmap.md)
23. [ADR-023 keyless target-separated publication](023-keyless-target-separated-publication.md)
24. [ADR-023 native build reproducibility](023-native-build-reproducibility.md)
25. [ADR-024 VSIX archive reproducibility](024-vsix-archive-reproducibility.md)
26. [ADR-025 staged mutation and local agent navigation](025-experimental-staged-mutation-and-local-mcp.md)
27. [ADR-026 opt-in read-only navigation prototype](026-read-only-navigation-prototype.md)
28. [ADR-027 synthetic provider and navigation index contract](027-synthetic-provider-index-contract.md)
29. [ADR-028 staged mutation benchmark](028-staged-mutation-benchmark.md)
30. [ADR-029 opt-in Session Navigator TreeView and local catalog](029-opt-in-session-navigator-treeview.md)
31. [ADR-030 provider-native Session Navigator contract](030-provider-native-session-navigator-contract.md)
32. [ADR-031 session loading, native metadata, and source intake](031-session-navigator-intake-and-loading.md)
33. [ADR-032 bounded session pagination](032-bounded-session-pagination.md)
34. [ADR-033 bounded Webview diagnostics](033-bounded-webview-diagnostics.md)
35. [ADR-034 opt-in OTLP observability boundary](034-opt-in-otlp-observability.md)
36. [ADR-035 runtime-bounded decomposition and toolchain ownership](035-architecture-decomposition-and-toolchain-ownership.md)
37. [ADR-036 pi coding agent session adapter](036-pi-coding-agent-adapter.md)

Every ADR uses the same fields: pressure, invariant, owner, alternatives,
probe, decision, evidence, boundary, revisit trigger, and rollback.
