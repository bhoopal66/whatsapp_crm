import { describe, expect, it } from 'vitest';

import { TEAM_ACTIVITY_DEFAULTS } from './limits';
import {
  isListedSender,
  numberDisplayName,
  parseTeamActivityReport,
  replyRate,
  totalsOf,
} from './report';

const RAW = {
  tz: 'Asia/Dubai',
  today: '2026-10-01',
  from: '2026-09-24T20:00:00+00:00',
  to: '2026-10-01T09:00:00+00:00',
  channel_id: null,
  generated_at: '2026-10-01T09:00:01+00:00',
  limits: {
    daily_new_chats_per_user: 15,
    daily_new_chats_per_number: 40,
    min_reply_rate: 30,
    max_unanswered_in_row: 3,
    burst_new_chats_10min: 10,
    quiet_hours_start: 22,
    quiet_hours_end: 8,
    timezone: 'Asia/Dubai',
    notify: true,
    block_over_limit: false,
    saved: true,
  },
  waiting_unassigned: 2,
  senders: [
    {
      kind: 'person',
      user_id: 'u1',
      name: 'Agent One',
      email: 'one@example.com',
      role: 'agent',
      avatar_url: null,
      messages_sent: 40,
      chats_started: 12,
      new_contacts: 10,
      no_reply: 8,
      failed: 1,
      today_starts: 3,
      unanswered_over_limit: 2,
      response_median_min: 4.5,
      waiting: 1,
      waiting_oldest_min: null,
    },
    {
      kind: 'api',
      user_id: null,
      messages_sent: 5,
      chats_started: 5,
      no_reply: 3,
    },
    { kind: 'bot', user_id: null },
    { kind: 'person', user_id: 'u2', name: 'Quiet Member' },
  ],
  numbers: [
    {
      channel_id: 'w1',
      provider: 'whapi',
      label: null,
      waba_id: '971500000001',
      phone_number_id: 'CHANNEL-1',
      status: 'connected',
      is_primary: true,
      chats_started: 17,
      today_starts: 3,
    },
    { channel_id: null, chats_started: 1 },
  ],
  daily: [
    { day: '2026-09-30', started: 4, no_reply: '2', sent: 9, received: 3 },
  ],
  hourly: [{ hour: 9, started: 2, sent: 5 }],
};

describe('parseTeamActivityReport', () => {
  const report = parseTeamActivityReport(RAW);

  it('reads the envelope and the limits', () => {
    expect(report.tz).toBe('Asia/Dubai');
    expect(report.today).toBe('2026-10-01');
    expect(report.limitsSaved).toBe(true);
    expect(report.limits.dailyNewChatsPerUser).toBe(15);
    expect(report.waitingUnassigned).toBe(2);
  });

  it('fills missing counts with 0 and keeps null medians', () => {
    const bot = report.senders.find((s) => s.kind === 'bot')!;
    expect(bot.messagesSent).toBe(0);
    expect(bot.responseMedianMin).toBeNull();
    const one = report.senders[0];
    expect(one.responseMedianMin).toBe(4.5);
    expect(one.waitingOldestMin).toBeNull();
    expect(report.daily[0].noReply).toBe(2);
  });

  it('drops the no-number bucket into unattributedStarts (D1)', () => {
    expect(report.numbers).toHaveLength(1);
    expect(report.unattributedStarts).toBe(1);
  });

  it('falls back to the 068 fields', () => {
    const one = report.senders[0];
    expect(one.matureStarted).toBe(12);
    expect(one.matureNoReply).toBe(8);
    expect(one.waitingRecent).toBe(1);
    expect(one.failedPhone).toBe(0);
    expect(one.daysAtLimit).toBe(one.daysOverLimit);
    expect(report.daily[0].pendingReply).toBe(0);
    expect(report.scope).toBe('account');
    expect(report.waitingRecent).toBe(3);
    const n = report.numbers[0];
    expect(n.kind).toBe('phone');
    expect(n.numberTodayStarted).toBe(3);
    expect(n.effectiveDailyLimit).toBe(40);
  });

  it('reads the 073 fields', () => {
    const r = parseTeamActivityReport({
      scope: 'team',
      team_names: ['Sales', 7],
      waiting_recent: 4,
      unattributed_starts: 9,
      senders: [
        {
          kind: 'user',
          user_id: 'u1',
          mature_started: 6,
          pending_reply: 2,
          chase_new: 1,
          failed_phone: 2,
          failed_official: 5,
          days_over_limit: 1,
          days_at_limit: 3,
        },
        { kind: 'api', replies: null, response_median_min: null },
      ],
      numbers: [
        { channel_id: 'm1', kind: 'official', provider: 'meta' },
        {
          channel_id: 'w1',
          kind: 'phone',
          warming_up: true,
          age_days: 3,
          effective_daily_limit: 10,
          today_started: 2,
          number_today_started: 9,
        },
      ],
    });
    expect(r.scope).toBe('team');
    expect(r.teamNames).toEqual(['Sales']);
    expect(r.unattributedStarts).toBe(9);
    expect(r.senders[0]).toMatchObject({
      kind: 'person',
      matureStarted: 6,
      pendingReply: 2,
      chaseNew: 1,
      failedPhone: 2,
      failedOfficial: 5,
      daysOverLimit: 1,
      daysAtLimit: 3,
    });
    expect(r.senders[1]).toMatchObject({
      kind: 'api',
      replies: 0,
      responseMedianMin: null,
    });
    expect(r.numbers[0]).toMatchObject({
      kind: 'official',
      effectiveDailyLimit: null,
      warmingUp: false,
    });
    expect(r.numbers[1]).toMatchObject({
      warmingUp: true,
      ageDays: 3,
      effectiveDailyLimit: 10,
      todayStarts: 2,
      numberTodayStarted: 9,
    });
  });

  it('works out warm-up from created_at on 068', () => {
    const r = parseTeamActivityReport({
      generated_at: '2026-10-01T00:00:00Z',
      numbers: [
        {
          channel_id: 'a',
          provider: 'whapi',
          created_at: '2026-09-25T00:00:00Z',
        },
        {
          channel_id: 'b',
          provider: 'whapi',
          created_at: '2026-09-01T00:00:00Z',
        },
      ],
    });
    expect(
      r.numbers.map((n) => [n.warmingUp, n.ageDays, n.effectiveDailyLimit])
    ).toEqual([
      [true, 6, 10],
      [false, 30, 50],
    ]);
  });

  it('never throws on garbage', () => {
    const empty = parseTeamActivityReport('nonsense');
    expect(empty.senders).toEqual([]);
    expect(empty.limits).toEqual(TEAM_ACTIVITY_DEFAULTS);
    expect(empty.tz).toBe('UTC');
  });
});

describe('totals and listing', () => {
  const report = parseTeamActivityReport(RAW);

  it('sums every sender, plus the unassigned waiting chats', () => {
    const t = totalsOf(report);
    expect(t.chatsStarted).toBe(17);
    expect(t.noReply).toBe(11);
    expect(t.messagesSent).toBe(45);
    expect(t.waiting).toBe(3);
  });

  it('lists every member but only active API and bot rows', () => {
    const listed = report.senders.filter(isListedSender).map((s) => s.kind);
    expect(listed).toEqual(['person', 'api', 'person']);
  });
});

describe('replyRate', () => {
  it('is the answered share, rounded', () => {
    expect(replyRate(12, 8)).toBe(33);
    expect(replyRate(3, 0)).toBe(100);
    expect(replyRate(0, 0)).toBeNull();
  });
});

describe('numberDisplayName', () => {
  it('prefers the label, then the Whapi phone, then the id', () => {
    expect(
      numberDisplayName({
        label: 'Sales',
        wabaId: '9715',
        phoneNumberId: 'x',
        provider: 'whapi',
      })
    ).toBe('Sales');
    expect(
      numberDisplayName({
        label: null,
        wabaId: '971500000001',
        phoneNumberId: 'x',
        provider: 'whapi',
      })
    ).toBe('+971500000001');
    expect(
      numberDisplayName({
        label: null,
        wabaId: 'WABA',
        phoneNumberId: '1234',
        provider: 'meta',
      })
    ).toBe('1234');
  });
});
