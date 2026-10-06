import { describe, expect, it } from 'vitest';

import {
  limitNotices,
  outreachNotices,
  parseMyOutreachDay,
  unansweredRun,
  wouldStartChat,
  type MyOutreachDay,
  type ThreadMessageLike,
} from './thread-guard';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const at = (hoursAgo: number) =>
  new Date(NOW - hoursAgo * 3600_000).toISOString();
const msg = (
  sender_type: string,
  hoursAgo: number,
  status: string | null = 'sent'
): ThreadMessageLike => ({ sender_type, created_at: at(hoursAgo), status });

function day(over: Partial<MyOutreachDay> = {}): MyOutreachDay {
  return {
    started: 0,
    numbers: [],
    limits: {
      dailyNewChatsPerUser: 20,
      dailyNewChatsPerNumber: 50,
      maxUnansweredInRow: 3,
    },
    blockedWhenOver: false,
    ...over,
  };
}

describe('unansweredRun', () => {
  it('counts our messages since the customer last wrote', () => {
    expect(
      unansweredRun([
        msg('customer', 5),
        msg('agent', 4),
        msg('bot', 3),
        msg('agent', 2),
      ])
    ).toBe(3);
    expect(unansweredRun([msg('agent', 4), msg('customer', 3)])).toBe(0);
  });

  it('counts everything when the customer never wrote, but not failed sends', () => {
    expect(
      unansweredRun([
        msg('agent', 4),
        msg('agent', 3, 'failed'),
        msg('agent', 2),
      ])
    ).toBe(2);
  });

  it('does not depend on the order it is given', () => {
    expect(
      unansweredRun([msg('agent', 1), msg('customer', 9), msg('agent', 5)])
    ).toBe(2);
  });
});

describe('wouldStartChat', () => {
  it('is true for an empty thread or 24 hours of our silence', () => {
    expect(wouldStartChat([], NOW)).toBe(true);
    expect(wouldStartChat([msg('agent', 25)], NOW)).toBe(true);
    expect(wouldStartChat([msg('agent', 24)], NOW)).toBe(true);
    expect(wouldStartChat([msg('agent', 23)], NOW)).toBe(false);
  });

  it('is a reply, however late, when the customer wrote last', () => {
    expect(wouldStartChat([msg('agent', 80), msg('customer', 72)], NOW)).toBe(
      false
    );
    expect(wouldStartChat([msg('customer', 72), msg('agent', 48)], NOW)).toBe(
      true
    );
  });

  it('ignores a failed send', () => {
    expect(
      wouldStartChat([msg('agent', 30), msg('agent', 1, 'failed')], NOW)
    ).toBe(true);
    expect(
      wouldStartChat([msg('customer', 30), msg('agent', 1, 'failed')], NOW)
    ).toBe(false);
  });
});

describe('outreachNotices', () => {
  const base = { channelId: 'w1', provider: 'whapi' as const, now: NOW };

  it('says nothing on a Meta number', () => {
    expect(
      outreachNotices({
        ...base,
        provider: 'meta',
        messages: [],
        day: day({ started: 99 }),
      })
    ).toEqual([]);
  });

  it('warns near the limit and stops at it, only for a new chat', () => {
    expect(
      outreachNotices({ ...base, messages: [], day: day({ started: 16 }) })[0]
    ).toMatchObject({
      kind: 'limit_near',
      started: 16,
      limit: 20,
    });
    expect(
      outreachNotices({
        ...base,
        messages: [],
        day: day({ started: 20, blockedWhenOver: true }),
      })[0]
    ).toMatchObject({ kind: 'limit_reached', blocked: true });
    // A reply inside 24 hours is not a new chat.
    expect(
      outreachNotices({
        ...base,
        messages: [msg('customer', 1)],
        day: day({ started: 25 }),
      })
    ).toEqual([]);
  });

  it('flags the number at its own limit', () => {
    const n = outreachNotices({
      ...base,
      messages: [],
      day: day({ numbers: [{ channelId: 'w1', started: 50 }] }),
    });
    expect(n.map((x) => x.kind)).toEqual(['number_limit']);
    expect(
      outreachNotices({
        ...base,
        channelId: 'w2',
        messages: [],
        day: day({ numbers: [{ channelId: 'w1', started: 50 }] }),
      }).map((x) => x.kind)
    ).toEqual(['new_contact_tip']);
  });

  it('warns once the contact has not answered max messages in a row', () => {
    const messages = [
      msg('customer', 6),
      msg('agent', 3),
      msg('agent', 2),
      msg('agent', 1),
    ];
    expect(outreachNotices({ ...base, messages, day: day() })).toEqual([
      { kind: 'unanswered', severity: 'warning', count: 3, max: 3 },
    ]);
    expect(
      outreachNotices({ ...base, messages: messages.slice(0, 3), day: day() })
    ).toEqual([]);
  });

  it('still warns about unanswered messages without the day figures', () => {
    const messages = [msg('agent', 3), msg('agent', 2), msg('agent', 1)];
    expect(
      outreachNotices({ ...base, messages, day: null }).map((x) => x.kind)
    ).toEqual(['unanswered']);
  });

  it('gives the new-contact tip only when nothing louder applies', () => {
    expect(outreachNotices({ ...base, messages: [], day: day() })).toEqual([
      { kind: 'new_contact_tip', severity: 'info' },
    ]);
    expect(
      outreachNotices({ ...base, messages: [msg('customer', 72)], day: day() })
    ).toEqual([]);
  });
});

describe('parseMyOutreachDay', () => {
  it('reads the RPC payload', () => {
    expect(
      parseMyOutreachDay({
        started: 4,
        numbers: [
          { channel_id: 'w1', started: 9 },
          { channel_id: null, started: 1 },
        ],
        limits: {
          daily_new_chats_per_user: 10,
          daily_new_chats_per_number: 30,
          max_unanswered_in_row: 2,
        },
        blocked_when_over: true,
      })
    ).toEqual({
      started: 4,
      numbers: [
        { channelId: 'w1', started: 9, effectiveLimit: null, warmingUp: null },
      ],
      limits: {
        dailyNewChatsPerUser: 10,
        dailyNewChatsPerNumber: 30,
        maxUnansweredInRow: 2,
      },
      blockedWhenOver: true,
    });
  });

  it('rejects anything else', () => {
    expect(parseMyOutreachDay(null)).toBeNull();
    expect(parseMyOutreachDay({ started: '4' })).toBeNull();
  });
});

describe('limitNotices', () => {
  it('only speaks for a new chat on a Whapi number', () => {
    const d = day({ started: 30 });
    expect(
      limitNotices({
        starting: false,
        day: d,
        channelId: 'w1',
        provider: 'whapi',
      })
    ).toEqual([]);
    expect(
      limitNotices({
        starting: true,
        day: d,
        channelId: 'w1',
        provider: 'meta',
      })
    ).toEqual([]);
    expect(
      limitNotices({
        starting: true,
        day: null,
        channelId: 'w1',
        provider: 'whapi',
      })
    ).toEqual([]);
    expect(
      limitNotices({
        starting: true,
        day: d,
        channelId: 'w1',
        provider: 'whapi',
      }).map((n) => n.kind)
    ).toEqual(['limit_reached']);
  });
});

describe('number limit: >= and warm-up (D5, D6)', () => {
  const base = {
    starting: true,
    channelId: 'w1',
    provider: 'whapi' as const,
  };
  it('is reached at the limit itself', () => {
    const d = day({ numbers: [{ channelId: 'w1', started: 50 }] });
    expect(limitNotices({ ...base, day: d })).toMatchObject([
      { kind: 'number_limit', limit: 50, warmingUp: false },
    ]);
    const u = day({ started: 20 });
    expect(limitNotices({ ...base, day: u })[0].kind).toBe('limit_reached');
  });
  it('uses the warm-up limit from created_at', () => {
    const d = day({ numbers: [{ channelId: 'w1', started: 10 }] });
    expect(
      limitNotices({ ...base, day: d, numberCreatedAt: at(24 * 3), now: NOW })
    ).toMatchObject([{ kind: 'number_limit', limit: 10, warmingUp: true }]);
    expect(
      limitNotices({ ...base, day: d, numberCreatedAt: at(24 * 15), now: NOW })
    ).toEqual([]);
  });
  it("prefers the SQL's effective limit", () => {
    const d = day({
      numbers: [{ channelId: 'w1', started: 10, effectiveLimit: 10 }],
    });
    expect(
      parseMyOutreachDay({
        started: 0,
        numbers: [
          {
            channel_id: 'w1',
            started: 10,
            warming_up: true,
            effective_daily_limit: 10,
          },
        ],
      })?.numbers[0]
    ).toEqual({
      channelId: 'w1',
      started: 10,
      effectiveLimit: 10,
      warmingUp: true,
    });
    expect(limitNotices({ ...base, day: d })).toMatchObject([
      { limit: 10, warmingUp: true },
    ]);
  });
});
