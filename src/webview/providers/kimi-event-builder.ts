import type { AgentRowProjection } from '../../shared/types';
import type { EventPresentationSection } from '../features/event-presentation/model';
import { presentKimiEvent } from './kimi-event-strategies';

export type KimiEventObject = Record<string, unknown>;

export interface KimiEventBuilderContext {
  objectOf(value: unknown): KimiEventObject | undefined;
  own(object: KimiEventObject, key: string): unknown;
  valueLabel(value: unknown): string | undefined;
  addTextCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    richText?: boolean,
  ): void;
  addCodeCandidate(
    sections: EventPresentationSection[],
    title: string,
    value: unknown,
    language?: string,
  ): void;
}

/**
 * Compatibility facade for the event presentation pipeline. Kimi content is
 * selected by the discriminant registry in kimi-event-strategies.ts; this
 * layer owns profile routing and section rendering only.
 */
export function buildKimiEventSections(
  payload: KimiEventObject,
  profile: AgentRowProjection | undefined,
  context: KimiEventBuilderContext,
): EventPresentationSection[] {
  return presentKimiEvent(payload, profile, context);
}
