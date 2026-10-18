export declare function abiVersion(): number;

export declare function capabilities(): number;

export declare function scanLf(input: Uint8Array, start: number, limit: number): Uint32Array;

export declare function mcpManagerCapability(): number;

export declare class McpManager {
  constructor(maxPayloadBytes?: number);
  beginConnection(): string;
  acceptInitialize(serverProtocolVersion: string): string;
  retryLegacyConnection(protocolVersion?: string): string;
  prepareDiagnostic(stage: string, name: string, message: string): string;
  completeRequest(): void;
  failRequest(): void;
  close(): void;
  state(): string;
  protocolVersion(): string;
}
