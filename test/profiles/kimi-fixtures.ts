/** Synthetic records shaped from Kimi agent-core-v2; no captured user content. */
export const kimiWireFixture = [
  { type: 'metadata', protocol_version: '1.5', created_at: 1792123200000 },
  { type: 'context.append_message', time: 1792123200001, agentId: 'main', message: {
    id: 'message-user', role: 'user', content: [{ type: 'text', text: 'List the synthetic files.' }],
    toolCalls: [], origin: { kind: 'user' },
  } },
  { type: 'context.append_loop_event', time: 1792123200002, agentId: 'main',
    event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 } },
  { type: 'context.append_loop_event', time: 1792123200003, agentId: 'main', event: {
    type: 'content.part', uuid: 'reasoning-1', stepUuid: 'step-1', turnId: '0',
    part: { type: 'think', think: 'Inspect only the requested directory.' },
  } },
  { type: 'context.append_loop_event', time: 1792123200004, agentId: 'main', event: {
    type: 'tool.call', uuid: 'call-event-1', stepUuid: 'step-1', turnId: '0',
    toolCallId: 'call-1', name: 'Bash', args: { command: 'printf fixture' },
  } },
  { type: 'context.append_loop_event', time: 1792123200005, agentId: 'main', event: {
    type: 'tool.result', toolCallId: 'call-1', parentUuid: 'call-event-1',
    result: { output: 'fixture', isError: false, durationMs: 4 },
  } },
  { type: 'context.append_loop_event', time: 1792123200006, agentId: 'main', event: {
    type: 'content.part', uuid: 'content-1', stepUuid: 'step-1', turnId: '0',
    part: { type: 'text', text: 'The synthetic directory contains fixture.' },
  } },
  { type: 'context.append_loop_event', time: 1792123200007, agentId: 'main', event: {
    type: 'step.end', uuid: 'step-1', turnId: '0', step: 1, finishReason: 'completed',
    usage: { inputOther: 11, inputCacheRead: 7, inputCacheCreation: 3, output: 5 },
  } },
] as const;
