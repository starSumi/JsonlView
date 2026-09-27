import { describe, expect, it } from 'vitest';
import { profileOptionList } from '../../src/webview/profile-options';

describe('profile option list', () => {
  it('places the strongest automatic match first and keeps generic in the list', () => {
    const options = profileOptionList(undefined, [
      { id: 'lower-match', displayName: 'Lower Match', score: 0.4 },
      { id: 'codex-rollout', displayName: 'Codex Rollout', score: 0.9 },
      { id: 'claude-code-session', displayName: 'Claude Code Session', score: 0 },
      { id: 'generic', displayName: 'Should not duplicate generic', score: 1 },
    ]);

    expect(options).toEqual({
      options: [
        { id: 'codex-rollout', displayName: 'Codex Rollout' },
        { id: 'lower-match', displayName: 'Lower Match' },
        { id: 'generic', displayName: 'Generic JSONL' },
        { id: 'claude-code-session', displayName: 'Claude Code Session' },
      ],
      suggested: { id: 'codex-rollout', displayName: 'Codex Rollout' },
    });
  });

  it('keeps a currently selected profile when it is absent from suggestions', () => {
    const options = profileOptionList('custom-profile', [
      { id: 'codex-rollout', displayName: 'Codex Rollout', score: 0.9 },
    ]);

    expect(options.options).toEqual([
      { id: 'codex-rollout', displayName: 'Codex Rollout' },
      { id: 'generic', displayName: 'Generic JSONL' },
      { id: 'custom-profile', displayName: 'custom-profile' },
    ]);
  });

  it('does not duplicate the current profile when it is already suggested', () => {
    const options = profileOptionList('codex-rollout', [
      { id: 'codex-rollout', displayName: 'Codex Rollout', score: 0.9 },
      { id: 'generic-agent-events', displayName: 'Generic Agent Events', score: 0 },
    ]);

    expect(options.options).toEqual([
      { id: 'codex-rollout', displayName: 'Codex Rollout' },
      { id: 'generic', displayName: 'Generic JSONL' },
      { id: 'generic-agent-events', displayName: 'Generic Agent Events' },
    ]);
    expect(options.suggested).toEqual({ id: 'codex-rollout', displayName: 'Codex Rollout' });
  });

  it('keeps equal-score suggestions stable and omits the hint without a match', () => {
    const options = profileOptionList(undefined, [
      { id: 'first', displayName: 'First', score: 0 },
      { id: 'second', displayName: 'Second', score: 0 },
    ]);

    expect(options.options).toEqual([
      { id: 'generic', displayName: 'Generic JSONL' },
      { id: 'first', displayName: 'First' },
      { id: 'second', displayName: 'Second' },
    ]);
    expect(options.suggested).toBeUndefined();
  });
});
