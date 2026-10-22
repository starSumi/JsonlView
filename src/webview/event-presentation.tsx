import type React from 'react';
import { AgentEventPresentation as AgentEventPresentationView, type AgentEventPresentationProps } from './features/event-presentation/AgentEventPresentation';
import { buildAgentEventPresentation } from './providers/agent-event-presentation';

export type { AgentEventPresentationProps } from './features/event-presentation/AgentEventPresentation';
export type { AgentEventPresentationModel, EventPresentationSection, FunctionCallView } from './features/event-presentation/model';
export { buildAgentEventPresentation } from './providers/agent-event-presentation';

/**
 * Compatibility facade for the detail view. Provider projection stays pure and
 * lives beside the provider builders; this module owns only React composition.
 */
export function AgentEventPresentation(props: Omit<AgentEventPresentationProps, 'buildModel'>): React.JSX.Element | null {
  return <AgentEventPresentationView {...props} buildModel={buildAgentEventPresentation} />;
}
