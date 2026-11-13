import type { AgentRowProjection, FieldPath } from '@shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import { projectKimiAgentCoreEvent, projectKimiMessage } from './kimi-agent-core-projection';
import { isKimiAgentCoreRecord, isKimiMetadata, isKimiToolsSnapshot, kimiContentPreview, kimiTimestamp, kimiToolSnapshotCount, kimiUsage } from './kimi-record';
import { decodeKimiServerEvent, isKimiServerDetectionEvent, isKimiServerHeader } from './kimi-server-record';
import { projectKimiServerEvent, projectKimiServerHeader } from './kimi-server-projection';
import { boundedSummary, createProjection, evidence, indexedPath, isObject, keyPath, numberAt, objectAt, own, pushReason, setActor, setDerivedField as setRawDerivedField, setStringField as setRawStringField, stringAt } from './utils';

const CONTROL_TYPES = new Set(['context.clear', 'context.undo', 'context.undone', 'context.apply_compaction',
  'full_compaction.begin', 'full_compaction.cancel', 'full_compaction.complete']);

/** One projection per physical wire line; never replay, migrate, or execute a session. */
export class KimiCodeProfile implements AgentProfile {
  public readonly id = 'kimi-code-session';
  public readonly displayName = 'Kimi Code';
  public readonly version = '5';

  public detect(samples: readonly GenericRecordSample[]): DetectionResult {
    let headers = 0;
    let agentCoreRecords = 0;
    let serverHeaders = 0;
    let serverRecords = 0;
    let serverSpecificRecords = 0;
    const signatures = new Set<string>();
    const serverSignatures = new Set<string>();
    const reasons: DetectionResult['reasons'] = [];
    for (const sample of samples) {
      if (sample.parseState !== undefined && sample.parseState !== 'valid') continue;
      const serverEvent = decodeKimiServerEvent(sample.value);
      if (isKimiServerHeader(sample.value)) {
        serverHeaders++;
        pushReason(reasons, keyPath('version'), 'Kimi persisted server journal v1 header');
      } else if (serverEvent && isKimiServerDetectionEvent(serverEvent)) {
        serverRecords++;
        serverSignatures.add(serverEvent.type);
        if (serverEvent.type !== 'error' && serverEvent.type !== 'warning') serverSpecificRecords++;
        pushReason(reasons, keyPath('envelope', 'type'), 'Kimi server journal event: ' + serverEvent.type);
      } else if (isKimiMetadata(sample.value)) {
        headers++;
        pushReason(reasons, keyPath('protocol_version'), 'Kimi persisted wire metadata with a 1.x protocol version and creation clock');
      } else if (isKimiAgentCoreRecord(sample.value)) {
        agentCoreRecords++;
        const type = stringAt(sample.value, 'type')!;
        signatures.add(type === 'context.append_loop_event' ? `${type}/${stringAt(sample.value, 'event', 'type')}` : type);
        pushReason(reasons, keyPath('type'), 'Kimi agent-core wire event: ' + type);
      }
    }
    const coverage = (headers + agentCoreRecords + serverHeaders + serverRecords) / Math.max(1, samples.length);
    const corroborated = (headers > 0 && agentCoreRecords > 0) || (agentCoreRecords >= 3 && signatures.size >= 2)
      || (serverHeaders > 0 && serverRecords > 0)
      || (serverRecords >= 3 && serverSignatures.size >= 2 && serverSpecificRecords > 0);
    const requiredEvidenceMet = corroborated && coverage >= 0.6;
    const score = requiredEvidenceMet ? Math.min(0.99, 0.78 + 0.12 * coverage + (headers + serverHeaders > 0 ? 0.08 : 0)) : Math.min(0.6, coverage * 0.6);
    return { profileId: this.id, profileVersion: this.version, score, reasons, requiredEvidenceMet, sampledRecords: samples.length };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    const value = record.value;
    if (!isObject(value)) return createProjection(this.id, 'other', 'Kimi unrecognized record', undefined, keyPath());
    const serverEvent = decodeKimiServerEvent(value);
    if (serverEvent) return projectKimiServerEvent(serverEvent);
    if (isKimiServerHeader(value)) return projectKimiServerHeader(value);
    const coreProjection = projectKimiAgentCoreEvent(value, this.id);
    if (coreProjection) return finalizeProjection(coreProjection, value);
    const type = stringAt(value, 'type');
    let projection: AgentRowProjection;
    if (type === 'metadata') {
      projection = createProjection(this.id, 'session', boundedSummary(stringAt(value, 'protocol_version')?.slice(0, 240) ?? 'unknown', 'Kimi wire protocol'), keyPath('type'), keyPath('protocol_version'));
      setActor(projection, 'system', keyPath('type'));
      setDerivedField(projection, 'protocolVersion', stringAt(value, 'protocol_version'), keyPath('protocol_version'));
      setStringField(projection, 'timestamp', kimiTimestamp(numberAt(value, 'created_at')), keyPath('created_at'));
    } else if (type === 'llm.tools_snapshot' && isKimiToolsSnapshot(value)) {
      const tools = own(value, 'tools');
      const count = kimiToolSnapshotCount(value) ?? 0;
      projection = createProjection(this.id, 'observation', boundedSummary(count, 'Kimi tools snapshot'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerivedField(projection, 'toolsHash', stringAt(value, 'hash'), keyPath('hash'));
      setDerivedField(projection, 'toolsCount', count, keyPath('tools'));
      if (Array.isArray(tools)) {
        const names = tools.slice(0, 32).map((tool) => stringAt(tool, 'name')).filter((name): name is string => name !== undefined).join(', ');
        const descriptions = tools.slice(0, 32).map((tool) => {
          const name = stringAt(tool, 'name');
          const description = stringAt(tool, 'description');
          return name && description ? `${name}: ${description}` : undefined;
        }).filter((value): value is string => value !== undefined).join(' | ');
        setDerivedField(projection, 'toolNames', names || undefined, keyPath('tools'));
        setDerivedField(projection, 'toolDescriptions', descriptions || undefined, keyPath('tools'));
      }
    } else if ((type === 'config.update' || type === 'profile.bind') && isKimiAgentCoreRecord(value)) {
      projection = createProjection(this.id, 'session', boundedSummary(type, 'Kimi'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setDerivedField(projection, 'systemPrompt', stringAt(value, 'systemPrompt'), keyPath('systemPrompt'));
      setDerivedField(projection, 'modelAlias', stringAt(value, 'modelAlias'), keyPath('modelAlias'));
      setDerivedField(projection, 'profileName', stringAt(value, 'profileName'), keyPath('profileName'));
      const effortKey = stringAt(value, 'thinkingEffort') !== undefined ? 'thinkingEffort' : 'thinkingLevel';
      setDerivedField(projection, 'thinkingEffort', stringAt(value, effortKey), keyPath(effortKey));
    } else if (type === 'mcp.tools_discovered' && isKimiAgentCoreRecord(value)) {
      const tools = own(value, 'tools') as unknown[];
      const enabledNames = own(value, 'enabledNames') as unknown[];
      const serverName = stringAt(value, 'serverName')!;
      const toolNames = tools.slice(0, 32).map((tool) => stringAt(tool, 'name')).filter((name): name is string => name !== undefined);
      const enabledToolNames = enabledNames.slice(0, 32).filter((name): name is string => typeof name === 'string');
      projection = createProjection(this.id, 'observation', boundedSummary(`${tools.length} tools from ${serverName}`, 'Kimi MCP discovery'), keyPath('type'), keyPath('tools'));
      setActor(projection, 'system', keyPath('type'));
      setDerivedField(projection, 'serverName', serverName, keyPath('serverName'));
      setDerivedField(projection, 'toolsHash', stringAt(value, 'hash'), keyPath('hash'));
      setDerivedField(projection, 'toolsCount', tools.length, keyPath('tools'));
      setDerivedField(projection, 'toolNames', toolNames.join(', ') || undefined, keyPath('tools'));
      setDerivedField(projection, 'enabledToolCount', enabledNames.length, keyPath('enabledNames'));
      setDerivedField(projection, 'enabledToolNames', enabledToolNames.join(', ') || undefined, keyPath('enabledNames'));
    } else if (type === 'tools.set_active_tools' && isKimiAgentCoreRecord(value)) {
      const names = own(value, 'names') as unknown[];
      const activeNames = names.slice(0, 32).filter((name): name is string => typeof name === 'string');
      projection = createProjection(this.id, 'observation', boundedSummary(activeNames.join(', ') || names.length, 'Kimi active tools'), keyPath('type'), keyPath('names'));
      setActor(projection, 'system', keyPath('type'));
      setDerivedField(projection, 'activeToolCount', names.length, keyPath('names'));
      setDerivedField(projection, 'activeToolNames', activeNames.join(', ') || undefined, keyPath('names'));
    } else if (type === 'context.append_message' && objectAt(value, 'message')) {
      projection = projectKimiMessage(objectAt(value, 'message')!, this.id);
    } else if (type === 'context.append_loop_event' && objectAt(value, 'event')) {
      projection = this.loopEvent(objectAt(value, 'event')!);
    } else if (type && CONTROL_TYPES.has(type)) {
      projection = createProjection(this.id, 'checkpoint', boundedSummary(type, 'Kimi'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      if (type === 'context.apply_compaction') {
        const summary = stringAt(value, 'summary') ?? stringAt(value, 'contextSummary')
          ?? kimiContentPreview(objectAt(value, 'summary')?.content);
        if (summary) {
          projection.summary = boundedSummary(summary.slice(0, 240), 'Kimi compaction');
          projection.evidence.push(evidence('summary', stringAt(value, 'contextSummary') && !stringAt(value, 'summary') ? keyPath('contextSummary') : keyPath('summary')));
        }
      }
      for (const field of ['count', 'turns', 'compactedCount', 'tokensBefore', 'tokensAfter', 'droppedCount']) {
        setDerivedField(projection, field, numberAt(value, field), keyPath(field));
      }
      const status = type === 'full_compaction.cancel' ? 'cancelled'
        : type === 'full_compaction.begin' ? 'running'
          : type === 'full_compaction.complete' ? 'completed' : undefined;
      setStringField(projection, 'status', status, keyPath('type'));
    } else if (type === 'prompt.steered' && Array.isArray(own(value, 'content'))) {
      const content = Array.isArray(own(value, 'content')) ? own(value, 'content') as unknown[] : [];
      projection = createProjection(this.id, 'message', boundedSummary(kimiContentPreview(content) || type, 'Kimi prompt'), keyPath('type'), keyPath('content'));
      setActor(projection, 'user', keyPath('type'));
      setDerivedField(projection, 'contentPartCount', content.length, keyPath('content'));
    } else if (type === 'task.started') {
      const info = objectAt(value, 'info');
      const description = stringAt(info, 'description') ?? stringAt(value, 'description');
      projection = createProjection(this.id, 'task', boundedSummary(description ?? type, 'Kimi task'), keyPath('type'), description === undefined ? keyPath('type') : info ? keyPath('info', 'description') : keyPath('description'));
      setActor(projection, 'system', keyPath('type'));
      setStringField(projection, 'status', stringAt(info, 'status') ?? stringAt(value, 'status'), info && stringAt(info, 'status') !== undefined ? keyPath('info', 'status') : keyPath('status'));
      setDerivedField(projection, 'taskDescription', description, info ? keyPath('info', 'description') : keyPath('description'));
    } else if (type === 'turn.step.interrupted' || type === 'turn.step.retrying') {
      const detail = stringAt(value, 'errorMessage') ?? stringAt(value, 'message') ?? stringAt(value, 'reason') ?? type;
      projection = createProjection(this.id, type === 'turn.step.retrying' ? 'error' : 'turn', boundedSummary(detail.slice(0, 240), 'Kimi ' + type), keyPath('type'), keyPath(stringAt(value, 'errorMessage') ? 'errorMessage' : stringAt(value, 'message') ? 'message' : 'reason'));
      setActor(projection, 'assistant', keyPath('type'));
      setStringField(projection, 'status', type === 'turn.step.retrying' ? 'retrying' : 'interrupted', keyPath('type'));
      if (type === 'turn.step.retrying') setStringField(projection, 'severity', 'warning', keyPath('type'));
      setTurn(projection, own(value, 'turnId'), keyPath('turnId'));
      setDerivedField(projection, 'stepId', stringAt(value, 'stepId'), keyPath('stepId'));
      setDerivedField(projection, 'reason', stringAt(value, 'reason'), keyPath('reason'));
    } else if (type === 'prompt.aborted') {
      projection = createProjection(this.id, 'turn', boundedSummary(stringAt(value, 'reason')?.slice(0, 240) ?? type, 'Kimi prompt'), keyPath('type'));
      setActor(projection, 'system', keyPath('type'));
      setStringField(projection, 'status', 'aborted', keyPath('type'));
      setDerivedField(projection, 'promptId', stringAt(value, 'promptId'), keyPath('promptId'));
    } else {
      // No recursive rendering of unknown structures or transport-shaped payloads.
      projection = createProjection(this.id, 'other', boundedSummary(type?.slice(0, 240) ?? 'unrecognized record', 'Kimi'), type ? keyPath('type') : undefined);
    }
    return finalizeProjection(projection, value);
  }

  private loopEvent(event: Record<string, unknown>): AgentRowProjection {
    const type = stringAt(event, 'type');
    let projection: AgentRowProjection;
    if (type === 'content.part') {
      const part = objectAt(event, 'part');
      const reasoning = stringAt(part, 'type') === 'think';
      projection = createProjection(this.id, reasoning ? 'reasoning' : 'message', boundedSummary(kimiContentPreview([part]) || '[unknown content]', reasoning ? 'Kimi reasoning' : 'Kimi assistant'), keyPath('event', 'part', 'type'), keyPath('event', 'part'));
      setActor(projection, 'assistant', keyPath('event', 'type'));
    } else if (type === 'tool.call') {
      const commandPath = stringAt(event, 'command') !== undefined
        ? keyPath('event', 'command')
        : stringAt(event, 'display', 'command') !== undefined
          ? keyPath('event', 'display', 'command')
          : stringAt(event, 'args', 'command') !== undefined
            ? keyPath('event', 'args', 'command')
            : keyPath('event', 'name');
      projection = createProjection(this.id, 'tool_call', boundedSummary(stringAt(event, 'name')?.slice(0, 240) ?? stringAt(event, 'args', 'command')?.slice(0, 240) ?? 'unknown', 'Kimi tool'), keyPath('event', 'type'), commandPath);
      setActor(projection, 'assistant', keyPath('event', 'type'));
      setDerivedField(projection, 'toolName', stringAt(event, 'name'), keyPath('event', 'name'));
      setDerivedField(projection, 'toolCommand', stringAt(event, 'command') ?? stringAt(event, 'display', 'command') ?? stringAt(event, 'args', 'command'), commandPath);
    } else if (type === 'tool.result') {
      const result = objectAt(event, 'result');
      projection = createProjection(this.id, 'tool_result', boundedSummary(kimiContentPreview(result?.output) || '[empty output]', 'Kimi tool result'), keyPath('event', 'type'), keyPath('event', 'result', 'output'));
      setActor(projection, 'tool', keyPath('event', 'type'));
      // Missing isError is not evidence of success.
      if (result && typeof own(result, 'isError') === 'boolean') setErrorStatus(projection, own(result, 'isError') === true, keyPath('event', 'result', 'isError'));
      setDerivedField(projection, 'resultNote', stringAt(result, 'note'), keyPath('event', 'result', 'note'));
      setIdentity(projection, 'parentId', stringAt(event, 'parentUuid'), keyPath('event', 'parentUuid'));
    } else if (type === 'step.begin' || type === 'step.end') {
      projection = createProjection(this.id, 'turn', boundedSummary(type, 'Kimi'), keyPath('event', 'type'));
      setActor(projection, 'assistant', keyPath('event', 'type'));
      setStringField(projection, 'status', type === 'step.begin' ? 'running' : stringAt(event, 'finishReason'), type === 'step.begin' ? keyPath('event', 'type') : keyPath('event', 'finishReason'));
      setIdentity(projection, 'messageId', stringAt(event, 'messageId'), keyPath('event', 'messageId'));
      setDerivedField(projection, 'stepUuid', stringAt(event, 'uuid'), keyPath('event', 'uuid'));
    } else {
      projection = createProjection(this.id, 'other', boundedSummary(type?.slice(0, 240) ?? 'unknown loop event', 'Kimi'), keyPath('event', 'type'));
    }
    if (type === 'content.part' || type === 'tool.call') setIdentity(projection, 'messageId', stringAt(event, 'uuid'), keyPath('event', 'uuid'));
    setTurn(projection, own(event, 'turnId'), keyPath('event', 'turnId'));
    setIdentity(projection, 'toolCallId', stringAt(event, 'toolCallId'), keyPath('event', 'toolCallId'));
    setDerivedField(projection, 'stepUuid', stringAt(event, 'stepUuid'), keyPath('event', 'stepUuid'));
    setDerivedField(projection, 'step', numberAt(event, 'step'), keyPath('event', 'step'));
    this.usage(projection, own(event, 'usage'), keyPath('event', 'usage'));
    return projection;
  }

  private usage(projection: AgentRowProjection, value: unknown, path: FieldPath): void {
    const usage = kimiUsage(value);
    if (!usage) return;
    projection.usage = usage;
    projection.evidence.push(evidence('usage', path));
  }

}

function setIdentity(projection: AgentRowProjection, field: 'messageId' | 'toolCallId' | 'parentId' | 'turnId', value: string | undefined, path: FieldPath): void {
  // Truncating identities could pair unrelated calls. Oversized IDs stay in Raw.
  if (value !== undefined && value.length > 2048) {
    setDerivedField(projection, 'identityOmitted', true, path);
    return;
  }
  setStringField(projection, field, value, path);
}

function setTurn(projection: AgentRowProjection, value: unknown, path: FieldPath): void {
  setIdentity(projection, 'turnId', typeof value === 'string' ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined, path);
}

function setErrorStatus(projection: AgentRowProjection, isError: boolean, path: FieldPath): void {
  setStringField(projection, 'status', isError ? 'error' : 'completed', path);
  if (isError) setStringField(projection, 'severity', 'error', path);
}

function setDerivedField(projection: AgentRowProjection, field: string, value: string | number | boolean | undefined, path: FieldPath): void {
  setRawDerivedField(projection, field, typeof value === 'string' ? value.slice(0, 240) : value, path);
}

function setStringField<K extends keyof AgentRowProjection>(projection: AgentRowProjection, field: K, value: string | undefined, path: FieldPath): void {
  setRawStringField(projection, field, field === 'status' ? value?.slice(0, 240) : value, path);
}

function finalizeProjection(projection: AgentRowProjection, value: Record<string, unknown>): AgentRowProjection {
  setDerivedField(projection, 'agentId', stringAt(value, 'agentId'), keyPath('agentId'));
  setStringField(projection, 'timestamp', kimiTimestamp(numberAt(value, 'time')), keyPath('time'));
  return projection;
}
