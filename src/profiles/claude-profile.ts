import type { AgentRowProjection } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  CLAUDE_CONTROL_TYPES,
  CLAUDE_TRANSCRIPT_TYPES,
  claudeHistoryTimestamp,
  classifyClaudeRecord,
  hasClaudeIdentityEnvelope,
  isClaudeJobTimelinePathHint,
  isClaudeJobTimelineState,
} from './claude-record-strategy';
import {
  actorFromRole,
  boundedSummary,
  createProjection,
  evidence,
  extractText,
  indexedPath,
  isObject,
  keyPath,
  objectAt,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
  stringAt,
  usageFromObject,
} from './utils';

export class ClaudeCodeProfile implements AgentProfile {
  public readonly id = 'claude-code-session';
  public readonly displayName = 'Claude Code Session';
  public readonly version = '2';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let typed = 0;
    let messageEnvelope = 0;
    let controlEnvelope = 0;
    let transcriptEnvelope = 0;
    let jobTimeline = 0;
    let history = 0;
    let identity = 0;
    let timelinePathEvidence = 0;
    const reasons: DetectionResult['reasons'] = [];
    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const type = stringAt(entry.value, 'type');
      const strategy = classifyClaudeRecord(entry.value);
      if (strategy === 'job-timeline') {
        const state = stringAt(entry.value, 'state');
        if (!isClaudeJobTimelineState(state)) continue;
        jobTimeline += 1;
        typed += 1;
        if (isClaudeJobTimelinePathHint(entry.sourcePathHint)) timelinePathEvidence += 1;
        pushReason(reasons, keyPath('at'), 'Claude Code job timeline record with lifecycle state and text/detail');
      }
      if (strategy === 'history') {
        history += 1;
        typed += 1;
        identity += 1;
        pushReason(reasons, keyPath('display'), 'Claude Code command history record with project and session identity');
      }
      const hasIdentity = hasClaudeIdentityEnvelope(entry.value);
      if (type && CLAUDE_TRANSCRIPT_TYPES.has(type) && (!CLAUDE_CONTROL_TYPES.has(type) || hasIdentity)) {
        typed += 1;
        if (CLAUDE_CONTROL_TYPES.has(type) && hasIdentity) controlEnvelope += 1;
        pushReason(reasons, keyPath('type'), `Known Claude Code record type: ${type}`);
      }
      if ((type === 'user' || type === 'assistant') && objectAt(entry.value, 'message')) {
        messageEnvelope += 1;
        transcriptEnvelope += 1;
        pushReason(reasons, keyPath('message'), 'Claude Code role record with nested message envelope');
      }
      if (hasIdentity) {
        identity += 1;
        pushReason(reasons, stringAt(entry.value, 'uuid') ? keyPath('sessionId') : keyPath('leafUuid'), 'Session and Claude record identity fields are present');
      }
    }
    const denominator = Math.max(1, sample.length);
    // Timeline records are selectable automatically only with their explicit
    // `.claude/jobs/<id>/timeline.jsonl` locator. Without it they remain a
    // useful manual suggestion, but the generic profile preserves semantics.
    const timelineAutoEvidence = timelinePathEvidence >= 2 ? jobTimeline : 0;
    const specializedEvidence = Math.max(timelineAutoEvidence, history);
    // Claude transcript exports commonly omit sessionId/uuid on individual
    // lines. The stable discriminator there is the repeated `type` plus
    // nested role-message envelope; identity fields remain a confidence
    // signal when present rather than a hard requirement.
    const transcriptQuorum = transcriptEnvelope >= 2 && typed >= Math.min(2, denominator)
      ? transcriptEnvelope
      : 0;
    const envelopeEvidence = Math.max(messageEnvelope, controlEnvelope, transcriptQuorum, specializedEvidence);
    const matchingCoverage = Math.max(
      transcriptEnvelope,
      controlEnvelope,
      history,
      jobTimeline,
    ) / denominator;
    const pathBackedTimeline = timelinePathEvidence >= 2 && jobTimeline > 0;
    // A provider profile must explain a meaningful share of the physical
    // sample. Two matching rows in a large mixed file are not a schema proof.
    // The explicit job timeline path is stronger evidence, so it may use a
    // lower floor while still requiring the actual rows to validate.
    const coverageFloor = pathBackedTimeline ? 0.2 : 0.25;
    const coverageMet = matchingCoverage >= coverageFloor;
    const score = Math.min(0.99, 0.28 * Math.min(1, typed / denominator) + 0.42 * Math.min(1, envelopeEvidence / 2) + 0.29 * Math.min(1, Math.max(identity, specializedEvidence >= 2 ? 1 : 0) / 2));
    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: typed >= Math.min(2, denominator)
        && (identity >= 1 || specializedEvidence >= 2 || transcriptQuorum >= 2)
        && (messageEnvelope >= 1 || controlEnvelope >= 2 || specializedEvidence >= 2)
        && (timelineAutoEvidence >= 2 || jobTimeline === 0)
        && coverageMet,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }
    const value = record.value;
    const type = stringAt(value, 'type');
    const typePath = type ? keyPath('type') : undefined;
    const message = objectAt(value, 'message');
    const content = own(message ?? {}, 'content');
    const blocks = Array.isArray(content) ? content : [];
    const toolUse = findBlock(blocks, 'tool_use');
    const toolResult = findBlock(blocks, 'tool_result');
    let projection: AgentRowProjection;

    const strategy = classifyClaudeRecord(value);
    if (strategy === 'job-timeline') {
      const state = stringAt(value, 'state') ?? 'unknown';
      const text = own(value, 'text');
      const detail = own(value, 'detail');
      const hasText = typeof text === 'string' && text.length > 0;
      const summaryValue = hasText ? text : detail;
      projection = createProjection(
        this.id,
        hasText ? 'message' : 'observation',
        boundedSummary(summaryValue ?? value, `Claude job ${state}`),
        keyPath('state'),
        hasText ? keyPath('text') : (detail !== undefined ? keyPath('detail') : keyPath('state')),
      );
      setStringField(projection, 'status', state, keyPath('state'));
      setDerivedField(projection, 'state', state, keyPath('state'));
      setDerivedField(projection, 'sourceKind', 'job-timeline', keyPath('state'));
      if (detail !== undefined && typeof detail === 'string') setDerivedField(projection, 'detail', detail, keyPath('detail'));
    } else if (strategy === 'history') {
      const display = own(value, 'display');
      projection = createProjection(
        this.id,
        'message',
        boundedSummary(display, 'Claude command'),
        keyPath('display'),
        keyPath('display'),
      );
      setActor(projection, 'user', keyPath('display'));
      setDerivedField(projection, 'sourceKind', 'history', keyPath('display'));
      const project = stringAt(value, 'project');
      if (project) setDerivedField(projection, 'project', project, keyPath('project'));
    } else if (toolUse) {
      const name = stringAt(toolUse.value, 'name') ?? 'tool';
      projection = createProjection(this.id, 'tool_call', boundedSummary(own(toolUse.value, 'input'), `Tool ${name}`), indexedPath(['message', 'content'], toolUse.index, 'type'), indexedPath(['message', 'content'], toolUse.index, 'input'));
      setActor(projection, 'assistant', stringAt(message, 'role') ? keyPath('message', 'role') : indexedPath(['message', 'content'], toolUse.index, 'type'));
      setStringField(projection, 'toolCallId', stringAt(toolUse.value, 'id'), indexedPath(['message', 'content'], toolUse.index, 'id'));
    } else if (toolResult) {
      projection = createProjection(this.id, 'tool_result', boundedSummary(own(toolResult.value, 'content'), 'Tool result'), indexedPath(['message', 'content'], toolResult.index, 'type'), indexedPath(['message', 'content'], toolResult.index, 'content'));
      setActor(projection, 'tool', indexedPath(['message', 'content'], toolResult.index, 'type'));
      setStringField(projection, 'toolCallId', stringAt(toolResult.value, 'tool_use_id'), indexedPath(['message', 'content'], toolResult.index, 'tool_use_id'));
    } else {
      switch (type) {
        case 'user':
        case 'assistant':
          projection = createProjection(this.id, 'message', boundedSummary(extractText(content) ?? content, `${type} message`), typePath, keyPath('message', 'content'));
          setActor(projection, actorFromRole(stringAt(message, 'role') ?? type), stringAt(message, 'role') ? keyPath('message', 'role') : keyPath('type'));
          break;
        case 'system': {
          const subtype = stringAt(value, 'subtype');
          const isError = subtype === 'error' || typeof own(value, 'error') === 'string';
          projection = createProjection(this.id, isError ? 'error' : 'checkpoint', boundedSummary(own(value, 'message') ?? own(value, 'content') ?? value, subtype ?? 'System'), typePath, own(value, 'message') !== undefined ? keyPath('message') : (own(value, 'content') !== undefined ? keyPath('content') : keyPath()));
          setActor(projection, 'system', keyPath('type'));
          if (isError) setStringField(projection, 'severity', 'error', subtype ? keyPath('subtype') : keyPath('error'));
          break;
        }
        case 'summary':
          projection = createProjection(this.id, 'checkpoint', boundedSummary(own(value, 'summary') ?? value, 'Summary'), typePath, own(value, 'summary') !== undefined ? keyPath('summary') : keyPath());
          break;
        case 'last-prompt': {
          const prompt = own(value, 'lastPrompt') ?? own(value, 'prompt');
          projection = createProjection(this.id, 'message', boundedSummary(prompt ?? value, 'Last prompt'), typePath, prompt !== undefined ? keyPath('lastPrompt') : keyPath());
          setActor(projection, 'user', keyPath('type'));
          if (prompt !== undefined) setDerivedField(projection, 'prompt', boundedSummary(prompt), keyPath('lastPrompt'));
          break;
        }
        case 'permission-mode': {
          const permissionMode = own(value, 'permissionMode') ?? own(value, 'mode');
          projection = createProjection(this.id, 'approval', boundedSummary(permissionMode ?? value, 'Permission mode'), typePath, permissionMode !== undefined ? keyPath('permissionMode') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          if (permissionMode !== undefined) {
            setStringField(projection, 'status', boundedSummary(permissionMode), keyPath('permissionMode'));
            setDerivedField(projection, 'permissionMode', boundedSummary(permissionMode), keyPath('permissionMode'));
          }
          break;
        }
        case 'mode': {
          const mode = own(value, 'mode');
          projection = createProjection(this.id, 'checkpoint', boundedSummary(mode ?? value, 'Mode'), typePath, mode !== undefined ? keyPath('mode') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          if (mode !== undefined) {
            setStringField(projection, 'status', boundedSummary(mode), keyPath('mode'));
            setDerivedField(projection, 'mode', boundedSummary(mode), keyPath('mode'));
          }
          break;
        }
        case 'progress': {
          const progress = own(value, 'data') ?? own(value, 'message') ?? own(value, 'content') ?? value;
          projection = createProjection(this.id, 'observation', boundedSummary(progress, 'Progress'), typePath, own(value, 'data') !== undefined ? keyPath('data') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          break;
        }
        case 'queue-operation': {
          const operation = own(value, 'operation');
          projection = createProjection(this.id, 'action', boundedSummary(operation ?? value, 'Queue operation'), typePath, operation !== undefined ? keyPath('operation') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          if (operation !== undefined) setDerivedField(projection, 'operation', boundedSummary(operation), keyPath('operation'));
          break;
        }
        case 'ai-title': {
          const title = own(value, 'aiTitle') ?? own(value, 'title');
          projection = createProjection(this.id, 'session', boundedSummary(title ?? value, 'AI title'), typePath, title !== undefined ? keyPath('aiTitle') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          if (title !== undefined) setDerivedField(projection, 'title', boundedSummary(title), keyPath('aiTitle'));
          break;
        }
        case 'atis-latch': {
          const latch = own(value, 'atis');
          projection = createProjection(this.id, 'checkpoint', boundedSummary(latch ?? value, 'ATIS latch'), typePath, latch !== undefined ? keyPath('atis') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          if (latch !== undefined) setDerivedField(projection, 'atis', boundedSummary(latch), keyPath('atis'));
          break;
        }
        case 'attachment': {
          const attachment = objectAt(value, 'attachment');
          const attachmentType = stringAt(attachment, 'type');
          projection = createProjection(this.id, 'checkpoint', boundedSummary(attachment ?? value, 'Attachment'), typePath, attachment !== undefined ? keyPath('attachment') : keyPath());
          setActor(projection, 'system', keyPath('type'));
          if (attachmentType) setDerivedField(projection, 'attachmentType', attachmentType, keyPath('attachment', 'type'));
          break;
        }
        case 'file-history-snapshot':
        case 'file-history-delta': {
          const snapshot = own(value, 'snapshot') ?? own(value, 'backup') ?? value;
          projection = createProjection(this.id, 'checkpoint', boundedSummary(snapshot, type === 'file-history-delta' ? 'File history delta' : 'File history snapshot'), typePath, own(value, 'snapshot') !== undefined ? keyPath('snapshot') : (own(value, 'backup') !== undefined ? keyPath('backup') : keyPath()));
          setActor(projection, 'system', keyPath('type'));
          break;
        }
        default:
          projection = createProjection(this.id, 'other', boundedSummary(value, type ? `Unknown ${type}` : 'Claude record'), typePath, keyPath());
          break;
      }
    }

    setStringField(projection, 'timestamp', stringAt(value, 'timestamp'), keyPath('timestamp'));
    if (strategy === 'job-timeline') setStringField(projection, 'timestamp', stringAt(value, 'at'), keyPath('at'));
    if (strategy === 'history') setStringField(projection, 'timestamp', claudeHistoryTimestamp(value), keyPath('timestamp'));
    setStringField(projection, 'sessionId', stringAt(value, 'sessionId'), keyPath('sessionId'));
    const recordId = claudeRecordId(value);
    setStringField(projection, 'messageId', recordId, stringAt(value, 'uuid') ? keyPath('uuid') : keyPath('leafUuid'));
    setStringField(projection, 'parentId', stringAt(value, 'parentUuid'), keyPath('parentUuid'));
    setStringField(projection, 'model', stringAt(message, 'model'), keyPath('message', 'model'));

    const usage = usageFromObject(objectAt(message, 'usage'));
    if (usage) {
      projection.usage = usage;
      projection.evidence.push(evidence('usage', keyPath('message', 'usage')));
    }
    const agentId = stringAt(value, 'agentId');
    if (agentId) {
      setStringField(projection, 'subagentId', agentId, keyPath('agentId'));
    }
    return projection;
  }
}

function claudeRecordId(value: Record<string, unknown>): string | undefined {
  return stringAt(value, 'uuid') ?? stringAt(value, 'leafUuid');
}

function findBlock(blocks: unknown[], type: string): { value: Record<string, unknown>; index: number } | undefined {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (isObject(block) && stringAt(block, 'type') === type) {
      return { value: block, index };
    }
  }
  return undefined;
}
