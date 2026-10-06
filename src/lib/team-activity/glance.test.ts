import { describe, expect, it } from 'vitest';

import { glanceOf, numberBar } from './glance';
import { parseTeamActivityReport } from './report';

const person = (o: Record<string, unknown>) => ({
  kind: 'person',
  user_id: 'u',
  ...o,
});

describe('glanceOf', () => {
  it('reads replies out of ten on mature chats, floored', () => {
    const g = glanceOf(
      parseTeamActivityReport({
        senders: [
          person({ mature_started: 10, mature_no_reply: 7, today_starts: 3 }),
          person({ mature_started: 0, mature_no_reply: 0, pending_reply: 4 }),
        ],
        waiting_recent: 7,
        waiting_unassigned_recent: 2,
      })
    );
    expect(g.todayNew).toBe(3);
    expect(g.pending).toBe(4);
    expect(g.waitingRecent).toBe(7);
    expect(g.waitingUnassignedRecent).toBe(2);
    // 30% exactly: at the minimum, so inside the "close" band.
    expect(g.reply).toMatchObject({
      replied: 3,
      total: 10,
      outOfTen: 3,
      aimOutOfTen: 3,
      tone: 'warn',
    });
  });

  it('never rounds a rate below the minimum up to it', () => {
    const g = glanceOf(
      parseTeamActivityReport({
        senders: [person({ mature_started: 27, mature_no_reply: 19 })],
      })
    );
    // 29.6%: below 30, reads 2 in 10 and is "bad".
    expect(g.reply?.outOfTen).toBe(2);
    expect(g.reply?.tone).toBe('bad');
  });

  it('gives no reply figure below the minimum sample', () => {
    const g = glanceOf(
      parseTeamActivityReport({
        senders: [person({ mature_started: 4, mature_no_reply: 4 })],
      })
    );
    expect(g.reply).toBeNull();
  });
});

describe('numberBar', () => {
  const report = parseTeamActivityReport({
    scope: 'team',
    generated_at: '2026-10-06T10:00:00Z',
    numbers: [
      {
        channel_id: 'a',
        kind: 'phone',
        warming_up: true,
        effective_daily_limit: 10,
        today_started: 3,
        number_today_started: 9,
      },
      { channel_id: 'b', kind: 'official', today_started: 50 },
    ],
  });

  it('measures the whole number against its effective limit', () => {
    expect(numberBar(report.numbers[0], 'team', 40)).toEqual({
      count: 9,
      limit: 10,
      percent: 90,
      tone: 'warn',
      team: 3,
    });
    expect(numberBar(report.numbers[0], 'account', 40)?.team).toBeNull();
  });

  it('has no bar for an official number', () => {
    expect(numberBar(report.numbers[1], 'account', 40)).toBeNull();
  });
});
