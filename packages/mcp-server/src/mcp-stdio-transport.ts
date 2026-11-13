import type { Readable, Writable } from 'node:stream';
import { MCP_READ_ONLY_MAX_LINE_BYTES, type McpLineTransport } from './mcp-read-only-server.js';

/** Owns newline framing and stream closure, without interpreting protocol messages. */
export function createMcpStdioTransport(input: Readable, output: Writable, onClosed: () => void): McpLineTransport {
  let closed = false;
  const close = (): void => { if (!closed) { closed = true; input.pause(); onClosed(); } };
  input.once('end', close); input.once('close', close); input.on('error', close);
  output.on('error', close); output.once('close', close);
  return {
    sendLine: (line) => new Promise<void>((resolve, reject) => {
      if (closed || output.destroyed || output.writableEnded) { reject(new Error('MCP output is closed.')); return; }
      output.write(`${line}\n`, (error) => { if (error) { close(); reject(error); } else resolve(); });
    }),
    onLine: (listener) => {
      let buffer = ''; let bytes = 0; let discarding = false;
      input.setEncoding('utf8');
      const onData = (chunk: string): void => {
        let offset = 0;
        while (offset < chunk.length && !closed) {
          const newline = chunk.indexOf('\n', offset);
          const end = newline < 0 ? chunk.length : newline;
          const part = chunk.slice(offset, end);
          if (!discarding) {
            bytes += Buffer.byteLength(part, 'utf8');
            if (bytes > MCP_READ_ONLY_MAX_LINE_BYTES) {
              // A fixed over-limit sentinel triggers one protocol size error. Never reframe the suffix.
              discarding = true; buffer = ''; bytes = 0;
              listener(' '.repeat(MCP_READ_ONLY_MAX_LINE_BYTES + 1));
            } else buffer += part;
          }
          if (newline < 0) break;
          if (!discarding && buffer.length > 0) listener(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
          buffer = ''; bytes = 0; discarding = false; offset = end + 1;
        }
      };
      input.on('data', onData);
      return () => { input.off('data', onData); buffer = ''; bytes = 0; };
    },
  };
}


