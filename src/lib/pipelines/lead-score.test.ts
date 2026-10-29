import { describe, expect, it } from 'vitest';

import {
  HOT_SCORE_MIN,
  WARM_SCORE_MIN,
  WEIGHT_ACTIVITY,
  WEIGHT_LEAD_TEMP,
  WEIGHT_STAGE,
  WEIGHT_URGENCY,
  WEIGHT_WAITING,
  leadScore,
  scoreBand,
  sortByLeadScore,
  stageProgress,
  type LeadScore,
  type LeadScoreInput,
} from './lead-score';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function input(over: Partial<LeadScoreInput> = {}): LeadScoreInput {
  return {
    status: 'open',
    dealCreatedAt: daysAgo(1),
    stageProgress: 0,
    conversation: null,
    now: NOW,
    ...over,
  };
}

describe('weights and bands', () => {
  it('weights sum to 100 when every factor is known', () => {
    expect(
      WEIGHT_LEAD_TEMP +
        WEIGHT_ACTIVITY +
        WEIGHT_URGENCY +
        WEIGHT_STAGE +
        WEIGHT_WAITING
    ).toBe(100);
  });

  it('bands at 70 and 40', () => {
    expect(HOT_SCORE_MIN).toBe(70);
    expect(WARM_SCORE_MIN).toBe(40);
    expect(scoreBand(70)).toBe('hot');
    expect(scoreBand(69)).toBe('warm');
    expect(scoreBand(40)).toBe('warm');
    expect(scoreBand(39)).toBe('cold');
  });
});

describe('stageProgress', () => {
  const stages = [
    { id: 'c', position: 2 },
    { id: 'a', position: 0 },
    { id: 'b', position: 1 },
  ];
  it('orders by position, 0 for the first and 1 for the last', () => {
    expect(stageProgress('a', stages)).toBe(0);
    expect(stageProgress('b', stages)).toBe(0.5);
    expect(stageProgress('c', stages)).toBe(1);
  });
  it('is 0 for an unknown stage or a single-stage pipeline', () => {
    expect(stageProgress('x', stages)).toBe(0);
    expect(stageProgress('a', [{ id: 'a', position: 0 }])).toBe(0);
  });
});

describe('leadScore', () => {
  it('gives won and lost deals no score', () => {
    expect(leadScore(input({ status: 'won' }))).toBeNull();
    expect(leadScore(input({ status: 'lost' }))).toBeNull();
    expect(leadScore(input({ status: undefined }))).not.toBeNull();
  });

  it('scores 100 with every factor at its top', () => {
    const s = leadScore(
      input({
        stageProgress: 1,
        conversation: {
          insight_lead_temp: 3,
          insight_urgency: 2,
          last_message_at: daysAgo(0),
          unread_count: 2,
        },
      })
    )!;
    expect(s.score).toBe(100);
    expect(s.band).toBe('hot');
    expect(s.basis).toBe('insights');
    expect(s.reasons).toEqual(['ready_to_apply', 'active_recently', 'urgent']);
    expect(s.atRisk).toBe(false);
  });

  it('weighs each factor by its named weight', () => {
    // Only lead temperature at the top, everything else zero.
    const s = leadScore(
      input({
        dealCreatedAt: daysAgo(30),
        conversation: { insight_lead_temp: 3, insight_urgency: 0 },
      })
    )!;
    expect(s.score).toBe(WEIGHT_LEAD_TEMP);
    expect(s.band).toBe('warm');
  });

  it('decays activity linearly over 14 days', () => {
    const at = (d: number) =>
      leadScore(
        input({
          conversation: {
            insight_lead_temp: 0,
            insight_urgency: 0,
            last_message_at: daysAgo(d),
          },
        })
      )!.score;
    expect(at(0)).toBe(WEIGHT_ACTIVITY);
    expect(at(7)).toBe(WEIGHT_ACTIVITY / 2);
    expect(at(14)).toBe(0);
    expect(at(40)).toBe(0);
  });

  it('rescales over activity, waiting and stage when Jev judged nothing', () => {
    const s = leadScore(
      input({
        stageProgress: 1,
        conversation: { last_message_at: daysAgo(0), unread_count: 1 },
      })
    )!;
    expect(s.basis).toBe('activity');
    expect(s.score).toBe(100);
    const half = leadScore(
      input({
        stageProgress: 1,
        conversation: { last_message_at: daysAgo(14) },
      })
    )!;
    expect(half.basis).toBe('activity');
    expect(half.score).toBe(
      Math.round(
        (100 * WEIGHT_STAGE) / (WEIGHT_STAGE + WEIGHT_ACTIVITY + WEIGHT_WAITING)
      )
    );
  });

  it('is at risk when upset, with upset as the first reason', () => {
    const s = leadScore(
      input({
        conversation: {
          insight_lead_temp: 3,
          insight_upset: 0.9,
          last_message_at: daysAgo(0),
        },
      })
    )!;
    expect(s.atRisk).toBe(true);
    expect(s.reasons[0]).toBe('upset');
  });

  it('is at risk after 14 quiet days, counted from the deal when it is newer', () => {
    const quiet = leadScore(
      input({
        dealCreatedAt: daysAgo(60),
        conversation: { last_message_at: daysAgo(15) },
      })
    )!;
    expect(quiet.atRisk).toBe(true);
    expect(quiet.reasons).toContain('quiet_14d');

    const newDeal = leadScore(
      input({
        dealCreatedAt: daysAgo(2),
        conversation: { last_message_at: daysAgo(30) },
      })
    )!;
    expect(newDeal.atRisk).toBe(false);

    // No last_message_at is not silence, whatever the deal's age.
    const emptyChat = leadScore(
      input({ dealCreatedAt: daysAgo(20), conversation: {} })
    )!;
    expect(emptyChat.atRisk).toBe(false);
    expect(emptyChat.reasons).not.toContain('quiet_14d');
  });

  it('scores a deal with no conversation data on stage alone, never at risk', () => {
    // No chat row: the contact has none, RLS hides it, or the read failed.
    const noChat = leadScore(
      input({ dealCreatedAt: daysAgo(60), stageProgress: 1 })
    )!;
    expect(noChat.atRisk).toBe(false);
    expect(noChat.basis).toBe('stage');
    expect(noChat.score).toBe(100);
    expect(noChat.reasons).toEqual(['late_stage']);

    const early = leadScore(
      input({ dealCreatedAt: daysAgo(60), stageProgress: 0 })
    )!;
    expect(early.basis).toBe('stage');
    expect(early.score).toBe(0);
    expect(early.atRisk).toBe(false);
    expect(early.reasons).toEqual([]);
  });

  it('keeps at most three reasons, hot lead and soon included', () => {
    const s = leadScore(
      input({
        stageProgress: 1,
        conversation: {
          insight_lead_temp: 1.6,
          insight_urgency: 1,
          last_message_at: daysAgo(1),
          unread_count: 1,
        },
      })
    )!;
    expect(s.reasons).toHaveLength(3);
    expect(s.reasons[0]).toBe('hot_lead');
    const soon = leadScore(input({ conversation: { insight_urgency: 1 } }))!;
    expect(soon.reasons).toContain('soon');
  });
});

describe('sortByLeadScore', () => {
  it('puts the highest first and unscored deals last, keeping ties in order', () => {
    const s = (score: number) => ({ score }) as LeadScore;
    const scores = new Map<string, LeadScore | null>([
      ['a', s(10)],
      ['b', s(80)],
      ['c', null],
      ['d', s(10)],
    ]);
    const deals = ['c', 'a', 'b', 'd'].map((id) => ({ id }));
    expect(sortByLeadScore(deals, scores).map((d) => d.id)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });
});
