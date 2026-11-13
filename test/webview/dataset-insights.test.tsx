import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { aggregateDatasetSummaries, summarizeDatasetRecord } from '../../src/profiles/dataset-analysis';
import { DatasetInsights } from '../../src/webview/dataset-insights';

describe('DatasetInsights', () => {
  it('discloses limited scope and separates declared counts from observed array lengths', () => {
    const sample = summarizeDatasetRecord({ input_ids: [1, 2, 3], token_count: 9, label: '<script>secret()</script>' });
    const summary = aggregateDatasetSummaries([sample], { scope: 'visible-page', partial: true });
    const markup = renderToStaticMarkup(<DatasetInsights summary={summary} />);
    expect(markup).toContain('Current page sample · 1 of 1 records · partial inspection');
    expect(markup).toContain('Observed token array lengths');
    expect(markup).toContain('Declared token counts');
    expect(markup).toContain('token count mismatch');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('No tokenizer or trainer configuration is inferred');
  });

  it('reports inspected roles, explicit weights, targets and inert media without copying prompts or URLs', () => {
    const sample = summarizeDatasetRecord({ messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.example/image.png' } }], loss_weight: 0 },
      { role: 'assistant', content: 'private response', loss_weight: 1 },
    ] });
    const summary = aggregateDatasetSummaries([sample], { scope: 'visible-page' });
    const markup = renderToStaticMarkup(<DatasetInsights summary={summary} />);
    expect(markup).toContain('Observed message roles');
    expect(markup).toContain('Declared message loss weights');
    expect(markup).toContain('2 of 2 messages inspected');
    expect(markup).toContain('Media references remain unopened');
    expect(markup).not.toContain('private.example');
    expect(markup).not.toContain('private response');
  });
});
