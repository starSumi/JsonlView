import type React from 'react';
import type { RowProjection } from '@shared/types';

export const CONVERSATION_MESSAGE_HEIGHT = 132;
export const CONVERSATION_EVENT_HEIGHT = 42;

/** Fixed, bounded cards keep page geometry stable while text wraps at any editor width. */
export function conversationRowHeight(row: RowProjection): number {
  return row.conversation?.parts.some((part) => !['tool', 'system', 'developer', 'reasoning'].includes(part.role))
    ? CONVERSATION_MESSAGE_HEIGHT : CONVERSATION_EVENT_HEIGHT;
}

export function ConversationRow({ row }: { row: RowProjection }): React.JSX.Element {
  const parts = row.conversation?.parts ?? [];
  const roles = [...new Set(parts.map((part) => part.role))];
  const role = roles.length === 1 ? roles[0] : roles.length > 1 ? 'mixed' : 'event';
  return (
    <div className="conversation-record" data-role={role} data-expanded={conversationRowHeight(row) === CONVERSATION_MESSAGE_HEIGHT}>
      <div className="conversation-record-heading">
        <strong>{roles.length ? roles.join(' / ') : row.profile?.eventKind ?? row.ref.parseState}</strong>
        {row.profile?.timestamp ? <time>{row.profile.timestamp}</time> : null}
        <span className="conversation-record-hint" data-limited={row.conversation?.truncated === true}>
          {row.conversation?.truncated ? 'Preview limited · ' : 'Preview · '}Open record ↗
        </span>
      </div>
      {parts.length ? (
        <div className="conversation-record-text">{parts.map((part) => part.label + ': ' + part.text).join('\n\n')}</div>
      ) : (
        <div className="conversation-record-summary">{row.profile?.summary || row.genericSummary || 'No textual preview · open record for source'}</div>
      )}
    </div>
  );
}
