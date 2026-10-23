import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { aggregateBfclV3Summaries, summarizeBfclV3Record } from '../../src/profiles/datasets/bfcl-v3';
import { BfclInsights } from '../../src/webview/widgets/insights-panel/bfcl-insights';

describe('BfclInsights', () => {
  it('renders a distinct bounded BFCL view without source bodies', () => {
    const record = summarizeBfclV3Record({ id: 'multi_turn_1', multi_turn: true, functions: '[{"name":"private"}]', tools: '[]', missed_functions: '{}', initial_config: '{"token":"private"}', involved_classes: ['TravelAPI'], turns: '[[{"role":"user","content":"private prompt"}],[{"role":"assistant","content":"private answer"}]]', language: 'Python', test_category: 'multi_turn', subset: 'multi_turn', ground_truth: '[]' });
    const summary = aggregateBfclV3Summaries([record], { partial: true });
    const markup = renderToStaticMarkup(<BfclInsights summary={summary} />);
    expect(markup).toContain('BFCL dataset insights');
    expect(markup).toContain('Function definitions');
    expect(markup).toContain('Expected and missed calls');
    expect(markup).toContain('partial sample');
    expect(markup).not.toContain('private prompt');
    expect(markup).not.toContain('private answer');
    expect(markup).not.toContain('private');
    expect(markup).toContain('data-insight-kind="bfcl-v3"');
  });
});
