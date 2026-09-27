import type { ProfileSuggestion } from '../shared/types';

export interface ProfileOption {
  id: string;
  displayName: string;
}

export interface ProfileOptionList {
  options: ProfileOption[];
  suggested?: ProfileOption;
}

export function profileOptionList(
  current: string | undefined,
  suggestions: ReadonlyArray<Pick<ProfileSuggestion, 'id' | 'displayName' | 'score'>>,
): ProfileOptionList {
  const seen = new Set<string>(['generic']);
  const rankedSuggestions = suggestions
    .map((suggestion, index) => ({ suggestion, index }))
    .filter(({ suggestion }) => {
      if (seen.has(suggestion.id)) return false;
      seen.add(suggestion.id);
      return true;
    })
    .sort((left, right) => right.suggestion.score - left.suggestion.score || left.index - right.index);
  const autoMatched = rankedSuggestions
    .filter(({ suggestion }) => suggestion.score > 0)
    .map(({ suggestion }) => ({ id: suggestion.id, displayName: suggestion.displayName }));
  const remainingProfiles = rankedSuggestions
    .filter(({ suggestion }) => suggestion.score <= 0)
    .map(({ suggestion }) => ({ id: suggestion.id, displayName: suggestion.displayName }));
  const generic = { id: 'generic', displayName: 'Generic JSONL' };

  if (current && !seen.has(current)) {
    remainingProfiles.unshift({ id: current, displayName: current });
  }

  return {
    options: [...autoMatched, generic, ...remainingProfiles],
    ...(autoMatched[0] === undefined ? {} : { suggested: autoMatched[0] }),
  };
}
