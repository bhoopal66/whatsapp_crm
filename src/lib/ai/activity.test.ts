import { describe, expect, it } from 'vitest';
import {
  parseActivityDays,
  summarizeAiActivity,
  type AiReplyEventRow,
  type AiUsageLogRow,
} from './activity';

function ev(over: Partial<AiReplyEventRow>): AiReplyEventRow {
  return {
    outcome: 'replied',
    tier: null,
    model: null,
    route_source: null,
    escalated: false,
    ...over,
  };
}

function use(over: Partial<AiUsageLogRow>): AiUsageLogRow {
  return {
    model: 'gpt-5.4-mini',
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    ...over,
  };
}

describe('parseActivityDays', () => {
  it('defaults to 7 when missing, blank or not a number', () => {
    expect(parseActivityDays(null)).toBe(7);
    expect(parseActivityDays('')).toBe(7);
    expect(parseActivityDays('abc')).toBe(7);
  });

  it('clamps to 1..90 and floors fractions', () => {
    expect(parseActivityDays('0')).toBe(1);
    expect(parseActivityDays('-5')).toBe(1);
    expect(parseActivityDays('500')).toBe(90);
    expect(parseActivityDays('30.9')).toBe(30);
  });
});

describe('summarizeAiActivity', () => {
  it('is all zeros for an empty window', () => {
    const s = summarizeAiActivity([], []);
    expect(s.total).toBe(0);
    expect(s.not_replied).toBe(0);
    expect(s.tiers).toEqual([
      { tier: 'small', replies: 0, model: null },
      { tier: 'standard', replies: 0, model: null },
      { tier: 'large', replies: 0, model: null },
    ]);
    expect(s.routing).toEqual({
      routed: 0,
      counts: { jev: 0, heuristic: 0, fixed: 0 },
      share: { jev: 0, heuristic: 0, fixed: 0 },
    });
    expect(s.tokens_by_model).toEqual([]);
  });

  it('splits the headline into replied, handed off, held and not replied', () => {
    const s = summarizeAiActivity(
      [
        ev({ outcome: 'replied' }),
        ev({ outcome: 'replied' }),
        ev({ outcome: 'handed_off' }),
        ev({ outcome: 'held_for_review' }),
        ev({ outcome: 'skipped_paused' }),
        ev({ outcome: 'skipped_assigned' }),
        ev({ outcome: 'skipped_paused' }),
        ev({ outcome: 'error' }),
      ],
      []
    );
    expect(s.total).toBe(8);
    expect(s.replied).toBe(2);
    expect(s.handed_off).toBe(1);
    expect(s.held_for_review).toBe(1);
    expect(s.not_replied).toBe(4);
    expect(s.by_outcome).toEqual({
      replied: 2,
      handed_off: 1,
      held_for_review: 1,
      skipped_paused: 2,
      skipped_assigned: 1,
      error: 1,
    });
    expect(s.not_replied_reasons[0]).toEqual({
      outcome: 'skipped_paused',
      count: 2,
    });
    expect(s.not_replied_reasons.map((r) => r.outcome).sort()).toEqual([
      'error',
      'skipped_assigned',
      'skipped_paused',
    ]);
  });

  it('counts an unknown outcome code as a reason it did not reply', () => {
    const s = summarizeAiActivity([ev({ outcome: 'skipped_future' })], []);
    expect(s.not_replied).toBe(1);
    expect(s.not_replied_reasons).toEqual([
      { outcome: 'skipped_future', count: 1 },
    ]);
  });

  it('groups replies by tier with the model that sent most of them', () => {
    const s = summarizeAiActivity(
      [
        ev({ tier: 'small', model: 'gpt-5.4-nano' }),
        ev({ tier: 'small', model: 'gpt-5.4-nano' }),
        ev({ tier: 'small', model: 'gpt-5.4-nano-old' }),
        ev({ tier: 'large', model: 'gpt-5.5' }),
        ev({ tier: 'standard', model: 'gpt-5.4-mini' }),
        // Not a reply: not counted in any tier.
        ev({ outcome: 'handed_off', tier: 'large', model: 'gpt-5.5' }),
      ],
      []
    );
    expect(s.tiers).toEqual([
      { tier: 'small', replies: 3, model: 'gpt-5.4-nano' },
      { tier: 'standard', replies: 1, model: 'gpt-5.4-mini' },
      { tier: 'large', replies: 1, model: 'gpt-5.5' },
    ]);
  });

  it('names the newest model on a tie and counts an untiered reply as standard', () => {
    const s = summarizeAiActivity(
      [
        ev({ tier: 'large', model: 'claude-opus-5-5' }),
        ev({ tier: 'large', model: 'claude-opus-4' }),
        ev({ tier: null, model: 'claude-haiku-4-5' }),
      ],
      []
    );
    expect(s.tiers[2]).toEqual({
      tier: 'large',
      replies: 2,
      model: 'claude-opus-5-5',
    });
    expect(s.tiers[1]).toEqual({
      tier: 'standard',
      replies: 1,
      model: 'claude-haiku-4-5',
    });
  });

  it('shares routing over the dispatches that recorded a source, and counts escalations', () => {
    const s = summarizeAiActivity(
      [
        ev({ route_source: 'jev', escalated: true }),
        ev({ route_source: 'jev' }),
        ev({ route_source: 'jev', outcome: 'held_for_review' }),
        ev({ route_source: 'heuristic', escalated: true }),
        ev({ outcome: 'skipped_paused' }),
      ],
      []
    );
    expect(s.routing.routed).toBe(4);
    expect(s.routing.counts).toEqual({ jev: 3, heuristic: 1, fixed: 0 });
    expect(s.routing.share).toEqual({ jev: 0.75, heuristic: 0.25, fixed: 0 });
    expect(s.escalated).toBe(2);
  });

  it('sums auto-reply tokens per model, largest first', () => {
    const s = summarizeAiActivity(
      [],
      [
        use({
          model: 'a',
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        }),
        use({
          model: 'b',
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        }),
        use({
          model: 'a',
          prompt_tokens: 1,
          completion_tokens: null,
          total_tokens: 1,
        }),
      ]
    );
    expect(s.tokens_by_model).toEqual([
      {
        model: 'b',
        calls: 1,
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
      {
        model: 'a',
        calls: 2,
        prompt_tokens: 11,
        completion_tokens: 5,
        total_tokens: 16,
      },
    ]);
  });
});
