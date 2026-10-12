import React, { useMemo } from 'react';
import type { AgentRowProjection } from '../../../shared/types';
import { CopyButton } from '../../copy-button';
import { ContentView } from '../../content-view';
import { HighlightedCode } from '../../code-syntax';
import { DiffView } from '../../diff-view';
import { eventSectionKey, type AgentEventPresentationModel, type EventPresentationSection, type FunctionCallView } from './model';

function FunctionCallArgumentsView({ view, expanded }: { view: FunctionCallView; expanded: boolean }): React.JSX.Element {
  const command = expanded ? view.command.fullCode ?? view.command.code : view.command.code;
  return (
    <div className="event-function-call-view">
      <div className="event-function-call-label">Command</div>
      <div className="event-code-language">
        <HighlightedCode
          source={command}
          language="shell"
          {...(view.command.mode ? { mode: view.command.mode } : {})}
          ariaLabel={view.name + ' command'}
          className="is-wrapped"
        />
      </div>
      {view.options ? (
        <div className="event-function-call-options">
          <div className="event-function-call-label">Options</div>
          <ContentView text={view.options.code} ariaLabel={view.name + ' options'} defaultMode="json" />
        </div>
      ) : null}
    </div>
  );
}

export interface AgentEventPresentationProps {
  value: unknown;
  profile?: AgentRowProjection | undefined;
  autoExpandFirstFullSection?: boolean;
  buildModel: (value: unknown, profile?: AgentRowProjection) => AgentEventPresentationModel | undefined;
}

export function AgentEventPresentation({ value, profile, autoExpandFirstFullSection = false, buildModel }: AgentEventPresentationProps): React.JSX.Element | null {
  const model: AgentEventPresentationModel | undefined = useMemo(
    () => buildModel(value, profile),
    [buildModel, profile, value],
  );
  const automaticSectionIndex = autoExpandFirstFullSection && model
    ? model.sections.findIndex((section) => section.truncated === true && section.fullText !== undefined)
    : -1;
  const [expandedSections, setExpandedSections] = React.useState<ReadonlySet<number>>(
    () => automaticSectionIndex >= 0 ? new Set([automaticSectionIndex]) : new Set(),
  );
  React.useEffect(() => {
    if (automaticSectionIndex < 0) return;
    setExpandedSections((current) => {
      if (current.size > 0 || current.has(automaticSectionIndex)) return current;
      return new Set([automaticSectionIndex]);
    });
  }, [automaticSectionIndex]);
  if (!model) return null;
  const sectionKeyOccurrences = new Map<string, number>();
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
        {model.sections.map((section: EventPresentationSection, index) => {
          const sectionKeyBase = eventSectionKey(section);
          const occurrence = sectionKeyOccurrences.get(sectionKeyBase) ?? 0;
          sectionKeyOccurrences.set(sectionKeyBase, occurrence + 1);
          return (
            <section className="event-section" key={sectionKeyBase + ':' + occurrence}>
              <div className="event-section-header">
                <h3>{section.title}</h3>
                <div className="event-section-actions">
                  {section.truncated ? (
                    <span
                      className="event-section-status"
                      role="status"
                      title={section.previewOnly ? 'Only the bounded presentation preview is available here; use Raw or Copy for source content.' : 'The initial presentation is bounded; expand the section to inspect the available value.'}
                    >
                      {section.previewOnly ? 'Preview only' : 'Preview limited'}
                    </span>
                  ) : null}
                  {section.truncated && section.fullText !== undefined ? (
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
                  <CopyButton
                    text={section.copyText ?? section.fullText ?? section.text ?? section.code ?? ''}
                    label={'Copy ' + section.title + (section.previewOnly ? ' preview' : '')}
                  />
                </div>
              </div>
              {section.previewOnly ? <div className="content-budget-notice" role="status">Preview limited by the record hydration budget; the complete value remains available in the Raw view when the source is complete.</div> : null}
              {section.text !== undefined ? (
                <ContentView
                  key={'content:' + (section.fullText ?? section.text ?? String(index))}
                  text={expandedSections.has(index) ? section.fullText ?? section.text : section.text}
                  truncated={section.truncated === true && !expandedSections.has(index)}
                  ariaLabel={section.title + ' content'}
                  defaultMode={section.contentMode ?? (section.richText ? 'markdown' : 'auto')}
                  {...(section.codeLanguage ? { codeLanguage: section.codeLanguage } : {})}
                />
              ) : null}
              {section.functionCall ? (
                <FunctionCallArgumentsView view={section.functionCall} expanded={expandedSections.has(index)} />
              ) : section.code !== undefined ? (
                section.language === 'diff'
                  ? <DiffView key={'diff-code:' + section.code} source={expandedSections.has(index) ? section.fullText ?? section.code : section.code} ariaLabel={section.title + ' unified diff'} />
                  : section.language === 'json'
                    ? <ContentView key={'json-code:' + section.code} text={expandedSections.has(index) ? section.fullText ?? section.code : section.code} truncated={section.truncated === true && !expandedSections.has(index)} ariaLabel={section.title + ' JSON'} defaultMode="json" />
                    : section.language
                      ? <div className="event-code-language"><HighlightedCode key={'code:' + section.code} source={expandedSections.has(index) ? section.fullText ?? section.code : section.code} language={section.language} ariaLabel={section.title + ' code'} {...(section.codeWrap ? { className: 'is-wrapped' } : {})} /></div>
                      : <ContentView key={'code:' + section.code} text={expandedSections.has(index) ? section.fullText ?? section.code : section.code} truncated={section.truncated === true && !expandedSections.has(index)} ariaLabel={section.title + ' code'} />
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
