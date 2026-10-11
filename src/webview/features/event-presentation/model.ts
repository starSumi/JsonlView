import type { ContentMode } from '../../content-view';

export interface FunctionCallView {
  name: string;
  command: {
    code: string;
    fullCode?: string;
    truncated: boolean;
    previewOnly: boolean;
    mode?: 'code' | 'patch';
  };
  options?: {
    code: string;
    fullCode?: string;
    truncated: boolean;
    previewOnly: boolean;
    mode?: 'code' | 'patch';
  };
}

/**
 * Bounded, provider-neutral data consumed by the event detail view.
 * Raw remains authoritative; this model is disposable presentation state.
 */
export interface EventPresentationSection {
  title: string;
  text?: string;
  fullText?: string;
  copyText?: string;
  truncated?: boolean;
  code?: string;
  language?: string;
  codeWrap?: boolean;
  richText?: boolean;
  previewOnly?: boolean;
  contentMode?: ContentMode;
  codeLanguage?: string;
  functionCall?: FunctionCallView;
}

export interface AgentEventPresentationModel {
  title: string;
  kind: string;
  metadata: Array<{ label: string; value: string }>;
  sections: EventPresentationSection[];
}

export function eventSectionKey(section: EventPresentationSection): string {
  return section.title + ':'
    + (section.fullText ?? section.text ?? section.code ?? section.language ?? 'empty') + ':'
    + (section.contentMode ?? 'auto') + ':'
    + (section.copyText ?? '');
}
