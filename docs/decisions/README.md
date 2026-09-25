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

Every ADR uses the same fields: pressure, invariant, owner, alternatives,
probe, decision, evidence, boundary, revisit trigger, and rollback.
