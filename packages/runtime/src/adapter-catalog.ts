export const AGENT_ADAPTER_SCHEMA = 'jsonlview.agent-adapter.v1' as const;
export const PLUGIN_CATALOG_SCHEMA = 'jsonlview.plugin-catalog-entry.v1' as const;
export const GENERIC_ACP_ADAPTER_ID = 'generic.acp-v1' as const;
export const JSONLVIEW_MCP_ADAPTER_ID = 'jsonlview.mcp-read-only' as const;

export type AgentProtocol = 'acp' | 'mcp';
export type AdapterTransport = 'stdio' | 'streamable-http';
export type AdapterExecutionTarget = 'local' | 'wsl' | 'ssh';
export type AdapterCapability =
  | 'acp.prompt'
  | 'mcp.tools.list'
  | 'mcp.tools.call'
  | 'mcp.tools.call.read-only'
  | 'mcp.resources.read'
  | 'plugin.metadata'
  | 'skill.instructions';

export interface AgentAdapterDescriptor {
  readonly schema: typeof AGENT_ADAPTER_SCHEMA;
  readonly id: string;
  readonly protocol: AgentProtocol;
  readonly protocolVersions: readonly string[];
  readonly transports: readonly AdapterTransport[];
  readonly executionTargets: readonly AdapterExecutionTarget[];
  readonly capabilities: readonly AdapterCapability[];
  readonly provenance: {
    readonly kind: 'builtin' | 'provider' | 'plugin';
    readonly sourceId: string;
    readonly revision?: string;
    readonly digestSha256?: string;
  };
}

export interface PluginCatalogEntry {
  readonly schema: typeof PLUGIN_CATALOG_SCHEMA;
  readonly id: string;
  readonly publisher: string;
  readonly source: {
    readonly uri: string;
    readonly revision: string;
    readonly digestSha256: string;
  };
  readonly adapterIds: readonly string[];
  readonly skills: readonly {
    readonly id: string;
    readonly relativePath: string;
  }[];
  readonly enabled: false;
}

const ACP_VERSIONS = new Set(['1', '2']);
const MCP_VERSIONS = new Set(['2025-06-18', '2025-11-25', '2026-07-28']);
const CAPABILITIES = new Set<AdapterCapability>([
  'acp.prompt',
  'mcp.tools.list',
  'mcp.tools.call',
  'mcp.tools.call.read-only',
  'mcp.resources.read',
  'plugin.metadata',
  'skill.instructions',
]);
const ADAPTER_FIELDS = new Set([
  'schema', 'id', 'protocol', 'protocolVersions', 'transports', 'executionTargets', 'capabilities', 'provenance',
]);

export function validateAgentAdapterDescriptor(value: unknown): AgentAdapterDescriptor {
  const record = asRecord(value, 'adapter descriptor');
  rejectExtraFields(record, ADAPTER_FIELDS, 'adapter descriptor');
  if (record.schema !== AGENT_ADAPTER_SCHEMA) throw new Error('Unsupported adapter descriptor schema');
  const id = boundedId(record.id, 'adapter id');
  const protocol = enumValue(record.protocol, ['acp', 'mcp'] as const, 'protocol');
  const protocolVersions = uniqueList<string>(record.protocolVersions, 'protocol version', 8, (item) => {
    if (typeof item !== 'string') throw new Error('Invalid protocol version');
    const supported = protocol === 'acp' ? ACP_VERSIONS : MCP_VERSIONS;
    if (!supported.has(item)) throw new Error(`Unsupported protocol version: ${item}`);
    return item;
  });
  if (protocolVersions.length === 0) throw new Error('At least one protocol version is required');

  const transports = uniqueList<AdapterTransport>(record.transports, 'transport', 2, (item) => {
    if (item !== 'stdio' && item !== 'streamable-http') throw new Error(`Unsupported transport: ${item}`);
    if (protocol === 'acp' && item !== 'stdio') throw new Error(`Unsupported ACP transport: ${item}`);
    return item;
  });
  if (transports.length === 0) throw new Error('At least one transport is required');

  const executionTargets = uniqueList<AdapterExecutionTarget>(record.executionTargets, 'execution target', 3, (item) => {
    if (item !== 'local' && item !== 'wsl' && item !== 'ssh') throw new Error(`Unsupported execution target: ${item}`);
    return item;
  });
  if (executionTargets.length === 0) throw new Error('At least one execution target is required');

  const capabilities = uniqueList<AdapterCapability>(record.capabilities, 'capability', 16, (item) => {
    if (typeof item !== 'string' || !CAPABILITIES.has(item as AdapterCapability)) throw new Error(`Unsupported adapter capability: ${String(item)}`);
    if (protocol === 'acp' && item !== 'acp.prompt') throw new Error(`Capability does not belong to ACP: ${item}`);
    if (protocol === 'mcp' && item === 'acp.prompt') throw new Error(`Capability does not belong to MCP: ${item}`);
    return item as AdapterCapability;
  });

  const provenance = asRecord(record.provenance, 'adapter provenance');
  rejectExtraFields(provenance, new Set(['kind', 'sourceId', 'revision', 'digestSha256']), 'adapter provenance');
  const kind = enumValue(provenance.kind, ['builtin', 'provider', 'plugin'] as const, 'provenance kind');
  const sourceId = boundedId(provenance.sourceId, 'provenance source id');
  const revision = optionalText(provenance.revision, 'provenance revision');
  const digestSha256 = optionalDigest(provenance.digestSha256);
  if (kind === 'plugin' && (revision === undefined || digestSha256 === undefined)) {
    throw new Error('Plugin adapters require an immutable revision and SHA-256 digest');
  }

  return Object.freeze({
    schema: AGENT_ADAPTER_SCHEMA,
    id,
    protocol,
    protocolVersions: Object.freeze(protocolVersions),
    transports: Object.freeze(transports),
    executionTargets: Object.freeze(executionTargets),
    capabilities: Object.freeze(capabilities),
    provenance: Object.freeze({
      kind,
      sourceId,
      ...(revision === undefined ? {} : { revision }),
      ...(digestSha256 === undefined ? {} : { digestSha256 }),
    }),
  });
}

export function validatePluginCatalogEntry(value: unknown): PluginCatalogEntry {
  const record = asRecord(value, 'plugin catalog entry');
  rejectExtraFields(record, new Set(['schema', 'id', 'publisher', 'source', 'adapterIds', 'skills']), 'plugin catalog entry');
  if (record.schema !== PLUGIN_CATALOG_SCHEMA) throw new Error('Unsupported plugin catalog schema');
  const id = boundedId(record.id, 'plugin id');
  const publisher = boundedText(record.publisher, 'plugin publisher', 128);
  const source = asRecord(record.source, 'plugin source');
  rejectExtraFields(source, new Set(['uri', 'revision', 'digestSha256']), 'plugin source');
  const uri = boundedText(source.uri, 'plugin source URI', 2048);
  let parsedUri: URL;
  try { parsedUri = new URL(uri); } catch { throw new Error('Plugin source URI must be a pinned HTTPS URL'); }
  if (parsedUri.protocol !== 'https:' || parsedUri.username.length > 0 || parsedUri.password.length > 0 || parsedUri.search.length > 0 || parsedUri.hash.length > 0) {
    throw new Error('Plugin source URI must be a pinned HTTPS URL without inline credentials or selectors');
  }
  const revision = boundedText(source.revision, 'plugin revision', 40);
  if (!/^[a-f0-9]{40}$/iu.test(revision)) throw new Error('Plugin source requires a full 40-character immutable commit SHA');
  const digestSha256 = requiredDigest(source.digestSha256, 'plugin source SHA-256 digest');
  const adapterIds = uniqueList<string>(record.adapterIds, 'adapter id', 64, (item) => boundedId(item, 'adapter id'));
  const skills = uniqueList<PluginCatalogEntry['skills'][number]>(record.skills, 'skill', 64, (item) => {
    const skill = asRecord(item, 'plugin skill');
    rejectExtraFields(skill, new Set(['id', 'relativePath']), 'plugin skill');
    const skillId = boundedId(skill.id, 'skill id');
    const relativePath = boundedText(skill.relativePath, 'skill relative path', 512);
    if (relativePath.includes('\\') || relativePath.includes(':') || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error('Plugin skill requires a safe relative path');
    }
    return { id: skillId, relativePath };
  });
  return Object.freeze({
    schema: PLUGIN_CATALOG_SCHEMA,
    id,
    publisher,
    source: Object.freeze({ uri: parsedUri.toString(), revision: revision.toLowerCase(), digestSha256 }),
    adapterIds: Object.freeze(adapterIds),
    skills: Object.freeze(skills.map((skill) => Object.freeze(skill))),
    enabled: false,
  });
}

export const BUILTIN_AGENT_ADAPTERS: readonly AgentAdapterDescriptor[] = Object.freeze([
  validateAgentAdapterDescriptor({
    schema: AGENT_ADAPTER_SCHEMA,
    id: GENERIC_ACP_ADAPTER_ID,
    protocol: 'acp',
    protocolVersions: ['1'],
    transports: ['stdio'],
    executionTargets: ['local'],
    capabilities: ['acp.prompt'],
    provenance: { kind: 'builtin', sourceId: 'jsonlview.generic-acp' },
  }),
  validateAgentAdapterDescriptor({
    schema: AGENT_ADAPTER_SCHEMA,
    id: JSONLVIEW_MCP_ADAPTER_ID,
    protocol: 'mcp',
    protocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
    transports: ['stdio'],
    executionTargets: ['local'],
    capabilities: ['mcp.tools.list', 'mcp.tools.call.read-only', 'mcp.resources.read'],
    provenance: { kind: 'builtin', sourceId: 'jsonlview.mcp-server' },
  }),
]);

export function findBuiltinAgentAdapter(id: string): AgentAdapterDescriptor | undefined {
  return BUILTIN_AGENT_ADAPTERS.find((adapter) => adapter.id === id);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function rejectExtraFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`Unexpected field in ${label}: ${key}`);
}

function boundedId(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, 128);
}

function enumValue<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Invalid ${label}`);
  return value as T;
}

function uniqueList<T>(value: unknown, label: string, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid ${label} list`);
  const result = value.map(parse);
  const identities = result.map((item) => JSON.stringify(item));
  if (new Set(identities).size !== identities.length) throw new Error(`Duplicate ${label}`);
  return result;
}

function optionalDigest(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredDigest(value, 'provenance SHA-256 digest');
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}
