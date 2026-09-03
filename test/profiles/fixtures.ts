export const codexFixture = [
  {
    timestamp: '2026-08-30T01:00:00.000Z',
    ordinal: 1,
    type: 'session_meta',
    payload: { id: 'session-redacted', cwd: 'C:/redacted' },
  },
  {
    timestamp: '2026-08-30T01:00:01.000Z',
    ordinal: 2,
    type: 'turn_context',
    payload: { turn_id: 'turn-redacted', model: 'model-redacted' },
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
    type: 'inter_agent_communication_metadata',
    payload: { agent_id: 'child-redacted', parent_id: 'parent-redacted', message: 'redacted delegation' },
  },
  {
    timestamp: '2026-08-30T01:00:08.000Z',
    ordinal: 9,
    type: 'future_record_type',
    payload: { future: true },
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
