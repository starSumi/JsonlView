import { resolve, dirname } from 'node:path';
import { loadRustQueryBridge, createMcpRustQueryHandler } from './rust-query-bridge.js';
import { McpReadOnlyServer } from './mcp-read-only-server.js';
import { createMcpStdioTransport } from './mcp-stdio-transport.js';
import { parseMcpServerLimits } from './mcp-server-config.js';
import { createMcpTrajectoryHandlers } from './mcp-trajectory-tools.js';
const sourceId=process.env.JSONLVIEW_MCP_SOURCE_ID; const sourcePath=process.env.JSONLVIEW_MCP_SOURCE_PATH;
if(!sourceId||!sourcePath){process.stderr.write('JsonlView MCP server requires explicit source identity and path.\n');process.exitCode=2;}
else { const limits=parseMcpServerLimits(process.env); const extensionRoot=process.env.JSONLVIEW_EXTENSION_PATH??resolve(dirname(process.argv[1]??process.cwd()),'..'); const bridge=loadRustQueryBridge(extensionRoot,[resolve(sourcePath,'..')]); const sources=new Map([[sourceId,sourcePath]]); let server!:McpReadOnlyServer; const transport=createMcpStdioTransport(process.stdin,process.stdout,()=>server.stop()); server=new McpReadOnlyServer({transport,cancellationMode:'cooperative',budgetMs:limits.budgetMs,maxConcurrency:limits.maxConcurrency,maxQueuedRequests:8,...createMcpTrajectoryHandlers({sources,allowedRoots:[resolve(sourcePath,'..')],legacyQuery:createMcpRustQueryHandler(bridge,sources,{preferPortable:true})})}); server.start(); }
