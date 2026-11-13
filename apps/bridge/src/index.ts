import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, type WebSocket } from 'ws';
import { RUNTIME_LIMITS } from '@jsonlview/runtime';

export interface BridgeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly allowedHosts?: readonly string[];
  readonly maxConnections?: number;
}

const MAX_BODY = RUNTIME_LIMITS.maxFrameBytes;
const MAX_CONNECTIONS = 4;
const TUNNEL_PATH = '/rpc-tunnel';

interface TunnelSession {
  readonly socket: WebSocket;
  readonly child: ChildProcessWithoutNullStreams;
  readonly onSocketClose: () => void;
  closed: boolean;
  queuedBytes: number;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) });
  response.end(bytes);
};

function requestHost(request: IncomingMessage): string | undefined {
  try {
    return new URL(`http://${request.headers.host ?? ''}`).hostname;
  } catch {
    return undefined;
  }
}

function isAuthorized(request: IncomingMessage, token: string, hosts: readonly string[]): boolean {
  const host = requestHost(request);
  if (host === undefined || !hosts.includes(host)) return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (!hosts.includes(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return request.headers.authorization === `Bearer ${token}`;
}

function isJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') return false;
  if (typeof message.method === 'string' && message.method.length > 0) {
    return !('id' in message) || typeof message.id === 'string' || typeof message.id === 'number' || message.id === null;
  }
  return typeof message.id === 'string' || typeof message.id === 'number' || message.id === null;
}

export function createBridgeServer(options: BridgeOptions) {
  if (typeof options.token !== 'string' || options.token.length === 0) throw new Error('Bridge token is required');
  if (typeof options.command !== 'string' || options.command.length === 0) throw new Error('Tunnel command is required');
  const hosts = options.allowedHosts ?? ['127.0.0.1', 'localhost'];
  const limit = options.maxConnections ?? MAX_CONNECTIONS;
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('Invalid tunnel connection limit');
  let active = 0;
  const sessions = new Set<TunnelSession>();

  const http = createServer((_request, response) => json(response, 404, { error: 'Not found' }));
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false });

  const closeSession = (session: TunnelSession): void => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session);
    active = Math.max(0, active - 1);
    session.socket.off('close', session.onSocketClose);
    if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill('SIGTERM');
  };

  http.on('upgrade', (request, socket, head) => {
    if (request.url !== TUNNEL_PATH || active >= limit || !isAuthorized(request, options.token!, hosts)) {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(options.command, [...(options.args ?? [])], {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
      } catch {
        webSocket.close(1011, 'Tunnel process could not start');
        return;
      }

      const session = {} as TunnelSession;
      const onSocketClose = (): void => closeSession(session);
      Object.assign(session, { socket: webSocket, child, onSocketClose, closed: false, queuedBytes: 0 });
      sessions.add(session);
      active++;

      const send = (value: unknown): void => {
        if (session.closed || webSocket.readyState !== webSocket.OPEN) return;
        const bytes = Buffer.from(JSON.stringify(value), 'utf8');
        if (bytes.byteLength > MAX_BODY || session.queuedBytes + bytes.byteLength > RUNTIME_LIMITS.maxQueuedBytes ||
            webSocket.bufferedAmount > RUNTIME_LIMITS.maxQueuedBytes) {
          webSocket.close(1013, 'Tunnel backpressure limit');
          return;
        }
        session.queuedBytes += bytes.byteLength;
        webSocket.send(bytes, (error) => {
          session.queuedBytes = Math.max(0, session.queuedBytes - bytes.byteLength);
          if (error !== undefined) closeSession(session);
        });
      };

      const decoder = new StringDecoder('utf8');
      let stdoutBuffer = '';
      child.stdout.on('data', (chunk: Buffer) => {
        const text = stdoutBuffer + decoder.write(chunk);
        const lines = text.split(/\r?\n/u);
        stdoutBuffer = lines.pop() ?? '';
        if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_BODY) {
          webSocket.close(1009, 'Tunnel frame too large');
          return;
        }
        for (const line of lines) {
          if (Buffer.byteLength(line, 'utf8') > MAX_BODY) {
            webSocket.close(1009, 'Tunnel frame too large');
            return;
          }
          try { send(JSON.parse(line) as unknown); }
          catch { webSocket.close(1007, 'Tunnel process emitted invalid JSON'); }
        }
      });
      child.stderr.resume();
      child.on('error', () => webSocket.close(1011, 'Tunnel process failed'));
      child.on('close', () => {
        closeSession(session);
        if (webSocket.readyState === webSocket.OPEN) webSocket.close(1011, 'Tunnel process exited');
      });
      webSocket.on('close', onSocketClose);
      webSocket.on('message', (data) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data as Buffer[])
          : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
        if (bytes.byteLength > MAX_BODY) {
          webSocket.close(1009, 'Tunnel frame too large');
          return;
        }
        let message: unknown;
        try { message = JSON.parse(bytes.toString('utf8')) as unknown; }
        catch {
          webSocket.close(1007, 'Invalid JSON');
          return;
        }
        if (!isJsonRpcMessage(message)) {
          webSocket.close(1007, 'Invalid JSON-RPC message');
          return;
        }
        const line = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
        if (child.stdin.writableLength + line.byteLength > RUNTIME_LIMITS.maxQueuedBytes) {
          webSocket.close(1013, 'Tunnel input backpressure limit');
          return;
        }
        try { child.stdin.write(line); }
        catch { webSocket.close(1011, 'Tunnel process input failed'); }
      });
      webSocket.on('error', () => closeSession(session));
    });
  });

  return {
    http,
    listen: () => new Promise<void>((resolve, reject) => {
      http.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve()).once('error', reject);
    }),
    close: () => new Promise<void>((resolve) => {
      for (const session of [...sessions]) {
        closeSession(session);
        if (session.socket.readyState === session.socket.OPEN) session.socket.terminate();
      }
      webSockets.close();
      http.close(() => resolve());
    }),
    address: () => http.address(),
  };
}
