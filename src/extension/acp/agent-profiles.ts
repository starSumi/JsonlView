import { findBuiltinAgentAdapter, GENERIC_ACP_ADAPTER_ID } from '@runtime/adapter-catalog';

export interface AcpAgentProfile {
  readonly id: string;
  readonly adapterId: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly executionTarget: 'local';
  readonly protocolVersion: '1';
  readonly transport: 'stdio';
}

export interface AcpAgentProfilesResult {
  readonly configured: boolean;
  readonly invalidCount: number;
  readonly profiles: readonly AcpAgentProfile[];
}

export interface AcpAgentProfilesInput {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly timeoutMs?: unknown;
  readonly profiles?: unknown;
}

const MAX_PROFILES = 16;
const MAX_ARGS = 64;
const MAX_ARGUMENT_BYTES = 4096;

/** Reads declarative local ACP stdio profiles and maps old single-agent settings. */
export function readAcpAgentProfiles(input: AcpAgentProfilesInput): AcpAgentProfilesResult {
  if (input.profiles === undefined) {
    const legacy = parseProfile({
      id: 'legacy',
      adapterId: GENERIC_ACP_ADAPTER_ID,
      label: 'Configured ACP agent',
      command: input.command,
      args: input.args ?? [],
      timeoutMs: input.timeoutMs ?? 10_000,
      executionTarget: 'local',
      protocolVersion: '1',
      transport: 'stdio',
    });
    return { configured: false, invalidCount: legacy === undefined && hasValue(input.command) ? 1 : 0, profiles: legacy === undefined ? [] : [legacy] };
  }

  if (!Array.isArray(input.profiles) || input.profiles.length > MAX_PROFILES) {
    return { configured: true, invalidCount: 1, profiles: [] };
  }
  const parsed = input.profiles.map(parseProfile);
  const counts = new Map<string, number>();
  for (const profile of parsed) {
    if (profile === undefined) continue;
    counts.set(profile.id, (counts.get(profile.id) ?? 0) + 1);
  }
  const profiles: AcpAgentProfile[] = [];
  let invalidCount = 0;
  for (const profile of parsed) {
    if (profile === undefined || counts.get(profile.id) !== 1) {
      invalidCount++;
      continue;
    }
    profiles.push(profile);
  }
  return { configured: true, invalidCount, profiles };
}

function parseProfile(value: unknown): AcpAgentProfile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['id', 'adapterId', 'label', 'command', 'args', 'timeoutMs', 'executionTarget', 'protocolVersion', 'transport']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  const id = boundedText(record.id, 128);
  const adapterId = boundedText(record.adapterId ?? GENERIC_ACP_ADAPTER_ID, 128);
  const label = boundedText(record.label, 128);
  const command = boundedText(record.command, 4096);
  const args = record.args;
  const timeoutMs = record.timeoutMs;
  const adapter = adapterId === undefined ? undefined : findBuiltinAgentAdapter(adapterId);
  if (id === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(id) || adapterId === undefined || adapter?.protocol !== 'acp' ||
      !adapter.protocolVersions.includes('1') || !adapter.transports.includes('stdio') || !adapter.executionTargets.includes('local') ||
      label === undefined || command === undefined ||
      !Array.isArray(args) || args.length > MAX_ARGS || args.some((argument) => typeof argument !== 'string' || Buffer.byteLength(argument, 'utf8') > MAX_ARGUMENT_BYTES || argument.includes('\0')) ||
      typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000 ||
      (record.executionTarget !== undefined && record.executionTarget !== 'local') ||
      (record.protocolVersion !== undefined && record.protocolVersion !== '1') ||
      (record.transport !== undefined && record.transport !== 'stdio')) return undefined;
  return {
    id,
    adapterId,
    label,
    command,
    args: [...args] as string[],
    timeoutMs,
    executionTarget: 'local',
    protocolVersion: '1',
    transport: 'stdio',
  };
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) return undefined;
  return value.trim();
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
