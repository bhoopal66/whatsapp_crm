import { describe, expect, it } from 'vitest';

import { INTENTS } from '@/lib/typesafe/questions/triage';

import {
  GAP_TOPIC_INTENTS,
  coverageBadge,
  defaultGapView,
  knownIntent,
  latestComputedAt,
  sortTopics,
  splitTopics,
  trimExamples,
  type GapTopicView,
} from './gap-topics-view';

function topic(over: Partial<GapTopicView>): GapTopicView {
  return {
    id: 'x',
    label: 'How do I open an account?',
    intent: null,
    question_count: 1,
    first_seen_at: '2026-10-01T00:00:00Z',
    last_seen_at: '2026-10-01T00:00:00Z',
    coverage: 'unknown',
    covered_by_entry_id: null,
    covered_by_title: null,
    status: 'open',
    dismissed_at: null,
    examples: [],
    ...over,
  };
}

describe('sortTopics / splitTopics', () => {
  it('puts open before dismissed, then count desc, then newest', () => {
    const rows = [
      topic({ id: 'd', status: 'dismissed', question_count: 50 }),
      topic({
        id: 'a',
        question_count: 3,
        last_seen_at: '2026-10-02T00:00:00Z',
      }),
      topic({
        id: 'b',
        question_count: 3,
        last_seen_at: '2026-10-05T00:00:00Z',
      }),
      topic({ id: 'c', question_count: 9 }),
    ];
    expect(sortTopics(rows).map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']);
    const { open, dismissed } = splitTopics(rows);
    expect(open.map((t) => t.id)).toEqual(['c', 'b', 'a']);
    expect(dismissed.map((t) => t.id)).toEqual(['d']);
  });

  it('does not mutate its input', () => {
    const rows = [topic({ id: 'a' }), topic({ id: 'b', question_count: 2 })];
    sortTopics(rows);
    expect(rows.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('coverageBadge', () => {
  it('maps coverage to tone and carries the entry title', () => {
    expect(coverageBadge(topic({ coverage: 'none' }))).toEqual({
      kind: 'none',
      tone: 'warning',
    });
    expect(
      coverageBadge(topic({ coverage: 'partial', covered_by_title: 'Fees?' }))
    ).toEqual({ kind: 'partial', tone: 'info', entry: 'Fees?' });
    expect(coverageBadge(topic({ coverage: 'full' }))).toEqual({
      kind: 'full',
      tone: 'success',
      entry: null,
    });
  });

  it('shows nothing while coverage is unknown', () => {
    expect(coverageBadge(topic({ coverage: 'unknown' }))).toBeNull();
  });
});

describe('trimExamples', () => {
  it('drops blanks, the label and repeats, and caps at 3', () => {
    expect(
      trimExamples('Open account?', [
        ' open account? ',
        '',
        'Fees for POS',
        'fees for pos',
        'Loan rates',
        'Card limit',
        'Fifth',
      ])
    ).toEqual(['Fees for POS', 'Loan rates', 'Card limit']);
  });
});

describe('defaultGapView / latestComputedAt / knownIntent', () => {
  it('defaults to topics only when one exists', () => {
    expect(defaultGapView(0)).toBe('questions');
    expect(defaultGapView(2)).toBe('topics');
  });

  it('picks the newest computed_at', () => {
    expect(latestComputedAt([])).toBeNull();
    expect(
      latestComputedAt([
        { computed_at: '2026-10-01T00:00:00Z' },
        { computed_at: '2026-10-03T00:00:00Z' },
        { computed_at: null },
      ])
    ).toBe('2026-10-03T00:00:00Z');
  });

  it('knows exactly the triage intents', () => {
    expect([...GAP_TOPIC_INTENTS].sort()).toEqual(Object.keys(INTENTS).sort());
    expect(knownIntent('business_loan')).toBe('business_loan');
    expect(knownIntent('made_up')).toBeNull();
    expect(knownIntent(null)).toBeNull();
  });
});
