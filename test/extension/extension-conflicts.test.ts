import { describe, expect, it } from 'vitest';
import { findExtensionContributionConflict } from '../../src/extension/extension-conflicts';

describe('extension contribution conflict guard', () => {
  it('allows the active extension when unrelated extensions are installed', () => {
    expect(findExtensionContributionConflict('Sumi-Sophia.jsonl-view', [
      { id: 'Sumi-Sophia.jsonl-view', packageJSON: { contributes: { commands: [{ command: 'jsonlView.open' }] } } },
      { id: 'other.viewer', packageJSON: { contributes: { commands: [{ command: 'other.open' }] } } },
    ])).toBeUndefined();
  });

  it('reports the alternate registry build and all shared contribution ids', () => {
    expect(findExtensionContributionConflict('Sumi-Sophia.jsonl-view', [
      {
        id: 'Sumi-Sophia.jsonlview-data-studio',
        packageJSON: {
          contributes: {
            commands: [{ command: 'jsonlView.open' }],
            customEditors: [{ viewType: 'jsonlView.editor' }],
            configuration: { properties: { 'jsonlView.pageSize': { type: 'number' } } },
          },
        },
      },
    ])).toEqual({
      extensionId: 'Sumi-Sophia.jsonlview-data-studio',
      contributionIds: ['jsonlView.editor', 'jsonlView.open', 'jsonlView.pageSize'],
    });
  });

  it('also catches a legacy or development package that reuses a stable id', () => {
    expect(findExtensionContributionConflict('Sumi-Sophia.jsonl-view', [
      { id: 'momo.jsonl-view', packageJSON: { contributes: { commands: [{ command: 'jsonlView.rebuildIndex' }] } } },
    ])).toMatchObject({ extensionId: 'momo.jsonl-view' });
  });
});
