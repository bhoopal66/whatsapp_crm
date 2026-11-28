import { describe, expect, it, vi } from 'vitest';
import {
  canSend,
  GUARD_REASONS as R,
  marketingCapToday,
  nextUtcMidnight,
  recipientSuppression,
  type GuardContext,
  type GuardNumberState,
  type RecipientSignals,
  type SendRequest,
} from './guard';

const NOW = new Date('2026-11-28T15:00:00Z');

function ctx(over: {
  recipient?: Partial<RecipientSignals>;
  state?: Partial<GuardNumberState>;
  paused?: string[];
  counts?: { sentToday: number; newRecipientsToday: number };
  spendAllowed?: boolean;
  fail?: string;
}) {
  const release = vi.fn(async () => {});
  const boom = (name: string) => {
    if (over.fail === name) throw new Error('db down');
  };
  const c: GuardContext = {
    recipientSignals: vi.fn(async () => {
      boom('recipientSignals');
      return {
        optedOut: false,
        sentWithoutReply: 0,
        failedDeliveries: 0,
        ...over.recipient,
      };
    }),
    numberState: vi.fn(async () => {
      boom('numberState');
      return {
        qualityRating: 'GREEN' as const,
        messagingLimitTier: 'TIER_1K',
        accountStatus: 'CONNECTED' as const,
        numberAgeDays: 100,
        ...over.state,
      };
    }),
    pausedTemplates: vi.fn(async () => {
      boom('pausedTemplates');
      return over.paused ?? [];
    }),
    todayCounts: vi.fn(async () => {
      boom('todayCounts');
      return over.counts ?? { sentToday: 0, newRecipientsToday: 0 };
    }),
    reserveMarketingSpend: vi.fn(async () => {
      boom('spend');
      return { allowed: over.spendAllowed ?? true, release };
    }),
    now: () => NOW,
  };
  return { c, release };
}

const session: SendRequest = { kind: 'SESSION', contactId: 'c1' };
const mkt: SendRequest = {
  kind: 'TEMPLATE',
  contactId: 'c1',
  template: 'promo',
  category: 'MARKETING',
  costMicros: 1000,
};
const util: SendRequest = { ...mkt, template: 'receipt', category: 'UTILITY' };

describe('canSend rule order', () => {
  it('opt-out wins over everything, session replies included', async () => {
    const { c } = ctx({
      recipient: { optedOut: true },
      state: { accountStatus: 'BANNED' },
    });
    expect((await canSend(c, session)).reason).toBe(R.OPTED_OUT);
    expect((await canSend(c, mkt)).reason).toBe(R.OPTED_OUT);
    expect((await canSend(c, util)).reason).toBe(R.OPTED_OUT);
  });

  it('a total block stops session replies too', async () => {
    for (const s of ['BANNED', 'DISCONNECTED'] as const) {
      const { c } = ctx({ state: { accountStatus: s } });
      expect(await canSend(c, session)).toEqual({
        allow: false,
        reason: R.TOTAL_BLOCK,
      });
    }
  });

  it('a session reply skips pauses, suppression, ramp and spend', async () => {
    const { c } = ctx({
      state: { accountStatus: 'RESTRICTED', qualityRating: 'RED' },
      recipient: { failedDeliveries: 9 },
      spendAllowed: false,
    });
    expect(await canSend(c, session)).toEqual({
      allow: true,
      reason: R.SESSION_ALLOWED,
    });
    expect(c.reserveMarketingSpend).not.toHaveBeenCalled();
  });

  it('ALL_PAUSED denies marketing and utility', async () => {
    const { c } = ctx({ state: { accountStatus: 'RESTRICTED' } });
    expect((await canSend(c, mkt)).reason).toBe(R.NUMBER_ALL_PAUSED);
    expect((await canSend(c, util)).reason).toBe(R.NUMBER_ALL_PAUSED);
  });

  it('MARKETING_PAUSED denies marketing only', async () => {
    const { c } = ctx({ state: { qualityRating: 'RED' } });
    expect((await canSend(c, mkt)).reason).toBe(R.NUMBER_MARKETING_PAUSED);
    expect((await canSend(c, util)).reason).toBe(R.ALLOWED);
  });

  it('a paused template is denied for any template kind', async () => {
    const { c } = ctx({ paused: ['promo', 'receipt'] });
    expect((await canSend(c, mkt)).reason).toBe(R.TEMPLATE_PAUSED);
    expect((await canSend(c, util)).reason).toBe(R.TEMPLATE_PAUSED);
  });

  it('utility obeys only opt-out, total block, ALL_PAUSED and template pause', async () => {
    const { c } = ctx({
      recipient: { failedDeliveries: 5, sentWithoutReply: 9 },
      counts: { sentToday: 10_000, newRecipientsToday: 10_000 },
      spendAllowed: false,
      state: { accountStatus: 'FLAGGED' },
    });
    expect(await canSend(c, util)).toEqual({ allow: true, reason: R.ALLOWED });
    expect(c.reserveMarketingSpend).not.toHaveBeenCalled();
  });

  it('suppresses marketing on failures before no-reply', async () => {
    let { c } = ctx({
      recipient: { failedDeliveries: 2, sentWithoutReply: 3 },
    });
    expect((await canSend(c, mkt)).reason).toBe(R.SUPPRESSED_DELIVERY_FAILURES);
    ({ c } = ctx({ recipient: { sentWithoutReply: 3 } }));
    expect((await canSend(c, mkt)).reason).toBe(R.SUPPRESSED_NO_REPLY);
    ({ c } = ctx({ recipient: { sentWithoutReply: 2, failedDeliveries: 1 } }));
    expect((await canSend(c, mkt)).allow).toBe(true);
  });

  it('defers marketing to next UTC midnight once the ramp is spent', async () => {
    // TIER_1K mature GREEN → 600.
    const { c } = ctx({ counts: { sentToday: 600, newRecipientsToday: 0 } });
    expect(await canSend(c, mkt)).toEqual({
      allow: false,
      reason: R.RAMP_CAP_REACHED,
      deferUntil: '2026-11-29T00:00:00.000Z',
    });
    expect(c.reserveMarketingSpend).not.toHaveBeenCalled();
  });

  it('THROTTLED (YELLOW) halves the cap once, not twice', async () => {
    const { c } = ctx({
      state: { qualityRating: 'YELLOW' },
      counts: { sentToday: 299, newRecipientsToday: 0 },
    });
    expect((await canSend(c, mkt)).allow).toBe(true);
  });

  it('denies SPEND_CAP when the reservation is refused', async () => {
    const { c } = ctx({ spendAllowed: false });
    expect(await canSend(c, mkt)).toEqual({
      allow: false,
      reason: R.SPEND_CAP,
    });
    expect(c.reserveMarketingSpend).toHaveBeenCalledWith(1000);
  });

  it('an allowed marketing decision carries the release', async () => {
    const { c, release } = ctx({});
    const d = await canSend(c, mkt);
    expect(d.reason).toBe(R.ALLOWED);
    await d.release?.();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('unknown health never pauses', () => {
  it('null / UNKNOWN quality, status and tier allow marketing', async () => {
    const { c } = ctx({
      state: {
        qualityRating: 'UNKNOWN',
        accountStatus: null,
        messagingLimitTier: null,
      },
    });
    expect(await canSend(c, mkt)).toMatchObject({
      allow: true,
      reason: R.ALLOWED,
    });
    const { c: c2 } = ctx({
      state: { qualityRating: null, accountStatus: 'UNKNOWN' },
    });
    expect((await canSend(c2, mkt)).allow).toBe(true);
  });

  it('unknown quality keeps the full GREEN cap', () => {
    const base = { tier: 'TIER_1K', numberAgeDays: 100 };
    expect(marketingCapToday({ ...base, qualityRating: 'UNKNOWN' })).toBe(600);
    expect(marketingCapToday({ ...base, qualityRating: null })).toBe(600);
  });
});

describe('loader failures', () => {
  it('fail closed for templates', async () => {
    for (const f of [
      'recipientSignals',
      'numberState',
      'pausedTemplates',
      'todayCounts',
      'spend',
    ]) {
      const { c } = ctx({ fail: f });
      expect(await canSend(c, mkt)).toEqual({
        allow: false,
        reason: R.STATE_UNAVAILABLE,
      });
    }
    const { c } = ctx({ fail: 'numberState' });
    expect((await canSend(c, util)).reason).toBe(R.STATE_UNAVAILABLE);
  });

  it('a session reply degrades to allowed once opt-out passed', async () => {
    const { c } = ctx({ fail: 'numberState' });
    expect(await canSend(c, session)).toEqual({
      allow: true,
      reason: R.SESSION_ALLOWED_DEGRADED,
    });
  });

  it('a session reply is denied when the opt-out read fails', async () => {
    const { c } = ctx({ fail: 'recipientSignals' });
    expect((await canSend(c, session)).reason).toBe(R.STATE_UNAVAILABLE);
  });
});

describe('pure helpers', () => {
  it('caps by age, tier and quality', () => {
    expect(
      marketingCapToday({
        tier: 'TIER_1K',
        numberAgeDays: 3,
        qualityRating: 'GREEN',
      })
    ).toBe(250);
    expect(
      marketingCapToday({
        tier: 'TIER_250',
        numberAgeDays: 99,
        qualityRating: 'RED',
      })
    ).toBe(0);
    expect(
      marketingCapToday({
        tier: 'UNLIMITED',
        numberAgeDays: 99,
        qualityRating: 'GREEN',
      })
    ).toBe(Infinity);
    expect(
      marketingCapToday({
        tier: 'garbage',
        numberAgeDays: 99,
        qualityRating: 'GREEN',
      })
    ).toBe(150);
  });

  it('suppression thresholds', () => {
    const r = { optedOut: false, sentWithoutReply: 0, failedDeliveries: 0 };
    expect(recipientSuppression(r)).toBeNull();
    expect(recipientSuppression({ ...r, failedDeliveries: 2 })).toBe(
      'DELIVERY_FAILURES'
    );
    expect(recipientSuppression({ ...r, sentWithoutReply: 3 })).toBe(
      'NO_REPLY'
    );
  });

  it('next UTC midnight', () => {
    expect(nextUtcMidnight(new Date('2026-12-31T23:59:59Z'))).toBe(
      '2027-01-01T00:00:00.000Z'
    );
  });
});
