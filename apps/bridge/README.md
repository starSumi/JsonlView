# Private JSON-RPC Tunnel

This opt-in process exposes an authenticated WebSocket tunnel at
`/rpc-tunnel`. It forwards bounded newline-delimited JSON-RPC messages to one
explicitly configured child process. It does not implement MCP, ACP, their
initialization or session lifecycles, or protocol version negotiation.

The default listener is `127.0.0.1`. Starting the process requires
`JSONLVIEW_BRIDGE_TOKEN`; the child command can be supplied through
`JSONLVIEW_TUNNEL_COMMAND` and its JSON string-array arguments through
`JSONLVIEW_TUNNEL_ARGS`. The tunnel is experimental and is not an enabled
product integration. Use a protocol implementation with its native transport
when an MCP or ACP endpoint is required.
