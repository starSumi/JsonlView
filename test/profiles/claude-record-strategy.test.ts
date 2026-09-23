import { describe, expect, it } from 'vitest';
import {
  classifyClaudeRecord,
  hasClaudeIdentityEnvelope,
  isClaudeJobTimelinePathHint,
  isClaudeJobTimelineState,
  isClaudeHistoryRecord,
  isClaudeJobTimelineRecord,
} from '../../src/profiles';
import { claudeFixture, claudeHistoryFixture, claudeJobTimelineFixture } from './fixtures';

describe('Claude record strategies', () => {
  it('classifies the observed surfaces without consulting a path or filesystem', () => {
    expect(classifyClaudeRecord(claudeJobTimelineFixture[0])).toBe('job-timeline');
    expect(classifyClaudeRecord(claudeHistoryFixture[0])).toBe('history');
    expect(classifyClaudeRecord(claudeFixture[0])).toBe('transcript');
    expect(classifyClaudeRecord({ at: '2026-08-30T02:10:00.000Z', state: 'done', detail: 'x', text: 'y' })).toBe('job-timeline');
  });

  it('requires the complete boundary evidence for specialized records', () => {
    expect(isClaudeJobTimelineRecord({ at: '2026-08-30T02:10:00.000Z', state: 'done', detail: 'x' })).toBe(false);
    expect(isClaudeJobTimelineRecord({ at: '2026-08-30T02:10:00.000Z', state: 'done', detail: 'x', text: 'y' })).toBe(true);
    expect(isClaudeJobTimelineRecord({ at: '2026-08-30T02:10:00.000Z', state: 'deploying', detail: 'x', text: 'y' })).toBe(false);
    expect(classifyClaudeRecord({ at: '2026-08-30T02:10:00.000Z', state: 'deploying', detail: 'x', text: 'y' })).toBe('unknown');
    expect(isClaudeHistoryRecord({ display: 'x', timestamp: 1, project: 'p', sessionId: 's', pastedContents: [] })).toBe(false);
    expect(isClaudeHistoryRecord(claudeHistoryFixture[0])).toBe(true);
  });

  it('keeps locator and identity evidence separate from the content-only strategy', () => {
    expect(isClaudeJobTimelinePathHint('C:/x/.claude/jobs/job-1/timeline.jsonl')).toBe(true);
    expect(isClaudeJobTimelinePathHint('C:/x/workflow/timeline.jsonl')).toBe(false);
    expect(isClaudeJobTimelineState('done')).toBe(true);
    expect(isClaudeJobTimelineState('info')).toBe(false);
    expect(hasClaudeIdentityEnvelope({ sessionId: 's', uuid: 'u' })).toBe(true);
    expect(hasClaudeIdentityEnvelope({ type: 'mode', sessionId: 's' })).toBe(false);
  });
});
