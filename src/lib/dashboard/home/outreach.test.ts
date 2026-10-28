import { describe, expect, it } from 'vitest';

import type { MyOutreachDay } from '@/lib/team-activity/thread-guard';
import { outreachBars, outreachTone, type OutreachNumber } from './outreach';

function day(over: Partial<MyOutreachDay> = {}): MyOutreachDay {
  return {
    started: 0,
    numbers: [],
    limits: {
      dailyNewChatsPerUser: 20,
      dailyNewChatsPerNumber: 40,
      maxUnansweredInRow: 3,
    },
    blockedWhenOver: false,
    ...over,
  };
}

const whapi: OutreachNumber = {
  id: 'n1',
  provider: 'whapi',
  label: 'Sales',
  waba_id: '+971500000001',
};
const openwa: OutreachNumber = {
  id: 'n2',
  provider: 'openwa',
  label: null,
  waba_id: '+971500000002',
};
const meta: OutreachNumber = {
  id: 'n3',
  provider: 'meta',
  label: 'Cloud',
  waba_id: 'waba',
};

describe('outreachTone', () => {
  it('is success under 80%, warning from 80%, destructive at 100%', () => {
    expect(outreachTone(15, 20)).toBe('success');
    expect(outreachTone(16, 20)).toBe('warning');
    expect(outreachTone(19, 20)).toBe('warning');
    expect(outreachTone(20, 20)).toBe('destructive');
    expect(outreachTone(25, 20)).toBe('destructive');
  });

  it('is success with no limit', () => {
    expect(outreachTone(50, null)).toBe('success');
    expect(outreachTone(50, 0)).toBe('success');
  });
});

describe('outreachBars', () => {
  it("clamps the person's percent to 0..100", () => {
    expect(outreachBars(day({ started: 30 }), []).me).toMatchObject({
      started: 30,
      limit: 20,
      percent: 100,
      tone: 'destructive',
    });
    expect(outreachBars(day({ started: 5 }), []).me.percent).toBe(25);
  });

  it('reads a limit of 0 as no limit', () => {
    const d = day({ started: 4 });
    d.limits.dailyNewChatsPerUser = 0;
    expect(outreachBars(d, []).me).toMatchObject({
      limit: null,
      percent: 0,
      tone: 'success',
    });
  });

  it('lists phone numbers only, named by label else phone, zero when idle', () => {
    const bars = outreachBars(
      day({ numbers: [{ channelId: 'n2', started: 8 }] }),
      [whapi, openwa, meta]
    ).numbers;
    expect(bars.map((b) => [b.key, b.name, b.started, b.limit])).toEqual([
      ['n1', 'Sales', 0, 40],
      ['n2', '+971500000002', 8, 40],
    ]);
  });

  it('holds a warming-up number to the warm-up limit', () => {
    const [b] = outreachBars(
      day({ numbers: [{ channelId: 'n1', started: 9, warmingUp: true }] }),
      [whapi]
    ).numbers;
    expect(b).toMatchObject({
      limit: 10,
      percent: 90,
      tone: 'warning',
      warmingUp: true,
    });
  });

  it("prefers the SQL's effective limit for today", () => {
    const [b] = outreachBars(
      day({
        numbers: [
          { channelId: 'n1', started: 3, effectiveLimit: 6, warmingUp: true },
        ],
      }),
      [whapi]
    ).numbers;
    expect(b).toMatchObject({ limit: 6, percent: 50, warmingUp: true });
  });
});
