import React, { useMemo } from 'react';
import type { AgentRowProjection } from '../shared/types';
import { CopyButton } from './copy-button';
import { stringifyJsonBounded } from './json-syntax';
import { ContentView } from './content-view';

const MAX_TEXT = 8_000;
const MAX_METADATA = 8;

interface EventObject {
  [key: string]: unknown;
}

export interface EventPresentationSection {
  title: string;
  text?: string;
  fullText?: string;
  truncated?: boolean;
  code?: string;
  richText?: boolean;
}

export interface AgentEventPresentationModel {
  title: string;
  kind: string;
  metadata: Array<{ label: string; value: string }>;
  sections: EventPresentationSection[];
}

function objectOf(value: unknown): EventObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as EventObject
    : undefined;
}

function textOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => textOf(item, depth + 1)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join('\n') : undefined;
  }
  const object = objectOf(value);
  if (!object) return undefined;
  for (const key of ['text', 'message', 'content', 'summary', 'output', 'result', 'value', 'reason', 'description']) {
    const candidate = textOf(object[key], depth + 1);
    if (candidate) return candidate;
  }
  return undefined;
}

function boundedText(value: unknown): string | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... [truncated]` : text;
}

function textSection(value: unknown): Pick<EventPresentationSection, 'text' | 'fullText' | 'truncated'> {
  const fullText = textOf(value);
  if (!fullText) return {};
  return {
    text: fullText.length > MAX_TEXT ? `${fullText.slice(0, MAX_TEXT)}\n... [preview truncated]` : fullText,
    fullText,
    truncated: fullText.length > MAX_TEXT,
  };
}

function valueLabel(value: unknown): string | undefined {
  const text = boundedText(value);
  return text?.replaceAll('\n', ' ').trim();
}

function codeOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return boundedText(value);
  const result = stringifyJsonBounded(value, { maxChars: MAX_TEXT, maxNodes: 500, maxDepth: 10, maxChildren: 80 });
  return result.text;
}

function contextCode(payload: EventObject): string | undefined {
  const context: EventObject = {};
  const hidden = /^(?:base_)?instructions?$|^(?:history|context_window|conversation|prompt)$/i;
  let count = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (hidden.test(key) || count >= 12) continue;
    if (typeof value === 'string' && value.length > 320) {
      context[key] = `${value.slice(0, 320)}...`;
    } else if (typeof value === 'object' && value !== null) {
      const label = textOf(value);
      context[key] = label && label.length <= 320 ? label : '[object]';
    } else {
      context[key] = value;
    }
    count += 1;
  }
  return codeOf(context);
}

function firstString(objects: EventObject[], keys: string[]): string | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = valueLabel(object[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function isAgentMarkdownText(item: EventObject | undefined, content: unknown): boolean {
  if (!item || item.type !== 'AgentMessage') return false;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.some((block) => objectOf(block)?.type === 'Text');
}

function presentationProduct(profile?: AgentRowProjection): string {
  if (profile?.profileId === 'codex-rollout') return 'Codex';
  if (profile?.profileId === 'claude-code-session') return 'Claude';
  return 'Agent';
}

function isEventEnvelope(value: EventObject, profile?: AgentRowProjection): boolean {
  if (profile?.profileId && profile.profileId !== 'generic') return true;
  const type = valueLabel(value.type);
  return Boolean(type && /(?:response_item|event_msg|session_meta|turn_context|thread_item|turn_item|tool|message|span|trace)/i.test(type));
}

export function buildAgentEventPresentation(
  value: unknown,
  profile?: AgentRowProjection,
): AgentEventPresentationModel | undefined {
  const envelope = objectOf(value);
  if (!envelope || !isEventEnvelope(envelope, profile)) return undefined;
  const payload = objectOf(envelope.payload) ?? envelope;
  const completedItem = objectOf(payload.item);
  const envelopeType = valueLabel(envelope.type);
  const itemType = firstString(completedItem ? [completedItem, payload] : [payload], ['type', 'event_type', 'kind', 'item_type']);
  const kind = itemType ?? envelopeType ?? profile?.eventKind ?? 'event';
  const title = `${presentationProduct(profile)} · ${kind.replaceAll('_', ' ')}`;
  const metadata: Array<{ label: string; value: string }> = [];
  const addMetadata = (label: string, value: string | undefined): void => {
    if (value && metadata.length < MAX_METADATA && !metadata.some((item) => item.label === label)) {
      metadata.push({ label, value });
    }
  };
  addMetadata('role', profile?.actor ?? firstString(completedItem ? [completedItem, payload] : [payload], ['role', 'actor']));
  addMetadata('status', profile?.status ?? firstString([payload, envelope], ['status', 'state']));
  addMetadata('session', profile?.sessionId ?? firstString([payload, envelope], ['session_id', 'sessionId']));
  addMetadata('turn', profile?.turnId ?? firstString([payload, envelope], ['turn_id', 'turnId']));
  addMetadata('thread', firstString([payload, envelope], ['thread_id', 'threadId']));
  addMetadata('model', profile?.model ?? firstString([payload, envelope], ['model', 'model_provider']));
  addMetadata('tool', firstString([payload], ['name', 'tool_name']));
  addMetadata('severity', profile?.severity ?? firstString([payload], ['severity', 'level']));

  const sections: EventPresentationSection[] = [];
  const content = completedItem?.content
    ?? payload.content
    ?? payload.message
    ?? payload.text
    ?? payload.lastPrompt
    ?? payload.prompt;
  const messageText = textSection(content);
  const lowerKind = kind.toLowerCase();
  const isPrompt = lowerKind === 'last-prompt' || lowerKind === 'prompt';
  if (messageText.text && (
    profile?.eventKind === 'message'
    || lowerKind.includes('message')
    || lowerKind === 'reasoning'
    || lowerKind === 'user_message'
    || lowerKind === 'assistant_message'
    || isPrompt
  )) {
    sections.push({
      title: isPrompt ? 'Prompt' : (lowerKind.includes('reason') ? 'Reasoning' : 'Message'),
      ...messageText,
      richText: isAgentMarkdownText(completedItem ?? payload, content),
    });
  }
  const toolInput = payload.arguments ?? payload.input ?? payload.command;
  if (toolInput !== undefined && (lowerKind.includes('call') || lowerKind.includes('tool') || payload.command !== undefined)) {
    const toolCode = codeOf(toolInput);
    if (toolCode !== undefined) sections.push({ title: 'Tool call', code: toolCode });
  }
  const toolOutput = payload.output ?? payload.result;
  if (toolOutput !== undefined && (lowerKind.includes('output') || lowerKind.includes('result') || lowerKind.includes('tool'))) {
    const outputText = textSection(toolOutput);
    const outputCode = outputText.text ? undefined : codeOf(toolOutput);
    if (outputText.text !== undefined) sections.push({ title: 'Tool result', ...outputText });
    else if (outputCode !== undefined) sections.push({ title: 'Tool result', code: outputCode });
  }
  if (lowerKind.includes('event') && !sections.length) {
    const eventText = boundedText(payload.message ?? payload.output ?? payload.reason ?? payload);
    if (eventText) sections.push({ title: 'Event', text: eventText });
  }
  if (!sections.length) {
    const payloadCode = envelopeType === 'session_meta' || envelopeType === 'turn_context'
      ? contextCode(payload)
      : codeOf(payload);
    if (payloadCode !== undefined) {
      sections.push({ title: envelopeType === 'session_meta' || envelopeType === 'turn_context' ? 'Context' : 'Payload', code: payloadCode });
    }
  }
  return { title, kind, metadata, sections };
}

interface AgentEventPresentationProps {
  value: unknown;
  profile?: AgentRowProjection | undefined;
}

export function AgentEventPresentation({ value, profile }: AgentEventPresentationProps): React.JSX.Element | null {
  const model = useMemo(() => buildAgentEventPresentation(value, profile), [profile, value]);
  const [expandedSections, setExpandedSections] = React.useState<ReadonlySet<number>>(() => new Set());
  if (!model) return null;
  return (
    <section className="event-presentation" aria-label="Structured event view">
      <header className="event-presentation-header">
        <div>
          <div className="event-presentation-title">{model.title}</div>
          <div className="event-presentation-kind">{model.kind.replaceAll('_', ' ')}</div>
        </div>
        <span className="event-kind-badge">{profile?.eventKind ?? 'event'}</span>
      </header>
      {model.metadata.length ? (
        <dl className="event-fields">
          {model.metadata.map((item) => <React.Fragment key={item.label}><dt>{item.label}</dt><dd title={item.value}>{item.value}</dd></React.Fragment>)}
        </dl>
      ) : null}
      <div className="event-sections">
        {model.sections.map((section, index) => (
          <section className="event-section" key={`${section.title}:${index}`}>
            <div className="event-section-header">
              <h3>{section.title}</h3>
              <CopyButton
                text={section.fullText ?? section.text ?? section.code ?? ''}
                label={`Copy ${section.title}`}
              />
            </div>
            {section.truncated ? (
              <button
                type="button"
                className="event-section-action"
                onClick={() => setExpandedSections((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })}
              >
                {expandedSections.has(index) ? 'Show preview' : 'Show full'}
              </button>
            ) : null}
            {section.text !== undefined ? (
              <ContentView
                key={`content:${section.fullText ?? section.text ?? String(index)}`}
                text={expandedSections.has(index) ? section.fullText ?? section.text : section.text}
                truncated={section.truncated === true && !expandedSections.has(index)}
                ariaLabel={`${section.title} content`}
                defaultMode={section.richText ? 'markdown' : 'auto'}
              />
            ) : null}
            {section.code !== undefined ? <ContentView key={`code:${section.code}`} text={section.code} ariaLabel={`${section.title} code`} /> : null}
          </section>
        ))}
      </div>
    </section>
  );
}
