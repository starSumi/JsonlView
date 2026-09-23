export const codexFixture = [
  {
    timestamp: '2026-08-30T01:00:00.000Z',
    ordinal: 1,
    type: 'session_meta',
    payload: {
      session_id: 'session-redacted',
      id: 'session-redacted',
      timestamp: '2026-08-30T01:00:00.000Z',
      cwd: 'C:/redacted',
      originator: 'codex-cli',
      cli_version: '0.1.0',
    },
  },
  {
    timestamp: '2026-08-30T01:00:01.000Z',
    ordinal: 2,
    type: 'turn_context',
    payload: {
      turn_id: 'turn-redacted',
      cwd: 'C:/redacted',
      approval_policy: 'on-request',
      sandbox_policy: { type: 'workspace-write' },
      model: 'model-redacted',
    },
  },
  {
    timestamp: '2026-08-30T01:00:02.000Z',
    ordinal: 3,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      id: 'message-redacted',
      turn_id: 'turn-redacted',
      content: [{ type: 'output_text', text: 'Redacted answer' }],
    },
  },
  {
    timestamp: '2026-08-30T01:00:03.000Z',
    ordinal: 4,
    type: 'response_item',
    payload: { type: 'function_call', name: 'read_file', call_id: 'call-redacted', arguments: '{"path":"redacted"}' },
  },
  {
    timestamp: '2026-08-30T01:00:04.000Z',
    ordinal: 5,
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'call-redacted', output: 'redacted result' },
  },
  {
    timestamp: '2026-08-30T01:00:05.000Z',
    ordinal: 6,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
  },
  {
    timestamp: '2026-08-30T01:00:06.000Z',
    ordinal: 7,
    type: 'event_msg',
    payload: { type: 'error', message: 'redacted failure', severity: 'error' },
  },
  {
    timestamp: '2026-08-30T01:00:07.000Z',
    ordinal: 8,
    type: 'inter_agent_communication',
    payload: {
      author: 'parent-redacted',
      recipient: 'child-redacted',
      other_recipients: [],
      content: 'redacted delegation',
      trigger_turn: true,
    },
  },
  {
    timestamp: '2026-08-30T01:00:08.000Z',
    ordinal: 9,
    type: 'future_record_type',
    payload: { future: true },
  },
] as const;

// Redacted snapshots of the separate `codex exec --json` stdout contract.
// These are top-level tagged events, not rollout envelopes.
export const codexExecFixture = [
  { type: 'thread.started', thread_id: 'thread-exec-redacted' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item-message-redacted', type: 'agent_message', text: 'Completed response' } },
  { type: 'item.completed', item: { id: 'item-command-redacted', type: 'command_execution', command: 'pnpm test', aggregated_output: 'passed', exit_code: 0, status: 'completed' } },
  { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 8, reasoning_output_tokens: 3 } },
] as const;

// Redacted raw trace-bundle events. `payloads/` references are intentionally
// left as scalar paths; the viewer must not eagerly open sibling files.
export const codexTraceFixture = [
  {
    schema_version: 1,
    seq: 1,
    wall_time_unix_ms: 1788346097000,
    rollout_id: 'rollout-trace-redacted',
    thread_id: 'thread-trace-redacted',
    codex_turn_id: null,
    payload: { type: 'rollout_started', trace_id: 'trace-redacted', root_thread_id: 'thread-trace-redacted' },
  },
  {
    schema_version: 1,
    seq: 2,
    wall_time_unix_ms: 1788346098000,
    rollout_id: 'rollout-trace-redacted',
    thread_id: 'thread-trace-redacted',
    codex_turn_id: 'turn-trace-redacted',
    payload: { type: 'codex_turn_started', codex_turn_id: 'turn-trace-redacted', thread_id: 'thread-trace-redacted' },
  },
  {
    schema_version: 1,
    seq: 3,
    wall_time_unix_ms: 1788346099000,
    rollout_id: 'rollout-trace-redacted',
    thread_id: 'thread-trace-redacted',
    codex_turn_id: 'turn-trace-redacted',
    payload: { type: 'tool_call_started', tool_call_id: 'tool-trace-redacted', kind: 'shell', summary: 'Run tests' },
  },
  {
    schema_version: 1,
    seq: 4,
    wall_time_unix_ms: 1788346100000,
    rollout_id: 'rollout-trace-redacted',
    thread_id: 'thread-trace-redacted',
    codex_turn_id: 'turn-trace-redacted',
    payload: { type: 'codex_turn_ended', codex_turn_id: 'turn-trace-redacted', status: 'completed' },
  },
] as const;

export const codexRolloutAuxiliaryFixture = [
  {
    timestamp: '2026-09-02T10:49:00.000Z',
    type: 'inter_agent_communication',
    payload: { author: '/root', recipient: '/root/child', other_recipients: [], content: 'delegated', trigger_turn: true },
  },
  {
    timestamp: '2026-09-02T10:49:01.000Z',
    type: 'token_usage_record',
    payload: {
      thread_id: 'thread-redacted',
      turn_id: 'turn-redacted',
      session_id: 'session-redacted',
      root_turn_id: 'root-turn-redacted',
      response_id: 'response-redacted',
      usage: { input_tokens: 4, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 6 },
      turn_token_usage: { input_tokens: 4, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 6 },
      thread_token_usage: { input_tokens: 4, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 6 },
    },
  },
  {
    timestamp: '2026-09-02T10:49:02.000Z',
    type: 'retained_context',
    payload: {
      type: 'verified_answer',
      turn_id: 'turn-redacted',
      call_id: 'call-redacted',
      questions: [],
      acceptance_order: 2,
    },
  },
  {
    timestamp: '2026-09-02T10:49:03.000Z',
    type: 'security_risk_score',
    payload: { scores: { 'call-redacted': 0.2 }, call_id: 'call-redacted' },
  },
  {
    timestamp: '2026-09-02T10:49:04.000Z',
    type: 'realtime_item',
    payload: { id: 'realtime-item-redacted', realtime_session_id: 'realtime-session-redacted', type: 'transcript_segment', role: 'user', text: 'audio' },
  },
] as const;

// Redacted snapshots of Codex's auxiliary append-only JSONL surfaces. The
// producer source serializes these as fixed scalar objects, independently from
// rollout envelopes.
export const codexHistoryFixture = [
  {
    session_id: '01a060f8-803d-7563-872e-e2e4e54e6708',
    ts: 1788346097,
    text: 'Inspect the failing parser',
  },
  {
    session_id: '01a061b9-2090-7343-abf9-4b16528826a2',
    ts: 1788346120,
    text: 'Run the focused tests',
  },
  {
    session_id: '01a061c0-2090-7343-abf9-4b16528826a2',
    ts: 1788346150,
    text: 'Review the release evidence',
  },
  {
    session_id: '01a061d0-2090-7343-abf9-4b16528826a2',
    ts: 1788346180,
    text: 'Publish after the final gate',
  },
] as const;

export const codexSessionIndexFixture = [
  {
    id: '01a060f8-803d-7563-872e-e2e4e54e6708',
    thread_name: 'Parser investigation',
    updated_at: '2026-09-02T10:48:17.959Z',
  },
  {
    id: '01a061b9-2090-7343-abf9-4b16528826a2',
    thread_name: 'Release review',
    updated_at: '2026-09-02T11:02:17.959+00:00',
  },
  {
    id: '01a061c0-2090-7343-abf9-4b16528826a2',
    thread_name: 'Follow recovery',
    updated_at: '2026-09-02T11:12:17.959Z',
  },
  {
    id: '01a061d0-2090-7343-abf9-4b16528826a2',
    thread_name: 'Benchmark trend',
    updated_at: '2026-09-02T11:22:17.959Z',
  },
] as const;
export const claudeFixture = [
  {
    type: 'user',
    sessionId: 'session-redacted',
    uuid: 'message-user-redacted',
    parentUuid: null,
    timestamp: '2026-08-30T02:00:00.000Z',
    message: { role: 'user', content: 'Redacted question' },
  },
  {
    type: 'assistant',
    sessionId: 'session-redacted',
    uuid: 'message-call-redacted',
    parentUuid: 'message-user-redacted',
    timestamp: '2026-08-30T02:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'model-redacted',
      content: [{ type: 'tool_use', id: 'tool-redacted', name: 'Read', input: { file_path: 'redacted' } }],
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  },
  {
    type: 'user',
    sessionId: 'session-redacted',
    uuid: 'message-result-redacted',
    parentUuid: 'message-call-redacted',
    timestamp: '2026-08-30T02:00:02.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-redacted', content: 'redacted result' }],
    },
  },
  {
    type: 'system',
    subtype: 'error',
    sessionId: 'session-redacted',
    uuid: 'message-error-redacted',
    parentUuid: 'message-result-redacted',
    timestamp: '2026-08-30T02:00:03.000Z',
    message: 'redacted failure',
  },
  {
    type: 'future_claude_type',
    sessionId: 'session-redacted',
    uuid: 'message-future-redacted',
    parentUuid: 'message-error-redacted',
    timestamp: '2026-08-30T02:00:04.000Z',
    future: true,
  },
] as const;

// Redacted snapshots of the two non-transcript Claude JSONL surfaces observed
// in the local runtime. These remain small contract fixtures, not raw logs.
export const claudeJobTimelineFixture = [
  { at: '2026-08-30T02:10:00.000Z', state: 'working', detail: 'Indexing source', text: '' },
  { at: '2026-08-30T02:10:01.000Z', state: 'done', detail: 'Index complete', text: '## Delivery\n\n- **Rows** are ready' },
] as const;

export const claudeHistoryFixture = [
  {
    display: '/model',
    pastedContents: {},
    timestamp: 1788055800000,
    project: 'C:/redacted/project',
    sessionId: 'session-history-redacted',
  },
  {
    display: 'Inspect the failing parser',
    pastedContents: {},
    timestamp: 1788055860000,
    project: 'C:/redacted/project',
    sessionId: 'session-history-redacted',
  },
] as const;

export const genericAgentFixture = [
  {
    timestamp: '2026-08-30T03:00:00.000Z',
    event: 'message',
    role: 'user',
    session_id: 'session-generic',
    turn_id: 'turn-generic',
    message_id: 'message-generic',
    message: 'Redacted generic request',
  },
  {
    timestamp: '2026-08-30T03:00:01.000Z',
    event: 'tool_call',
    role: 'assistant',
    turn_id: 'turn-generic',
    tool_call_id: 'tool-generic',
    content: 'redacted tool request',
  },
  {
    timestamp: '2026-08-30T03:00:02.000Z',
    event: 'tool_result',
    role: 'tool',
    turn_id: 'turn-generic',
    tool_call_id: 'tool-generic',
    content: 'redacted tool result',
  },
  {
    timestamp: '2026-08-30T03:00:03.000Z',
    event: 'usage',
    turn_id: 'turn-generic',
    usage: { input: 5, output: 2, total: 7 },
  },
  {
    timestamp: '2026-08-30T03:00:04.000Z',
    event: 'future_event',
    turn_id: 'turn-generic',
    content: 'redacted future content',
  },
] as const;

export const ordinaryJsonlFixture = [
  { sku: 'redacted-1', price: 10, available: true },
  { sku: 'redacted-2', price: 20, available: false },
  ['redacted', 3],
] as const;

export const otelFixture = [
  {
    traceId: 'trace-redacted',
    spanId: 'span-root',
    name: 'checkout',
    startTimeUnixNano: '1788062400000000000',
    endTimeUnixNano: '1788062400100000000',
    status: { code: 'STATUS_CODE_OK' },
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: 'checkout-service' } },
        { key: 'service.version', value: { stringValue: 'redacted' } },
      ],
    },
  },
  {
    traceId: 'trace-redacted',
    spanId: 'span-child',
    parentSpanId: 'span-root',
    name: 'database.query',
    startTimeUnixNano: '1788062400010000000',
    endTimeUnixNano: '1788062400050000000',
    status: { code: 'STATUS_CODE_ERROR', message: 'redacted query failure' },
  },
  {
    timeUnixNano: '1788062400020000000',
    observedTimeUnixNano: '1788062400021000000',
    severityNumber: 17,
    severityText: 'ERROR',
    body: { stringValue: 'database call failed' },
    eventName: 'exception',
    traceId: 'trace-redacted',
    spanId: 'span-child',
    instrumentationScope: { name: 'checkout.instrumentation', version: '1.0.0' },
    attributes: [{ key: 'exception.type', value: { stringValue: 'DatabaseError' } }],
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout-service' } }] },
  },
  {
    Timestamp: '2026-08-30T04:00:03.000Z',
    SeverityText: 'INFO',
    Body: 'request complete',
    TraceId: 'trace-redacted',
    SpanId: 'span-root',
    Resource: { 'service.name': 'checkout-service' },
    EventName: 'request.completed',
  },
  { futureOtelRecord: true },
] as const;

export const otelEnvelopeFixture = [
  {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api-service' } }] },
        scopeLogs: [{ scope: { name: 'redacted.scope' }, logRecords: [{ body: { stringValue: 'one' } }, { body: { stringValue: 'two' } }] }],
      },
    ],
  },
  {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker-service' } }] },
        scopeSpans: [{ scope: { name: 'redacted.scope' }, spans: [{ traceId: 'one' }, { traceId: 'two' }] }],
      },
      {
        resource: { attributes: [] },
        scopeSpans: [],
      },
    ],
  },
] as const;

export const softwareEngineeringAgentFixture = [
  {
    timestamp: '2026-08-30T05:00:00.000Z',
    event: 'task',
    task_id: 'task-redacted',
    problem_statement: 'Repair the failing parser',
  },
  {
    timestamp: '2026-08-30T05:00:01.000Z',
    event: 'action',
    task_id: 'task-redacted',
    step_id: 1,
    tool_call_id: 'call-redacted',
    tool: 'shell',
    action: { command: 'pnpm test' },
  },
  {
    timestamp: '2026-08-30T05:00:02.000Z',
    event: 'observation',
    task_id: 'task-redacted',
    step_id: 1,
    tool_call_id: 'call-redacted',
    observation: 'one failing test',
  },
  {
    timestamp: '2026-08-30T05:00:03.000Z',
    event: 'patch',
    task_id: 'task-redacted',
    step_id: 2,
    parent_step_id: 1,
    patch: 'diff --git a/redacted b/redacted',
  },
  {
    timestamp: '2026-08-30T05:00:04.000Z',
    event: 'test',
    task_id: 'task-redacted',
    step_id: 3,
    parent_step_id: 2,
    test_result: { status: 'passed', summary: 'all tests passed' },
    outcome: 'success',
  },
  { futureSoftwareAgentRecord: true },
] as const;

export const softwareEngineeringTrajectoryFixture = [
  {
    task_id: 'task-container',
    task: 'Resolve issue',
    trajectory: [
      { step: 1, action: 'inspect' },
      { step: 2, observation: 'found cause' },
      { step: 3, patch: 'redacted patch' },
    ],
  },
] as const;

export const structuredApplicationLogFixture = [
  {
    time: 1788069600000,
    level: 30,
    msg: 'request started',
    name: 'api',
    requestId: 'request-redacted',
    correlationId: 'correlation-redacted',
  },
  {
    '@timestamp': '2026-08-30T06:00:01.000Z',
    log: { level: 'WARN', logger: 'checkout.handler' },
    message: 'upstream response was slow',
    service: { name: 'checkout-service' },
    trace: { id: 'trace-log-redacted' },
    span: { id: 'span-log-redacted' },
  },
  {
    '@t': '2026-08-30T06:00:02.000Z',
    '@l': 'Error',
    '@m': 'request failed',
    SourceContext: 'Checkout.Handler',
    RequestId: 'request-redacted',
    CorrelationId: 'correlation-redacted',
    TraceId: 'trace-log-redacted',
    SpanId: 'span-log-redacted',
    Exception: 'System.InvalidOperationException: redacted',
  },
  {
    timestamp: '2026-08-30T06:00:03.000Z',
    severity: 'ERROR',
    message: 'worker failed',
    component: 'worker',
    error: { message: 'redacted failure', stack: 'redacted stack' },
    'logging.googleapis.com/trace': 'projects/redacted/traces/gcp-trace-redacted',
    'logging.googleapis.com/spanId': 'gcp-span-redacted',
  },
  { futureApplicationRecord: true },
] as const;

// tracing-subscriber JSON (`LOG_FORMAT=json`) writes structured fields under
// `fields` and uses `target` as the source name.
export const tracingSubscriberLogFixture = [
  {
    timestamp: '2026-09-08T02:00:00.000Z',
    level: 'INFO',
    fields: { message: 'app-server started', request_id: 'request-trace-redacted' },
    target: 'codex_app_server::startup',
    span: {},
  },
  {
    timestamp: '2026-09-08T02:00:01.000Z',
    level: 'ERROR',
    fields: { message: 'request failed', error: 'upstream unavailable' },
    target: 'codex_app_server::transport',
  },
] as const;
