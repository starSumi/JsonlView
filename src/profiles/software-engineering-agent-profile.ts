import type { AgentRowProjection, FieldPath } from '../shared/types';
import type { AgentProfile, DetectionResult, GenericRecordSample, HydratedRecord, ProjectionContext } from './profile-contract';
import {
  boundedSummary,
  createProjection,
  isObject,
  keyPath,
  own,
  pushReason,
  setActor,
  setDerivedField,
  setStringField,
} from './utils';

interface LocatedValue {
  value: unknown;
  path: FieldPath;
  key: string;
}

export class SoftwareEngineeringAgentProfile implements AgentProfile {
  public readonly id = 'software-engineering-agent';
  public readonly displayName = 'Software Engineering Agent';
  public readonly version = '1';

  public detect(sample: readonly GenericRecordSample[]): DetectionResult {
    let trajectoryContainers = 0;
    let workflowRecords = 0;
    let taskSignals = 0;
    let stepSignals = 0;
    let distinctiveSignals = 0;
    const reasons: DetectionResult['reasons'] = [];

    for (const entry of sample) {
      if (!isObject(entry.value)) continue;
      const task = locate(entry.value, TASK_KEYS);
      const step = locate(entry.value, STEP_KEYS);
      const trajectory = own(entry.value, 'trajectory');
      const semantics = countPresent(entry.value, WORKFLOW_KEYS);

      if (Array.isArray(trajectory)) {
        trajectoryContainers += 1;
        distinctiveSignals += 1;
        pushReason(reasons, keyPath('trajectory'), 'Software-engineering trajectory container');
      }
      if (task) {
        taskSignals += 1;
        pushReason(reasons, task.path, `Task identity or problem field: ${task.key}`);
      }
      if (step) stepSignals += 1;
      if (semantics >= 1 && (task || step)) {
        workflowRecords += 1;
        pushReason(reasons, firstWorkflowPath(entry.value), 'Action, observation, tool, patch, test, or outcome evidence');
      }
      if (hasAny(entry.value, ['patch', 'diff', 'observation', 'test_result', 'testResult', 'problem_statement'])) {
        distinctiveSignals += 1;
      }
    }

    const denominator = Math.max(1, sample.length);
    const containerEvidence = trajectoryContainers > 0 && taskSignals > 0;
    const recordEvidence = workflowRecords >= Math.min(2, denominator)
      && (taskSignals > 0 || stepSignals >= Math.min(2, denominator))
      && distinctiveSignals > 0;
    const score = containerEvidence
      ? Math.min(0.98, 0.88 + 0.1 * Math.min(1, trajectoryContainers / denominator))
      : Math.min(0.95,
        0.44 * Math.min(1, workflowRecords / Math.min(2, denominator))
        + 0.22 * Math.min(1, taskSignals / Math.min(2, denominator))
        + 0.16 * Math.min(1, stepSignals / Math.min(2, denominator))
        + 0.13 * Math.min(1, distinctiveSignals / 2));

    return {
      profileId: this.id,
      profileVersion: this.version,
      score,
      reasons,
      requiredEvidenceMet: containerEvidence || recordEvidence,
      sampledRecords: sample.length,
    };
  }

  public project(record: HydratedRecord, _context: ProjectionContext): AgentRowProjection {
    if (!isObject(record.value)) {
      return createProjection(this.id, 'other', boundedSummary(record.value), undefined, keyPath());
    }

    const value = record.value;
    const task = locate(value, ['task', 'problem_statement', 'problemStatement', 'issue', ...TASK_ID_KEYS]);
    const taskId = locate(value, TASK_ID_KEYS);
    const step = locate(value, STEP_KEYS);
    const parentStep = locate(value, PARENT_STEP_KEYS);
    const tool = locateTool(value);
    const callId = locate(value, CALL_ID_KEYS);
    const action = locate(value, ['action', 'command', 'thought']);
    const observation = locate(value, ['observation', 'tool_output', 'toolOutput']);
    const patch = locate(value, ['patch', 'diff']);
    const test = locate(value, ['test_result', 'testResult', 'tests', 'test']);
    const outcome = locate(value, ['outcome', 'result', 'status']);
    const trajectory = own(value, 'trajectory');
    const discriminator = locate(value, ['event', 'event_type', 'type', 'kind']);
    const eventKind = classifyEvent({ value, discriminator, trajectory, action, observation, patch, test, outcome, task, step, tool });
    const summarySource = observation ?? outcome ?? action ?? patch ?? test ?? task ?? discriminator;
    const prefix = eventPrefix(eventKind, tool ? boundedValue(tool.value) : undefined);
    const projection = createProjection(
      this.id,
      eventKind,
      Array.isArray(trajectory)
        ? `Trajectory container: ${trajectory.length} step${trajectory.length === 1 ? '' : 's'}`
        : boundedSummary(summarySource?.value ?? value, prefix),
      discriminator?.path ?? summarySource?.path,
      summarySource?.path ?? (Array.isArray(trajectory) ? keyPath('trajectory') : keyPath()),
    );

    setActor(projection, actorFor(eventKind), discriminator?.path ?? summarySource?.path ?? keyPath());
    const timestamp = locate(value, ['timestamp', 'time', 'created_at', 'createdAt']);
    if (timestamp) setStringField(projection, 'timestamp', scalarText(timestamp.value), timestamp.path);

    if (task) setDerivedField(projection, 'task', boundedValue(task.value), task.path);
    if (taskId) {
      const stableTaskId = scalarText(taskId.value);
      setStringField(projection, 'sessionId', stableTaskId, taskId.path);
      setDerivedField(projection, 'taskId', stableTaskId, taskId.path);
    }
    if (step) {
      const stableStep = scalarText(step.value);
      setStringField(projection, 'turnId', stableStep, step.path);
      setDerivedField(projection, 'step', stableStep ?? boundedValue(step.value), step.path);
      if (eventKind !== 'observation' && eventKind !== 'result' && eventKind !== 'test') {
        setStringField(projection, 'messageId', stableStep, step.path);
      }
    }
    if (parentStep) {
      const stableParent = scalarText(parentStep.value);
      setStringField(projection, 'parentId', stableParent, parentStep.path);
      setDerivedField(projection, 'parentStep', stableParent, parentStep.path);
    }
    if (tool) setDerivedField(projection, 'tool', boundedValue(tool.value), tool.path);
    if (action) setDerivedField(projection, 'action', boundedValue(action.value), action.path);
    if (observation) setDerivedField(projection, 'observation', boundedValue(observation.value), observation.path);
    if (patch) setDerivedField(projection, 'patch', boundedValue(patch.value), patch.path);
    if (test) setDerivedField(projection, 'test', boundedValue(test.value), test.path);
    if (outcome) {
      const renderedOutcome = boundedValue(outcome.value);
      setStringField(projection, 'status', renderedOutcome, outcome.path);
      setDerivedField(projection, 'outcome', renderedOutcome, outcome.path);
    }
    if (Array.isArray(trajectory)) {
      setDerivedField(projection, 'containerKind', 'trajectory', keyPath('trajectory'));
      setDerivedField(projection, 'stepCount', trajectory.length, keyPath('trajectory'));
    }

    const stableCallId = scalarText(callId?.value)
      ?? ((eventKind === 'action' || eventKind === 'observation') ? scalarText(step?.value) : undefined);
    const callPath = callId?.path ?? step?.path;
    if (stableCallId && callPath) setStringField(projection, 'toolCallId', stableCallId, callPath);
    if (eventKind === 'error') setStringField(projection, 'severity', 'error', outcome?.path ?? test?.path ?? observation?.path ?? keyPath());
    return projection;
  }
}

const TASK_ID_KEYS = ['task_id', 'taskId', 'instance_id', 'instanceId', 'issue_id', 'issueId', 'trajectory_id', 'trajectoryId', 'run_id', 'runId'] as const;
const TASK_KEYS = [...TASK_ID_KEYS, 'task', 'problem_statement', 'problemStatement', 'issue'] as const;
const STEP_KEYS = ['step_id', 'stepId', 'step', 'step_index', 'stepIndex'] as const;
const PARENT_STEP_KEYS = ['parent_step_id', 'parentStepId', 'parent_step', 'parentStep'] as const;
const CALL_ID_KEYS = ['tool_call_id', 'toolCallId', 'call_id', 'callId', 'action_id', 'actionId'] as const;
const WORKFLOW_KEYS = ['action', 'command', 'observation', 'tool', 'tool_name', 'toolName', 'patch', 'diff', 'test', 'tests', 'test_result', 'testResult', 'result', 'outcome'] as const;

function classifyEvent(input: {
  value: Record<string, unknown>;
  discriminator: LocatedValue | undefined;
  trajectory: unknown;
  action: LocatedValue | undefined;
  observation: LocatedValue | undefined;
  patch: LocatedValue | undefined;
  test: LocatedValue | undefined;
  outcome: LocatedValue | undefined;
  task: LocatedValue | undefined;
  step: LocatedValue | undefined;
  tool: LocatedValue | undefined;
}): AgentRowProjection['eventKind'] {
  if (Array.isArray(input.trajectory)) return 'task';
  const type = scalarText(input.discriminator?.value)?.toLowerCase();
  if (type && ['error', 'failed', 'failure'].includes(type)) return 'error';
  if (isFailure(input.outcome?.value) || isFailure(input.test?.value)) return 'error';
  if (input.observation) return 'observation';
  if (input.action || input.tool || (type && ['action', 'tool', 'tool_call', 'tool_use'].includes(type))) return 'action';
  if (input.patch || (type && ['patch', 'diff', 'checkpoint'].includes(type))) return 'patch';
  if (input.test || type === 'test') return 'test';
  if (input.outcome || (type && ['result', 'outcome'].includes(type))) return 'result';
  if (input.task && !input.step) return 'task';
  if (input.step) return 'turn';
  return 'other';
}

function actorFor(kind: AgentRowProjection['eventKind']): AgentRowProjection['actor'] {
  if (kind === 'observation' || kind === 'test' || kind === 'result' || kind === 'error') return 'tool';
  if (kind === 'action' || kind === 'turn' || kind === 'patch') return 'agent';
  return 'system';
}

function eventPrefix(kind: AgentRowProjection['eventKind'], tool: string | undefined): string {
  switch (kind) {
    case 'action': return tool ? `Tool ${tool}` : 'Action';
    case 'observation': return 'Observation';
    case 'patch': return 'Patch';
    case 'test': return 'Test';
    case 'result': return 'Result';
    case 'error': return 'Failed';
    case 'task': return 'Task';
    case 'turn': return 'Step';
    default: return 'Agent record';
  }
}

function locateTool(value: Record<string, unknown>): LocatedValue | undefined {
  const direct = locate(value, ['tool', 'tool_name', 'toolName']);
  if (direct) return direct;
  const action = own(value, 'action');
  if (isObject(action)) {
    const nested = own(action, 'tool') ?? own(action, 'name');
    if (nested !== undefined) return { value: nested, key: 'action', path: keyPath('action', own(action, 'tool') !== undefined ? 'tool' : 'name') };
  }
  return undefined;
}

function locate(value: Record<string, unknown>, keys: readonly string[]): LocatedValue | undefined {
  for (const key of keys) {
    const candidate = own(value, key);
    if (candidate !== undefined && candidate !== null) return { value: candidate, key, path: keyPath(key) };
  }
  return undefined;
}

function countPresent(value: Record<string, unknown>, keys: readonly string[]): number {
  let count = 0;
  for (const key of keys) if (own(value, key) !== undefined) count += 1;
  return count;
}

function hasAny(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => own(value, key) !== undefined);
}

function firstWorkflowPath(value: Record<string, unknown>): FieldPath {
  return keyPath(WORKFLOW_KEYS.find((key) => own(value, key) !== undefined) ?? 'action');
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function boundedValue(value: unknown): string {
  if (isObject(value)) {
    for (const key of ['command', 'query', 'message', 'output', 'result', 'status', 'summary']) {
      const candidate = own(value, key);
      if (candidate !== undefined) return boundedSummary(candidate);
    }
  }
  return boundedSummary(value);
}

function isFailure(value: unknown): boolean {
  const rendered = isObject(value)
    ? scalarText(own(value, 'status')) ?? scalarText(own(value, 'outcome')) ?? scalarText(own(value, 'result')) ?? boundedSummary(value)
    : boundedSummary(value);
  return /(^|\b)(fail(?:ed|ure)?|error|timeout|cancelled|canceled)(\b|$)/i.test(rendered);
}
