# JsonlView MCP server package

`@jsonlview/mcp-server` is the independent, read-only Node.js MCP server and
library for explicitly granted JSONL files. The package is currently private;
this work does not publish or install it. The extension sidecar and this package
share the package-owned bounded JSON-RPC server, stdio framing, configuration
parser, and MCP trajectory wire contracts. Each surface supplies its own
authorized source/query adapter. This package uses the portable asynchronous
reader and does not load the VS Code extension or a native addon.

Build and run the CLI from this workspace:

```text
pnpm --filter @jsonlview/mcp-server build
node packages/mcp-server/dist/cli.js --source work=C:/data/session.jsonl
```

The `jsonlview-mcp` executable accepts one or more repeatable
`--source <opaque-id>=<absolute-file-path>` grants, an optional `--budget-ms`
from 1 through 60000, and `--max-concurrency` from 1 through 8. Source paths are
canonicalized and checked as regular files before stdio starts. MCP tools
receive only the registered source IDs; paths are rejected from tool arguments
and never returned. The launch arguments contain the explicit source paths and
may be visible through local process inspection. Standard output is reserved for JSON-RPC after startup;
configuration errors go to standard error before the server starts. EOF,
SIGINT, SIGTERM, and output failure stop the connection and cancel pending
reads.

The library exports `createMcpServer` from the package root and
`@jsonlview/mcp-server/runtime`. Call it with explicit source registrations and
Node readable/writable streams; then call `start()` on the returned server.
`stop()` is idempotent and closes the protocol lifecycle. The package implements
MCP `2026-07-28` and the legacy `2025-11-25` and `2025-06-18` protocol versions.
Platform support beyond the tested Windows workspace is not yet qualified.

Validation runs the built executable over real child-process stdio:

```text
pnpm --filter @jsonlview/mcp-server typecheck
pnpm --filter @jsonlview/mcp-server test
```
