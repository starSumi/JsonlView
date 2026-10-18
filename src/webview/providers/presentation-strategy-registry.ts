import type { AgentRowProjection } from '../../shared/types';
import type { EventPresentationSection } from '../features/event-presentation/model';
import { buildClaudeEventSections, type ClaudeEventBuilderContext } from './claude-event-builder';
import { buildGenericAgentEventSections, type GenericEventBuilderContext } from './generic-event-builder';
import { buildKimiEventSections, type KimiEventBuilderContext } from './kimi-event-builder';
import { buildPiEventSections, type PiEventBuilderContext } from './pi-event-builder';

export type PresentationEventObject = Record<string, unknown>;

export interface PresentationStrategyInput {
  envelope: PresentationEventObject;
  payload: PresentationEventObject;
  profile: AgentRowProjection | undefined;
  envelopeType: string | undefined;
}

export interface PresentationStrategyContext {
  claude: ClaudeEventBuilderContext;
  pi: PiEventBuilderContext;
  kimi: KimiEventBuilderContext;
  generic: GenericEventBuilderContext;
}

type PresentationStrategy = (
  input: PresentationStrategyInput,
  context: PresentationStrategyContext,
) => EventPresentationSection[];

const PRESENTATION_STRATEGIES = new Map<string, PresentationStrategy>([
  [
    'claude-code-session',
    ({ payload, profile }, context) => buildClaudeEventSections(payload, profile, context.claude),
  ],
  [
    'pi-coding-agent',
    ({ payload, profile }, context) => buildPiEventSections(payload, profile, context.pi),
  ],
  [
    'kimi-code-session',
    ({ payload, profile }, context) => buildKimiEventSections(payload, profile, context.kimi),
  ],
  [
    'generic-agent-events',
    ({ envelope, payload, profile, envelopeType }, context) => buildGenericAgentEventSections(
      envelope,
      payload,
      profile,
      envelopeType,
      context.generic,
    ),
  ],
]);

/**
 * Selects one provider strategy by its owned profile identity.
 *
 * Provider builders are intentionally not probed in sequence: an event can
 * contain fields shared by multiple providers, so order-based arbitration
 * would make presentation depend on unrelated builder changes.
 */
export function buildProviderEventSections(
  input: PresentationStrategyInput,
  context: PresentationStrategyContext,
): EventPresentationSection[] {
  const strategy = input.profile?.profileId === undefined
    ? undefined
    : PRESENTATION_STRATEGIES.get(input.profile.profileId);
  return strategy ? strategy(input, context) : [];
}

export function hasPresentationStrategy(profileId: string | undefined): boolean {
  return profileId !== undefined && PRESENTATION_STRATEGIES.has(profileId);
}
