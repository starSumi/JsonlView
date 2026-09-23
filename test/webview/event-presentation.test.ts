import { describe, expect, it } from 'vitest';
import { buildAgentEventPresentation, AgentEventPresentation } from '../../src/webview/event-presentation';
import { parseUnifiedDiff } from '../../src/webview/diff-view';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

describe('structured agent event presentation', () => {
  it('parses unified diff hunks into numbered additions, removals, and context', () => {
    const result = parseUnifiedDiff('--- a/example.ts\n+++ b/example.ts\n@@ -4,2 +4,3 @@\n-old\n context\n+new\n');
    expect(result.truncated).toBe(false);
    expect(result.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'remove', oldLine: 4, marker: '-', text: 'old' }),
      expect.objectContaining({ kind: 'context', oldLine: 5, newLine: 4, text: 'context' }),
      expect.objectContaining({ kind: 'add', newLine: 5, marker: '+', text: 'new' }),
    ]));
  });

  it('keeps diff parsing bounded and preserves the truncation signal', () => {
    const result = parseUnifiedDiff(Array.from({ length: 5 }, (_, index) => `+line-${index}`).join('\n'), { maxLines: 3 });
    expect(result.lines).toHaveLength(3);
    expect(result.displayedLines).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('renders Codex FileChange unified diffs with dedicated add/remove rows', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'FileChange',
          changes: {
            'D:/workspace/example.ts': {
              type: 'update',
              unified_diff: '@@ -1,2 +1,2 @@\n-old value\n+new value\n',
              move_path: null,
            },
          },
        },
      },
    };
    const profile = { profileId: 'codex-rollout' as const, eventKind: 'patch' as const, summary: 'FileChange', evidence: [], confidence: 'source' as const };
    const model = buildAgentEventPresentation(value, profile);
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Changes', language: 'diff', code: expect.stringContaining('+new value') }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile }));
    expect(markup).toContain('diff-line-add');
    expect(markup).toContain('diff-line-remove');
    expect(markup).toContain('>+</span>');
    expect(markup).toContain('>new value</span>');
    expect(markup).toContain('>-</span>');
    expect(markup).toContain('>old value</span>');
  });

  it('projects add and delete FileChange content into visible diff markers', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'FileChange',
          changes: [
            { path: 'new.txt', kind: 'add', content: 'created' },
            { path: 'old.txt', kind: 'delete', content: 'removed' },
          ],
        },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'patch', summary: 'FileChange', evidence: [], confidence: 'source',
    });
    expect(model?.sections.find((section) => section.title === 'Changes')?.code).toEqual(expect.stringContaining('+created'));
    expect(model?.sections.find((section) => section.title === 'Changes')?.code).toEqual(expect.stringContaining('-removed'));
  });

  it('formats Codex response messages without losing the raw payload', () => {
    const value = {
      timestamp: '2026-08-19T03:09:01.349Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'first line\nsecond line' }],
        turn_id: 'turn-1',
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout',
      eventKind: 'message',
      summary: 'message',
      turnId: 'turn-1',
      evidence: [],
      confidence: 'source',
    });

    expect(model?.title).toBe('Codex · message');
    expect(model?.metadata).toContainEqual({ label: 'role', value: 'assistant' });
    expect(model?.sections[0]?.text).toContain('first line\nsecond line');
  });

  it('uses Markdown by default only for assistant Responses message content', () => {
    const assistant = buildAgentEventPresentation({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '## Result\n\n- ready' }],
      },
    }, { profileId: 'codex-rollout', eventKind: 'message', summary: 'assistant', evidence: [], confidence: 'source' });
    const user = buildAgentEventPresentation({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '## Keep source' }],
      },
    }, { profileId: 'codex-rollout', eventKind: 'message', summary: 'user', evidence: [], confidence: 'source' });
    expect(assistant?.sections[0]).toMatchObject({ richText: true });
    expect(user?.sections[0]?.richText).not.toBe(true);
  });

  it('recognizes completed Codex AgentMessage Text blocks as rich Markdown content', () => {
    const value = {
      timestamp: '2026-09-02T10:48:17.959Z',
      ordinal: 24,
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'AgentMessage',
          content: [{
            type: 'Text',
            text: '## Python\n\n> Indent blocks.\n\n```python\nprint("hello")\n```',
          }],
        },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source',
    });
    expect(model?.kind).toBe('AgentMessage');
    expect(model?.sections[0]).toMatchObject({ title: 'Message', richText: true });
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value,
      profile: { profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source' },
    }));
    expect(markup).toContain('<h2>Python</h2>');
    expect(markup).toContain('>Indent blocks.</blockquote>');
    expect(markup).toContain('>python</span>');
    expect(markup).toContain('print(');
    expect(markup).toContain('code-token-string');
    expect(markup).toContain('&quot;hello&quot;');
  });

  it('renders Codex world state instruction fields as labeled Markdown sections', () => {
    const value = {
      type: 'world_state',
      payload: {
        full: true,
        state: {
          agents_md: { directory: 'C:/workspace', text: '# Working agreements\n\n- Preserve evidence' },
          host_skills: { body: '## Skills\n\nUse the bounded route.' },
          permissions: { instructions: 'Ask before external changes.' },
        },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'checkpoint', summary: 'world state', evidence: [], confidence: 'source',
    });
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'AGENTS.md', richText: true }),
      expect.objectContaining({ title: 'Host skills', richText: true }),
      expect.objectContaining({ title: 'Permission instructions', richText: true }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile: {
      profileId: 'codex-rollout', eventKind: 'checkpoint', summary: 'world state', evidence: [], confidence: 'source',
    } }));
    expect(markup).toContain('<h1>Working agreements</h1>');
    expect(markup).toContain('<h2>Skills</h2>');
  });

  it('renders Codex completed reasoning and command execution fields from the nested item', () => {
    const reasoning = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'Reasoning', id: 'reasoning-1', summary_text: ['Checking the index'], raw_content: ['Details'] },
      },
    };
    const command = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution', id: 'exec-1', command: ['pwsh', '-NoProfile', '-Command', 'Get-Date'],
          status: 'completed', stdout: 'stdout line', stderr: '', aggregated_output: 'stdout line',
          formatted_output: '## Result\n\n- passed', exit_code: 0,
        },
      },
    };
    const reasoningModel = buildAgentEventPresentation(reasoning, {
      profileId: 'codex-rollout', eventKind: 'reasoning', summary: 'Reasoning', evidence: [], confidence: 'source',
    });
    const commandModel = buildAgentEventPresentation(command, {
      profileId: 'codex-rollout', eventKind: 'tool_result', summary: 'CommandExecution', evidence: [], confidence: 'source',
    });
    expect(reasoningModel?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Reasoning summary', text: 'Checking the index' }),
      expect.objectContaining({ title: 'Reasoning content', text: 'Details' }),
    ]));
    expect(commandModel?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Command', language: 'shell', codeWrap: true, code: expect.stringContaining('Get-Date') }),
      expect.objectContaining({ title: 'stdout', text: 'stdout line', richText: true }),
      expect.objectContaining({ title: 'aggregated output', text: 'stdout line', richText: true }),
      expect.objectContaining({ title: 'formatted output', richText: true }),
    ]));
    const commandMarkup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value: { ...command, payload: { ...command.payload, item: { ...command.payload.item, stdout: '# stdout\n\n- ready', aggregated_output: '# aggregate' } } },
      profile: { profileId: 'codex-rollout', eventKind: 'tool_result', summary: 'CommandExecution', evidence: [], confidence: 'source' },
    }));
    expect(commandMarkup).toContain('<h1>stdout</h1>');
    expect(commandMarkup).toContain('<li>ready</li>');
    expect(commandMarkup).toContain('<h1>aggregate</h1>');
    expect(commandMarkup).toContain('content-code is-wrapped');
  });

  it('keeps Codex nested sub-agent activity and settings semantically visible', () => {
    const activity = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'SubAgentActivity', id: 'call-1', kind: 'started', agent_thread_id: 'child-1', agent_path: '/root/child' },
      },
    };
    const settings = {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        settings: { developer_instructions: '# Collaboration mode\n\nKeep ownership explicit.' },
      },
    };
    const activityModel = buildAgentEventPresentation(activity, {
      profileId: 'codex-rollout', eventKind: 'subagent', subagentId: 'child-1', summary: 'SubAgentActivity', evidence: [], confidence: 'source',
    });
    const settingsModel = buildAgentEventPresentation(settings, {
      profileId: 'codex-rollout', eventKind: 'action', summary: 'thread settings', evidence: [], confidence: 'source',
    });
    expect(activityModel?.kind).toBe('SubAgentActivity');
    expect(activityModel?.metadata).toContainEqual({ label: 'thread', value: 'child-1' });
    expect(settingsModel?.sections[0]).toMatchObject({ title: 'Developer instructions', richText: true });
  });

  it('finds developer instructions in the official thread_settings collaboration shape', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_id: 'thread-settings',
        thread_settings: {
          collaboration_mode: {
            mode: 'default',
            settings: {
              developer_instructions: '# Collaboration Mode: Default\n\nKeep the workflow bounded.',
            },
          },
        },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'action', summary: 'thread settings', evidence: [], confidence: 'source',
    });
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Developer instructions', richText: true, text: expect.stringContaining('# Collaboration Mode') }),
    ]));
  });

  it('keeps the official Extension wire kind visible in the presentation title', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'Extension', id: 'extension-1', kind: 'web.search', query: 'jsonl', results: [{ title: 'result' }] },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'tool_result', summary: 'Extension', evidence: [], confidence: 'source',
    });
    expect(model?.title).toBe('Codex · Extension · web.search');
    expect(model?.metadata).toContainEqual({ label: 'extension', value: 'web.search' });
  });

  it('uses the same nested-item renderer for Codex exec JSONL', () => {
    const value = {
      type: 'item.completed',
      item: { id: 'exec-message', type: 'agent_message', text: '## Answer\n\nDone.' },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-exec-jsonl', eventKind: 'message', actor: 'assistant', summary: 'Answer', evidence: [], confidence: 'source',
    });
    expect(model?.title).toBe('Codex · agent message');
    expect(model?.sections[0]).toMatchObject({ title: 'Message', richText: true, text: '## Answer\n\nDone.' });
  });

  it('presents official custom exec calls as JavaScript while retaining wire metadata', () => {
    const input = 'const value = await tools.create_goal({ objective: "inspect" });\ntext(value);';
    const value = {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-exec',
        name: 'exec',
        input,
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'tool_call', actor: 'assistant', summary: 'exec', evidence: [], confidence: 'source',
    });
    expect(model?.title).toBe('Codex · Code Mode · exec');
    expect(model?.metadata).toEqual(expect.arrayContaining([
      { label: 'wire type', value: 'custom_tool_call' },
      { label: 'input format', value: 'freeform/javascript' },
      { label: 'call id', value: 'call-exec' },
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'JavaScript · exec', language: 'javascript', code: expect.stringContaining('tools.create_goal'), copyText: input }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile: {
      profileId: 'codex-rollout', eventKind: 'tool_call', actor: 'assistant', summary: 'exec', evidence: [], confidence: 'source',
    } }));
    expect(markup).toContain('JavaScript · exec');
    expect(markup).toContain('code-token-keyword');
  });

  it('normalizes CamelCase custom tool items before selecting the Code Mode renderer', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CustomToolCall',
          call_id: 'call-camel',
          name: 'exec',
          input: 'const answer = await tools.exec_command({ cmd: "Get-Date" });\ntext(answer);',
        },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'tool_call', actor: 'assistant', summary: 'exec', evidence: [], confidence: 'source',
    });
    expect(model?.title).toBe('Codex · Code Mode · exec');
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'JavaScript · exec', language: 'javascript' }),
    ]));
  });

  it('renders the terminal turn message and timing fields from task_complete', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-complete',
        last_agent_message: '## Done\n\n- Tests pass',
        started_at: 1787108940,
        completed_at: 1787108971,
        duration_ms: 30559,
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'result', actor: 'assistant', turnId: 'turn-complete', summary: 'Turn complete', evidence: [], confidence: 'source',
    });
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Last agent message', richText: true, text: '## Done\n\n- Tests pass' }),
      expect.objectContaining({ title: 'Timing', language: 'json' }),
    ]));
  });

  it('keeps non-exec custom inputs selectable as text with embedded JSON detection', () => {
    const value = {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call-patch',
        name: 'apply_patch',
        input: '{"patch":"*** Begin Patch\\n*** End Patch"}',
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'tool_call', actor: 'assistant', summary: 'apply_patch', evidence: [], confidence: 'source',
    });
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Freeform input · apply_patch', text: expect.stringContaining('"patch"') }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile: {
      profileId: 'codex-rollout', eventKind: 'tool_call', actor: 'assistant', summary: 'apply_patch', evidence: [], confidence: 'source',
    } }));
    expect(markup).toContain('Content format');
    expect(markup).toContain('JSON');
    expect(markup).not.toContain('JavaScript · apply_patch');
  });

  it('renders custom tool outputs as tool results and preserves the call id', () => {
    const value = {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-exec',
        output: [{ type: 'input_text', text: 'Script completed' }],
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'tool_result', actor: 'tool', toolCallId: 'call-exec', summary: 'output', evidence: [], confidence: 'source',
    });
    expect(model?.metadata).toContainEqual({ label: 'call id', value: 'call-exec' });
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool result', text: 'Script completed' }),
    ]));
  });

  it('keeps an exceptionally large object code section Raw-only', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', id: 'large', command: Array.from({ length: 40_000 }, (_, index) => `arg-${index}-${'x'.repeat(8)}`) },
      },
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'codex-rollout', eventKind: 'tool_call', summary: 'large command', evidence: [], confidence: 'source',
    });
    const command = model?.sections.find((section) => section.title === 'Command');
    expect(command?.truncated).toBe(true);
    expect(command?.fullText).toBeUndefined();
    expect(command?.previewOnly).toBe(true);
  });

  it('renders tool calls in a bounded container and ignores non-events', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value: {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: { command: 'pnpm test' } },
      },
      profile: {
        profileId: 'codex-rollout',
        eventKind: 'tool_call',
        summary: 'shell',
        evidence: [],
        confidence: 'source',
      },
    }));

    expect(markup).toContain('Structured event view');
    expect(markup).toContain('Arguments');
    expect(markup).toContain('pnpm test');
    expect(markup).toContain('aria-label="Copy Arguments"');
    expect(buildAgentEventPresentation({ message: 'plain record' })).toBeUndefined();
  });

  it('renders stringified function-call arguments as a foldable JSON container', () => {
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value: {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          arguments: '{"task_name":"runtime_probe","message":"inspect the current state"}',
        },
      },
      profile: {
        profileId: 'codex-rollout',
        eventKind: 'tool_call',
        summary: 'spawn agent',
        evidence: [],
        confidence: 'source',
      },
    }));

    expect(markup).toContain('json-fold-view');
    expect(markup).toContain('JSON block at line');
    expect(markup).toContain('task_name');
    expect(markup).toContain('runtime_probe');
  });

  it('keeps structured shell function-call output readable with JSON detection and full copy', () => {
    const output = JSON.stringify({
      status: 'completed',
      stdout: '# Build\n\n- passed',
      command: 'pnpm test',
    }, null, 2);
    const value = {
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-shell', output },
    };
    const profile = {
      profileId: 'codex-rollout' as const,
      eventKind: 'tool_result' as const,
      actor: 'tool' as const,
      summary: 'shell output',
      evidence: [],
      confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Tool result', text: output }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile }));
    expect(markup).toContain('Tool result content');
    expect(markup).toContain('Detected: json');
    expect(markup).toContain('json-fold-view');
    expect(markup).toContain('status');
    expect(markup).toContain('call-shell');
    expect(model?.sections.find((section) => section.title === 'Tool result')?.contentMode).toBe('json');
  });

  it('uses shell syntax highlighting for fenced command output', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-shell',
          command: ['sh', '-c', 'echo ready'],
          formatted_output: '```sh\nif [ -f package.json ]; then echo "ready"; fi\n```',
        },
      },
    };
    const profile = {
      profileId: 'codex-rollout' as const,
      eventKind: 'tool_call' as const,
      actor: 'assistant' as const,
      summary: 'shell output',
      evidence: [],
      confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'formatted output', text: expect.stringContaining('```sh') }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile }));
    expect(markup).toContain('formatted output content');
    expect(markup).toContain('>sh</span>');
    expect(markup).toContain('code-token-keyword');
    expect(markup).toContain('ready');
  });

  it('routes plain command output to a conservative code container when signals are strong', () => {
    const value = {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'exec-rust',
          stdout: 'use std::path::Path;\nfn main() { let value = 1; println!("{value}"); }',
        },
      },
    };
    const profile = {
      profileId: 'codex-rollout' as const,
      eventKind: 'tool_result' as const,
      actor: 'tool' as const,
      summary: 'rust output',
      evidence: [],
      confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);
    expect(model?.sections.find((section) => section.title === 'stdout')).toMatchObject({
      contentMode: 'code',
      codeLanguage: 'rust',
    });
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile }));
    expect(markup).toContain('>Code</button>');
    expect(markup).toContain('code-token-keyword');
  });

  it('gives generic dataset text fields a readable content container', () => {
    const value = {
      text: "McKinley Heating Service Experts Heating & Air Conditioning\n\nDon't think you need all the bells and whistles? No problem.",
      label: 'c4 sample',
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'generic', eventKind: 'other', summary: 'c4 sample', evidence: [], confidence: 'source',
    });
    expect(model?.title).toBe('Agent · text');
    expect(model?.sections[0]).toMatchObject({
      title: 'Text',
      text: expect.stringContaining('McKinley Heating'),
      richText: false,
    });
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value,
      profile: { profileId: 'generic', eventKind: 'other', summary: 'c4 sample', evidence: [], confidence: 'source' },
    }));
    expect(markup).toContain('Text content');
    expect(markup).toContain('McKinley Heating');
  });

  it('presents LLaMA-Factory messages by role while keeping training fields visible', () => {
    const value = {
      messages: [
        { role: 'user', content: [{ type: 'text', value: 'Explain OPFS.' }], loss_weight: 0 },
        { role: 'assistant', content: [{ type: 'text', value: '## OPFS\n\nIt is browser storage.' }], loss_weight: 1 },
      ],
    };
    const model = buildAgentEventPresentation(value, {
      profileId: 'generic', eventKind: 'other', summary: 'messages', evidence: [], confidence: 'source',
    });
    expect(model?.title).toBe('Agent · messages');
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Message 1 · user', text: 'Explain OPFS.', richText: false }),
      expect.objectContaining({ title: 'Message 2 · assistant', text: '## OPFS\n\nIt is browser storage.', richText: true }),
    ]));
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile: {
      profileId: 'generic', eventKind: 'other', summary: 'messages', evidence: [], confidence: 'source',
    } }));
    expect(markup).toContain('Message 1 · user content');
    expect(markup).toContain('<h2>OPFS</h2>');
  });

  it('presents Alpaca and preference columns without treating every field as Markdown', () => {
    const alpaca = buildAgentEventPresentation({
      instruction: 'Write a short answer',
      input: 'About JSONL',
      output: '## Answer\n\nUse one JSON object per line.',
    }, {
      profileId: 'generic', eventKind: 'other', summary: 'alpaca', evidence: [], confidence: 'source',
    });
    expect(alpaca?.kind).toBe('instruction');
    expect(alpaca?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Prompt', richText: false }),
      expect.objectContaining({ title: 'Input', richText: false }),
      expect.objectContaining({ title: 'Response', richText: true }),
    ]));
    const preference = buildAgentEventPresentation({ chosen: 'good', rejected: 'bad' }, {
      profileId: 'generic', eventKind: 'other', summary: 'preference', evidence: [], confidence: 'source',
    });
    expect(preference?.kind).toBe('preference');
    expect(preference?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Chosen', text: 'good' }),
      expect.objectContaining({ title: 'Rejected', text: 'bad' }),
    ]));
  });

  it('treats thread and turn items as structured containers', () => {
    const thread = buildAgentEventPresentation({
      type: 'thread_item',
      payload: { type: 'message', role: 'user', text: 'line one\nline two' },
    });
    const turn = buildAgentEventPresentation({
      type: 'turn_item',
      payload: { turn_id: 't-9', status: 'completed' },
    });

    expect(thread?.sections[0]?.text).toBe('line one\nline two');
    expect(turn?.metadata).toContainEqual({ label: 'turn', value: 't-9' });
  });

  it('keeps long event text available behind an explicit full-view control', () => {
    const longText = 'line\n'.repeat(2_500);
    const model = buildAgentEventPresentation({ type: 'message', role: 'developer', content: longText }, {
      profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source',
    });
    expect(model?.sections[0]?.truncated).toBe(true);
    expect(model?.sections[0]?.fullText).toBe(longText);
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, {
      value: { type: 'message', role: 'developer', content: longText },
      profile: { profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source' },
    }));
    expect(markup).toContain('Show full');
    expect(markup).toContain('[preview truncated]');
  });

  it('bounds nested text extraction before materializing a very large array', () => {
    const content = Array.from({ length: 20_000 }, (_, index) => ({ text: `entry-${index}` }));
    const model = buildAgentEventPresentation({ type: 'message', role: 'assistant', content }, {
      profileId: 'codex-rollout', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source',
    });

    const section = model?.sections[0];
    expect(section?.truncated).toBe(true);
    expect(section?.previewOnly).toBe(true);
    expect(section?.fullText).toBeUndefined();
    expect(section?.text?.length).toBeLessThan(8_100);
    expect(section?.text).toContain('[preview truncated]');
  });

  it('presents current Claude control records with their semantic prompt content', () => {
    const value = {
      type: 'last-prompt',
      lastPrompt: 'Explain OPFS',
      sessionId: 'session-redacted',
    };
    const profile = {
      profileId: 'claude-code-session', eventKind: 'message' as const, actor: 'user' as const,
      sessionId: 'session-redacted', summary: 'Last prompt: Explain OPFS', evidence: [], confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);

    expect(model).toMatchObject({ title: 'Claude · last-prompt', kind: 'last-prompt' });
    expect(model?.metadata).toContainEqual({ label: 'role', value: 'user' });
    expect(model?.sections[0]).toMatchObject({ title: 'Prompt', text: 'Explain OPFS' });
  });

  it('renders Claude job timeline text as Markdown without promoting arbitrary text fields', () => {
    const value = {
      at: '2026-08-06T10:47:38.133Z',
      state: 'blocked',
      detail: 'Choose a plan',
      text: '## Delivery\n\n- **Index** sessions\n- Search traces',
    };
    const profile = {
      profileId: 'claude-code-session', eventKind: 'message' as const, status: 'blocked',
      summary: 'Claude job blocked', evidence: [], confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);

    expect(model?.metadata).toContainEqual({ label: 'status', value: 'blocked' });
    expect(model?.sections[0]).toMatchObject({ title: 'Message', richText: true });
    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile }));
    expect(markup).toContain('<h2>Delivery</h2>');
    expect(markup).toContain('<strong>Index</strong>');
    expect(markup).toContain('<li>Search traces</li>');

    const arbitrary = buildAgentEventPresentation(
      { type: 'message', text: '## A log heading' },
      { profileId: 'structured-application-log', eventKind: 'log', summary: 'log', evidence: [], confidence: 'source' },
    );
    expect(arbitrary?.sections[0]?.richText).not.toBe(true);
  });

  it('renders Claude assistant text blocks as Markdown while keeping user prompts selectable as text', () => {
    const assistant = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '## Result\n\n**Done**' }] },
    };
    const model = buildAgentEventPresentation(assistant, {
      profileId: 'claude-code-session', eventKind: 'message', actor: 'assistant', summary: 'Result', evidence: [], confidence: 'source',
    });
    expect(model?.sections[0]).toMatchObject({ richText: true });
  });

  it('renders Claude message content blocks instead of falling back to a generic payload', () => {
    const value = {
      type: 'user',
      sessionId: 'session-redacted',
      message: {
        role: 'user',
        content: [{
          tool_use_id: 'tool-redacted',
          type: 'tool_result',
          content: '{"path":"F:/fixture","files":2}',
          is_error: false,
        }],
      },
    };
    const profile = {
      profileId: 'claude-code-session', eventKind: 'tool_result' as const, actor: 'tool' as const,
      sessionId: 'session-redacted', toolCallId: 'tool-redacted', summary: 'Tool result',
      evidence: [], confidence: 'source' as const,
    };
    const model = buildAgentEventPresentation(value, profile);

    expect(model?.sections[0]).toMatchObject({ title: 'Tool result', text: '{"path":"F:/fixture","files":2}' });
    expect(model?.sections.some((section) => section.title === 'Payload')).toBe(false);
    expect(model?.metadata).toContainEqual({ label: 'tool use id', value: 'tool-redacted' });
    expect(model?.metadata).toContainEqual({ label: 'error', value: 'false' });

    const markup = renderToStaticMarkup(React.createElement(AgentEventPresentation, { value, profile }));
    expect(markup).toContain('F:/fixture');
    expect(markup).toContain('Tool result');
  });

  it('keeps an empty Claude timeline text field useful through its detail value', () => {
    const model = buildAgentEventPresentation(
      { at: '2026-08-06T10:33:35.710Z', state: 'working', detail: 'Indexing source', text: '' },
      { profileId: 'claude-code-session', eventKind: 'observation', status: 'working', summary: 'Indexing source', evidence: [], confidence: 'source' },
    );
    expect(model?.sections[0]).toMatchObject({ title: 'Detail', text: 'Indexing source', richText: false });
  });

  it('presents Claude history display as a bounded message section', () => {
    const model = buildAgentEventPresentation({
      display: 'Inspect the failing parser',
      pastedContents: {},
      timestamp: 1788055860000,
      project: 'C:/redacted/project',
      sessionId: 'session-history-redacted',
    }, {
      profileId: 'claude-code-session', eventKind: 'message', actor: 'user', summary: 'Claude command', evidence: [], confidence: 'source',
    });
    expect(model?.sections[0]).toMatchObject({ title: 'Message', text: 'Inspect the failing parser', richText: false });
    expect(model?.metadata).toContainEqual({ label: 'project', value: 'C:/redacted/project' });
  });

  it('does not inspect high-cardinality event fields beyond their display budgets', () => {
    let outOfBudgetReads = 0;
    const guarded = <T,>(length: number, value: T, boundary: number): T[] => {
      const items = Array.from({ length }, () => value);
      Object.defineProperty(items, boundary, {
        configurable: true,
        get() {
          outOfBudgetReads += 1;
          throw new Error('display budget was crossed');
        },
      });
      return items;
    };

    const toolOutput = guarded(514, { type: 'text', text: 'bounded' }, 512);
    expect(() => buildAgentEventPresentation({
      type: 'response_item',
      payload: { type: 'function_call_output', output: toolOutput },
    }, {
      profileId: 'codex-rollout', eventKind: 'tool_result', summary: 'output', evidence: [], confidence: 'source',
    })).not.toThrow();

    const command = guarded(10_002, 'argument', 10_000);
    command[0] = 'pwsh';
    expect(() => buildAgentEventPresentation({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'CommandExecution', command } },
    }, {
      profileId: 'codex-rollout', eventKind: 'tool_result', summary: 'command', evidence: [], confidence: 'source',
    })).not.toThrow();

    const messageBlocks = guarded(10_002, { type: 'image', content: 'bounded' }, 10_000);
    expect(() => buildAgentEventPresentation({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: messageBlocks },
    }, {
      profileId: 'codex-rollout', eventKind: 'message', actor: 'assistant', summary: 'message', evidence: [], confidence: 'source',
    })).not.toThrow();

    const changes = guarded(130, { path: 'bounded.txt', type: 'add', content: 'ok' }, 128);
    expect(() => buildAgentEventPresentation({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'FileChange', changes } },
    }, {
      profileId: 'codex-rollout', eventKind: 'patch', summary: 'changes', evidence: [], confidence: 'source',
    })).not.toThrow();

    const content = guarded(34, { type: 'text', text: 'bounded' }, 32);
    const claude = buildAgentEventPresentation({
      type: 'assistant',
      message: { role: 'assistant', content },
    }, {
      profileId: 'claude-code-session', eventKind: 'message', summary: 'message', evidence: [], confidence: 'source',
    });
    expect(claude?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Additional content blocks', previewOnly: true }),
    ]));
    expect(outOfBudgetReads).toBe(0);
  });
});
