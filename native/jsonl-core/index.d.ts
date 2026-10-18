export declare function abiVersion(): number;

export declare function capabilities(): number;

export declare function scanLf(input: Uint8Array, start: number, limit: number): Uint32Array;

export declare function mcpManagerCapability(): number;

/** Bounded, read-only JSONL page query. Offsets and cursors are decimal strings. */
export declare function queryRecords(
  sourcePath: string,
  startOrdinal?: string,
  limit?: number,
  maxBytes?: number,
): string;

/** Compatibility alias for queryRecords. */
export declare function queryJsonl(
  sourcePath: string,
  startOrdinal?: string,
  limit?: number,
  maxBytes?: number,
): string;

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
