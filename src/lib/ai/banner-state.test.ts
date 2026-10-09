import { describe, expect, it } from 'vitest';

import { AI_DISPATCH_OUTCOMES } from './outcomes';
import {
  aiBannerState,
  autoResumeAfter,
  bannerSnapshot,
  lastAiReplyAt,
  lastMessageFromCustomer,
  withOverride,
  outcomeWarning,
  type AiBannerInput,
} from './banner-state';
import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';

function input(
  conversation: AiBannerInput['conversation'] = {},
  rest: Partial<Omit<AiBannerInput, 'conversation'>> = {}
): AiBannerInput {
  return {
    autoReplyOn: true,
    autoResumeMinutes: null,
    lastAiReplyAt: null,
    lastMessageFromCustomer: false,
    ...rest,
    conversation,
  };
}

describe('aiBannerState', () => {
  it('is hidden whenever the account bot is off, whatever the chat holds', () => {
    expect(
      aiBannerState(
        input(
          { ai_pending_draft: 'x', ai_autoreply_disabled: true },
          { autoReplyOn: false }
        )
      )
    ).toEqual({ kind: 'hidden' });
  });

  it('puts a held draft first, with the reason, even on a paused, assigned chat', () => {
    expect(
      aiBannerState(
        input({
          ai_pending_draft: 'Your card ships tomorrow.',
          ai_handoff_summary:
            'Mentions a refund amount not in the knowledge base',
          ai_autoreply_disabled: true,
          ai_paused_reason: 'handoff',
          assigned_agent_id: 'agent-1',
        })
      )
    ).toEqual({
      kind: 'draft',
      attention: false,
      draft: 'Your card ships tomorrow.',
      reason: 'Mentions a refund amount not in the knowledge base',
    });
  });

  it('a draft with no recorded reason has a null reason', () => {
    expect(aiBannerState(input({ ai_pending_draft: 'Hi' }))).toEqual({
      kind: 'draft',
      attention: false,
      draft: 'Hi',
      reason: null,
    });
  });

  it('a take-over pause offers reply-now only when the customer wrote last', () => {
    const c = {
      ai_autoreply_disabled: true,
      ai_paused_reason: 'take_over' as const,
    };
    expect(aiBannerState(input(c))).toEqual({
      kind: 'paused',
      attention: false,
      reason: 'take_over',
      summary: null,
      autoResume: null,
      replyNow: false,
    });
    expect(
      aiBannerState(input(c, { lastMessageFromCustomer: true }))
    ).toMatchObject({ kind: 'paused', replyNow: true });
  });

  it('an agent-reply pause carries the account auto-resume', () => {
    expect(
      aiBannerState(
        input(
          { ai_autoreply_disabled: true, ai_paused_reason: 'agent_reply' },
          { autoResumeMinutes: 240 }
        )
      )
    ).toMatchObject({
      kind: 'paused',
      attention: false,
      reason: 'agent_reply',
      autoResume: { unit: 'hours', count: 4 },
    });
  });

  it('auto-resume is not claimed for a take-over or a hand-off', () => {
    for (const reason of ['take_over', 'handoff'] as const) {
      expect(
        aiBannerState(
          input(
            { ai_autoreply_disabled: true, ai_paused_reason: reason },
            { autoResumeMinutes: 30 }
          )
        )
      ).toMatchObject({ autoResume: null });
    }
  });

  it('a hand-off pause shows the summary', () => {
    expect(
      aiBannerState(
        input({
          ai_autoreply_disabled: true,
          ai_paused_reason: 'handoff',
          ai_handoff_summary: 'Customer asked for a manager',
        })
      )
    ).toMatchObject({
      kind: 'paused',
      attention: false,
      reason: 'handoff',
      summary: 'Customer asked for a manager',
    });
  });

  it('classifies a pause with no reason the way 077 backfilled', () => {
    expect(
      aiBannerState(
        input({ ai_autoreply_disabled: true, ai_handoff_summary: 'note' })
      )
    ).toMatchObject({ reason: 'handoff', summary: 'note' });
    expect(aiBannerState(input({ ai_autoreply_disabled: true }))).toMatchObject(
      { reason: 'take_over' }
    );
  });

  it('an assigned chat that is not paused is the muted assigned state', () => {
    expect(aiBannerState(input({ assigned_agent_id: 'agent-1' }))).toEqual({
      kind: 'assigned',
      attention: false,
    });
  });

  it('an active chat with no outcome has no warning', () => {
    expect(aiBannerState(input({}))).toEqual({
      kind: 'active',
      attention: false,
      warning: null,
    });
  });

  it('warns about a skip newer than the last AI reply, with its detail', () => {
    expect(
      aiBannerState(
        input(
          {
            ai_last_outcome: 'error',
            ai_last_outcome_detail: 'OpenAI 429',
            ai_last_outcome_at: '2026-10-09T10:00:00Z',
          },
          { lastAiReplyAt: '2026-10-09T09:00:00Z' }
        )
      )
    ).toEqual({
      kind: 'active',
      attention: false,
      warning: { outcome: 'error', detail: 'OpenAI 429' },
    });
  });

  it('warns when the bot never replied in the thread', () => {
    expect(
      aiBannerState(
        input({
          ai_last_outcome: 'skipped_number',
          ai_last_outcome_at: '2026-10-09T10:00:00Z',
        })
      )
    ).toMatchObject({ warning: { outcome: 'skipped_number', detail: null } });
  });

  it('drops the warning once an AI reply is newer than the outcome', () => {
    expect(
      aiBannerState(
        input(
          {
            ai_last_outcome: 'skipped_automation',
            ai_last_outcome_at: '2026-10-09T10:00:00Z',
          },
          { lastAiReplyAt: '2026-10-09T10:05:00Z' }
        )
      )
    ).toEqual({ kind: 'active', attention: false, warning: null });
  });

  it('does not warn without an outcome time, or about routine outcomes', () => {
    expect(aiBannerState(input({ ai_last_outcome: 'error' }))).toEqual({
      kind: 'active',
      attention: false,
      warning: null,
    });
    expect(
      aiBannerState(
        input({
          ai_last_outcome: 'skipped_superseded',
          ai_last_outcome_at: '2026-10-09T10:00:00Z',
        })
      )
    ).toEqual({ kind: 'active', attention: false, warning: null });
  });
});

describe('aiBannerState attention (migration 078)', () => {
  const at = '2026-10-09T08:00:00Z';

  it('flags a hand-off needing a person, with its summary', () => {
    expect(
      aiBannerState(
        input(
          {
            ai_attention_at: at,
            ai_autoreply_disabled: true,
            ai_paused_reason: 'handoff',
            ai_handoff_summary: 'Asks for a refund',
          },
          { lastMessageFromCustomer: true }
        )
      )
    ).toEqual({
      kind: 'paused',
      attention: true,
      reason: 'handoff',
      summary: 'Asks for a refund',
      autoResume: null,
      replyNow: true,
    });
  });

  it('keeps the summary on any pause that still needs attention', () => {
    expect(
      aiBannerState(
        input({
          ai_attention_at: at,
          ai_autoreply_disabled: true,
          ai_paused_reason: 'take_over',
          ai_handoff_summary: 'Wants a call back',
        })
      )
    ).toMatchObject({ attention: true, summary: 'Wants a call back' });
  });

  it('flags a held draft, which keeps its own state', () => {
    expect(
      aiBannerState(input({ ai_attention_at: at, ai_pending_draft: 'Hi' }))
    ).toEqual({ kind: 'draft', draft: 'Hi', reason: null, attention: true });
  });

  it('flags the assigned and active states too', () => {
    expect(
      aiBannerState(input({ ai_attention_at: at, assigned_agent_id: 'a' }))
    ).toEqual({ kind: 'assigned', attention: true });
    expect(aiBannerState(input({ ai_attention_at: at }))).toMatchObject({
      kind: 'active',
      attention: true,
    });
  });

  it('is off once the stamp clears, and hidden with the bot off', () => {
    expect(
      aiBannerState(
        input({ ai_attention_at: null, ai_autoreply_disabled: true })
      )
    ).toMatchObject({ kind: 'paused', attention: false });
    expect(
      aiBannerState(input({ ai_attention_at: at }, { autoReplyOn: false }))
    ).toEqual({ kind: 'hidden' });
  });

  it('a change to the stamp is a new snapshot', () => {
    expect(bannerSnapshot({ ai_attention_at: at })).not.toBe(
      bannerSnapshot({ ai_attention_at: null })
    );
  });
});

describe('outcomeWarning', () => {
  it('warns about exactly the actionable outcomes', () => {
    const warned = AI_DISPATCH_OUTCOMES.filter((o) => outcomeWarning(o));
    expect(warned).toEqual([
      'skipped_number',
      'skipped_automation',
      'skipped_campaign_only',
      'skipped_rate_limited',
      'error',
    ]);
    expect(outcomeWarning(null)).toBeNull();
    expect(outcomeWarning('something_new')).toBeNull();
  });

  it('has a sentence for every warned outcome in both catalogues', () => {
    for (const outcome of AI_DISPATCH_OUTCOMES) {
      const key = outcomeWarning(outcome);
      if (!key) continue;
      for (const catalogue of [en, ko]) {
        const sentences = catalogue.Inbox.aiBanner.outcome as Record<
          string,
          string
        >;
        expect(sentences[key], `${key}`).toEqual(expect.any(String));
      }
    }
  });
});

describe('autoResumeAfter', () => {
  it.each([
    [null, null],
    [0, null],
    [30, { unit: 'minutes', count: 30 }],
    [60, { unit: 'hours', count: 1 }],
    [90, { unit: 'minutes', count: 90 }],
    [1440, { unit: 'hours', count: 24 }],
  ])('%s → %j', (minutes, expected) => {
    expect(autoResumeAfter(minutes)).toEqual(expected);
  });
});

describe('lastAiReplyAt', () => {
  it('is the newest bot-generated message, whatever the list order', () => {
    expect(
      lastAiReplyAt([
        { created_at: '2026-10-09T10:05:00Z', ai_generated: true },
        { created_at: '2026-10-09T10:09:00Z', ai_generated: false },
        { created_at: '2026-10-09T10:07:00Z', ai_generated: true },
        { created_at: '2026-10-09T10:01:00Z', ai_generated: true },
      ])
    ).toBe('2026-10-09T10:07:00Z');
  });

  it('is null with no bot message loaded', () => {
    expect(lastAiReplyAt([{ created_at: '2026-10-09T10:00:00Z' }])).toBeNull();
    expect(lastAiReplyAt([])).toBeNull();
  });
});

describe('lastMessageFromCustomer', () => {
  it("reads the newest message's sender", () => {
    const customerLast = [
      { created_at: '2026-10-09T10:00:00Z', sender_type: 'agent' },
      { created_at: '2026-10-09T10:02:00Z', sender_type: 'customer' },
    ];
    expect(lastMessageFromCustomer(customerLast)).toBe(true);
    expect(
      lastMessageFromCustomer([
        ...customerLast,
        { created_at: '2026-10-09T10:03:00Z', sender_type: 'bot' },
      ])
    ).toBe(false);
  });

  it('goes by created_at, not position, and is false when empty', () => {
    expect(
      lastMessageFromCustomer([
        { created_at: '2026-10-09T10:05:00Z', sender_type: 'customer' },
        { created_at: '2026-10-09T10:01:00Z', sender_type: 'agent' },
      ])
    ).toBe(true);
    expect(lastMessageFromCustomer([])).toBe(false);
  });
});

describe('withOverride', () => {
  const server = {
    id: 'c1',
    ai_autoreply_disabled: false,
    ai_paused_reason: null as string | null,
  };
  const paused = { ai_autoreply_disabled: true, ai_paused_reason: 'take_over' };

  it('applies a click to the snapshot it was made against', () => {
    expect(
      withOverride('c1', server, {
        forConversation: 'c1',
        forSnapshot: bannerSnapshot(server),
        value: paused,
      })
    ).toEqual({ ...server, ...paused });
  });

  it('yields to the server once the row changes', () => {
    const override = {
      forConversation: 'c1',
      forSnapshot: bannerSnapshot(server),
      value: paused,
    };
    const updated = { ...server, ai_last_outcome: 'error' };
    expect(withOverride('c1', updated, override)).toBe(updated);
  });

  it('never carries over to another chat with an identical snapshot', () => {
    const other = { ...server, id: 'c2' };
    expect(
      withOverride('c2', other, {
        forConversation: 'c1',
        forSnapshot: bannerSnapshot(server),
        value: paused,
      })
    ).toBe(other);
  });

  it('is the server row with no override', () => {
    expect(withOverride('c1', server, null)).toBe(server);
  });
});
