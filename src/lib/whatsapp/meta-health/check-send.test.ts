import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  checkSend,
  refundSendReservation,
  type CheckSendInput,
} from './check-send';

const NOW = () => new Date('2026-11-28T15:00:00Z');
type Res = { data: unknown; error: unknown };

/** A fake service-role client: rpc answers by name, tables by name. */
function fake(
  opts: {
    enforce?: boolean;
    rpc?: Record<string, () => Res>;
    tables?: Record<string, unknown[]>;
  } = {}
) {
  const answers: Record<string, () => Res> = {
    meta_protection_settings_get: () => ({
      data: [{ enforce: opts.enforce ?? true }],
      error: null,
    }),
    send_protection_recipient_signals: () => ({
      data: [{ opted_out: false, sent_without_reply: 0, failed_deliveries: 0 }],
      error: null,
    }),
    meta_marketing_sent_today: () => ({ data: 0, error: null }),
    send_protection_caps_get: () => ({
      data: [{ daily_marketing_spend_micros: 10_000 }],
      error: null,
    }),
    send_protection_spend_add: () => ({
      data: [{ allowed: true, total_micros: 700, day: '2026-11-29' }],
      error: null,
    }),
    send_protection_decision_record: () => ({ data: 1, error: null }),
    send_protection_spend_refund: () => ({ data: 0, error: null }),
    ...opts.rpc,
  };
  const tables: Record<string, unknown[]> = {
    meta_number_state: [
      {
        quality_rating: 'GREEN',
        messaging_limit_tier: 'TIER_1K',
        account_status: 'CONNECTED',
        assessed_state: 'NORMAL',
        reasons: [],
      },
    ],
    whatsapp_config: [{ provider: 'meta', created_at: '2026-01-01T00:00:00Z' }],
    meta_template_health: [],
    ...opts.tables,
  };
  const rpc = vi.fn(async (fn: string) => {
    const a = answers[fn];
    if (!a) throw new Error(`unexpected rpc ${fn}`);
    return a();
  });
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (ok: (r: Res) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(ok),
    };
    return q;
  };
  return { client: { rpc, from } as unknown as SupabaseClient, rpc };
}

const base = { accountId: 'acc', configId: 'cfg', contactId: 'ct' };
const mkt: CheckSendInput = {
  ...base,
  kind: 'MARKETING',
  templateName: 'promo',
  costMicros: 700,
};
const util: CheckSendInput = {
  ...base,
  kind: 'UTILITY',
  templateName: 'receipt',
};
const session: CheckSendInput = { ...base, kind: 'SESSION' };

const calls = (rpc: ReturnType<typeof vi.fn>, fn: string) =>
  rpc.mock.calls.filter((c) => c[0] === fn).map((c) => c[1]);

describe('checkSend, enforce on', () => {
  it('allows marketing, holds the spend on the database day, logs it', async () => {
    const { client, rpc } = fake();
    const r = await checkSend(client, mkt, NOW);
    expect(r).toEqual({
      allow: true,
      reason: 'ALLOWED',
      enforced: true,
      reservation: {
        accountId: 'acc',
        scope: 'wa.marketing.daily',
        day: '2026-11-29',
        micros: 700,
      },
    });
    expect(calls(rpc, 'send_protection_spend_add')).toEqual([
      {
        p_account: 'acc',
        p_scope: 'wa.marketing.daily',
        p_micros: 700,
        p_hard_cap: 10_000,
      },
    ]);
    expect(calls(rpc, 'send_protection_decision_record')).toEqual([
      {
        p_account: 'acc',
        p_config: 'cfg',
        p_template: 'promo',
        p_contact: 'ct',
        p_kind: 'MARKETING',
        p_decision: 'ALLOW',
        p_reason: 'ALLOWED',
        p_enforced: true,
      },
    ]);
    expect(calls(rpc, 'send_protection_spend_refund')).toEqual([]);
  });

  it('a paused number denies and logs DENY', async () => {
    const { client, rpc } = fake({
      tables: {
        meta_number_state: [
          { quality_rating: 'GREEN', account_status: 'RESTRICTED' },
        ],
      },
    });
    const r = await checkSend(client, util, NOW);
    expect(r).toEqual({
      allow: false,
      reason: 'NUMBER_ALL_PAUSED',
      enforced: true,
    });
    expect(calls(rpc, 'send_protection_decision_record')[0]).toMatchObject({
      p_kind: 'UTILITY',
      p_decision: 'DENY',
      p_enforced: true,
    });
  });

  it('the daily ramp defers to next UTC midnight and logs DEFER', async () => {
    const { client, rpc } = fake({
      rpc: { meta_marketing_sent_today: () => ({ data: 600, error: null }) },
    });
    const r = await checkSend(client, mkt, NOW);
    expect(r).toEqual({
      allow: false,
      reason: 'RAMP_CAP_REACHED',
      deferUntil: '2026-11-29T00:00:00.000Z',
      enforced: true,
    });
    expect(calls(rpc, 'send_protection_decision_record')[0]).toMatchObject({
      p_decision: 'DEFER',
    });
    expect(calls(rpc, 'send_protection_spend_add')).toEqual([]);
  });

  it("the owner's daily_marketing_cap lowers the ramp (the lower wins)", async () => {
    const settings = () => ({
      data: [{ enforce: true, daily_marketing_cap: 5 }],
      error: null,
    });
    const { client } = fake({
      rpc: {
        meta_protection_settings_get: settings,
        meta_marketing_sent_today: () => ({ data: 5, error: null }),
      },
    });
    expect(await checkSend(client, mkt, NOW)).toMatchObject({
      allow: false,
      reason: 'RAMP_CAP_REACHED',
      deferUntil: '2026-11-29T00:00:00.000Z',
    });
    // Under the owner's cap, the ramp (600) is not reached either.
    const under = fake({
      rpc: {
        meta_protection_settings_get: settings,
        meta_marketing_sent_today: () => ({ data: 4, error: null }),
      },
    });
    expect((await checkSend(under.client, mkt, NOW)).allow).toBe(true);
  });

  it('a paused or disabled template is denied, in any language', async () => {
    for (const row of [
      { status: 'PAUSED', paused_until: null },
      { status: 'DELETED', paused_until: null },
      { status: 'APPROVED', paused_until: '2026-11-30T00:00:00Z' },
    ]) {
      const { client } = fake({ tables: { meta_template_health: [row] } });
      expect((await checkSend(client, util, NOW)).reason).toBe(
        'TEMPLATE_PAUSED'
      );
    }
    const { client } = fake({
      tables: {
        meta_template_health: [
          { status: 'APPROVED', paused_until: '2026-11-01T00:00:00Z' },
        ],
      },
    });
    expect((await checkSend(client, util, NOW)).allow).toBe(true);
  });

  it('a log failure denies marketing (refunding it) but never a session or utility send', async () => {
    const down = {
      send_protection_decision_record: () => ({
        data: null,
        error: { message: 'down' },
      }),
    };
    const m = fake({ rpc: down });
    expect(await checkSend(m.client, mkt, NOW)).toEqual({
      allow: false,
      reason: 'LOG_UNAVAILABLE',
      enforced: true,
    });
    expect(calls(m.rpc, 'send_protection_spend_refund')).toEqual([
      {
        p_account: 'acc',
        p_scope: 'wa.marketing.daily',
        p_day: '2026-11-29',
        p_micros: 700,
      },
    ]);
    for (const input of [session, util]) {
      const { client } = fake({ rpc: down });
      expect((await checkSend(client, input, NOW)).allow).toBe(true);
    }
  });

  it('an unreadable enforce switch counts as on', async () => {
    const { client } = fake({
      rpc: {
        meta_protection_settings_get: () => ({
          data: null,
          error: { message: 'x' },
        }),
      },
      tables: { meta_number_state: [{ account_status: 'BANNED' }] },
    });
    expect(await checkSend(client, session, NOW)).toEqual({
      allow: false,
      reason: 'TOTAL_BLOCK',
      enforced: true,
    });
  });
});

describe('checkSend on a number that is not Meta Cloud API', () => {
  // Meta's signals on record for it (say, from before a provider switch)
  // would pause it; none of them may be read.
  const whapi = (rpc: Record<string, () => Res> = {}) =>
    fake({
      rpc: {
        meta_marketing_sent_today: () => {
          throw new Error('CONFIG_INVALID: not a Meta number');
        },
        meta_protection_settings_get: () => ({
          data: [{ enforce: true, daily_marketing_cap: 0 }],
          error: null,
        }),
        ...rpc,
      },
      tables: {
        whatsapp_config: [{ provider: 'whapi', created_at: null }],
        meta_number_state: [
          {
            quality_rating: 'RED',
            messaging_limit_tier: 'TIER_250',
            account_status: 'BANNED',
            assessed_state: 'ALL_PAUSED',
            reasons: [],
          },
        ],
        meta_template_health: [{ status: 'PAUSED', paused_until: null }],
      },
    });

  it('allows marketing: no number state, template health, ramp or owner cap', async () => {
    const { client, rpc } = whapi();
    const r = await checkSend(client, mkt, NOW);
    expect(r).toMatchObject({ allow: true, reason: 'ALLOWED', enforced: true });
    expect(calls(rpc, 'meta_marketing_sent_today')).toEqual([]);
    // The spend cap still applies.
    expect(calls(rpc, 'send_protection_spend_add')).toHaveLength(1);
  });

  it('still applies opt-out, suppression and the spend cap', async () => {
    let { client } = whapi({
      send_protection_recipient_signals: () => ({
        data: [
          { opted_out: true, sent_without_reply: 0, failed_deliveries: 0 },
        ],
        error: null,
      }),
    });
    expect((await checkSend(client, mkt, NOW)).reason).toBe('OPTED_OUT');
    ({ client } = whapi({
      send_protection_recipient_signals: () => ({
        data: [
          { opted_out: false, sent_without_reply: 3, failed_deliveries: 0 },
        ],
        error: null,
      }),
    }));
    expect((await checkSend(client, mkt, NOW)).reason).toBe(
      'SUPPRESSED_NO_REPLY'
    );
    ({ client } = whapi({
      send_protection_spend_add: () => ({
        data: [{ allowed: false, total_micros: 10_000, day: '2026-11-28' }],
        error: null,
      }),
    }));
    expect((await checkSend(client, mkt, NOW)).reason).toBe('SPEND_CAP');
  });
});

describe('checkSend, watch mode (enforce off)', () => {
  it('never blocks, but logs what it would have done', async () => {
    const { client, rpc } = fake({
      enforce: false,
      tables: { meta_number_state: [{ account_status: 'BANNED' }] },
    });
    expect(await checkSend(client, mkt, NOW)).toEqual({
      allow: true,
      reason: 'TOTAL_BLOCK',
      enforced: false,
    });
    expect(calls(rpc, 'send_protection_decision_record')[0]).toMatchObject({
      p_decision: 'DENY',
      p_reason: 'TOTAL_BLOCK',
      p_enforced: false,
    });
  });

  it('refunds any reserved spend at once', async () => {
    const { client, rpc } = fake({ enforce: false });
    const r = await checkSend(client, mkt, NOW);
    expect(r).toEqual({ allow: true, reason: 'ALLOWED', enforced: false });
    expect(calls(rpc, 'send_protection_spend_refund')).toEqual([
      {
        p_account: 'acc',
        p_scope: 'wa.marketing.daily',
        p_day: '2026-11-29',
        p_micros: 700,
      },
    ]);
  });

  it('a log failure blocks nothing', async () => {
    const { client } = fake({
      enforce: false,
      rpc: {
        send_protection_decision_record: () => {
          throw new Error('down');
        },
      },
    });
    expect((await checkSend(client, mkt, NOW)).allow).toBe(true);
  });
});

describe('refundSendReservation', () => {
  it('never throws', async () => {
    const { client } = fake({
      rpc: {
        send_protection_spend_refund: () => {
          throw new Error('down');
        },
      },
    });
    expect(
      await refundSendReservation(client, {
        accountId: 'acc',
        scope: 'wa.marketing.daily',
        day: '2026-11-28',
        micros: 5,
      })
    ).toBe(false);
    expect(await refundSendReservation(client, undefined)).toBe(true);
  });
});
