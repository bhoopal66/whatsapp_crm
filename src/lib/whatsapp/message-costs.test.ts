import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SERVICE_FREE_TIER,
  USD_AED_PEG,
  billingTimezone,
  buildCostReport,
  lastNMonthKeys,
  humanizeCategory,
  orderedCategories,
  recordMetaMessageCosts,
  type MonthlyCostRow,
  type ServiceQuotaRow,
} from './message-costs';

// ---------------------------------------------------------------------------
// The costing rules themselves live in Postgres (migration 051) and are
// exercised against a real database; what is tested here is the app
// side: the webhook adapter's fail-open contract and the report
// shaping the settings panel renders.
// ---------------------------------------------------------------------------

function receipt(id: string, status = 'delivered') {
  return {
    id,
    status,
    recipient_id: '971501234567',
    timestamp: '1790000000',
    pricing: { billable: true, pricing_model: 'PMP', category: 'marketing' },
  };
}

describe('recordMetaMessageCosts', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WHATSAPP_BILLING_TIMEZONE;
  });

  it('calls the ledger function once per receipt, in order, with the billing timezone', async () => {
    process.env.WHATSAPP_BILLING_TIMEZONE = 'Europe/London';
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { ok: true, data: {} }, error: null });
    const db = { rpc } as never;

    const out = await recordMetaMessageCosts(db, {
      accountId: 'acct-1',
      phoneNumberId: 'PN1',
      statuses: [receipt('wamid.1'), receipt('wamid.2', 'read')],
    });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][0]).toBe('record_whatsapp_message_cost');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_account_id: 'acct-1',
      p_phone_number_id: 'PN1',
      p_status: receipt('wamid.1'),
      p_timezone: 'Europe/London',
    });
    expect(rpc.mock.calls[1][1]).toMatchObject({
      p_status: receipt('wamid.2', 'read'),
    });
    expect(out).toEqual([
      { ok: true, duplicate: false },
      { ok: true, duplicate: false },
    ]);
  });

  it('reports a replayed receipt as a duplicate rather than an error', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ok: true, data: { duplicate: true, message_id: 'wamid.1' } },
      error: null,
    });
    const out = await recordMetaMessageCosts({ rpc } as never, {
      accountId: 'acct-1',
      phoneNumberId: 'PN1',
      statuses: [receipt('wamid.1')],
    });
    expect(out).toEqual([{ ok: true, duplicate: true }]);
  });

  it('fails open: a thrown DB error is swallowed and the batch continues', async () => {
    const rpc = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ data: { ok: true, data: {} }, error: null });
    const out = await recordMetaMessageCosts({ rpc } as never, {
      accountId: 'acct-1',
      phoneNumberId: 'PN1',
      statuses: [receipt('wamid.1'), receipt('wamid.2')],
    });
    expect(out[0]).toMatchObject({
      ok: false,
      error: { code: 'COST_LEDGER_ERROR' },
    });
    expect(out[1]).toEqual({ ok: true, duplicate: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('fails open on a PostgREST error object too', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'permission denied for function' },
    });
    const out = await recordMetaMessageCosts({ rpc } as never, {
      accountId: 'acct-1',
      phoneNumberId: 'PN1',
      statuses: [receipt('wamid.1')],
    });
    expect(out).toEqual([
      {
        ok: false,
        error: {
          code: 'COST_LEDGER_ERROR',
          message: 'permission denied for function',
        },
      },
    ]);
  });

  it('surfaces the structured rejection the function returns for a malformed status', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ok: false,
        error: { code: 'BAD_STATUS', message: 'missing id/status' },
      },
      error: null,
    });
    const out = await recordMetaMessageCosts({ rpc } as never, {
      accountId: 'acct-1',
      phoneNumberId: 'PN1',
      statuses: [{ status: 'delivered' }],
    });
    expect(out).toEqual([
      {
        ok: false,
        error: { code: 'BAD_STATUS', message: 'missing id/status' },
      },
    ]);
  });

  it('does nothing without an account or number to attribute to', async () => {
    const rpc = vi.fn();
    const out = await recordMetaMessageCosts({ rpc } as never, {
      accountId: '',
      phoneNumberId: 'PN1',
      statuses: [receipt('wamid.1')],
    });
    expect(out).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('defaults the billing timezone to the Gulf', () => {
    delete process.env.WHATSAPP_BILLING_TIMEZONE;
    expect(billingTimezone()).toBe('Asia/Dubai');
    process.env.WHATSAPP_BILLING_TIMEZONE = '  ';
    expect(billingTimezone()).toBe('Asia/Dubai');
  });
});

describe('lastNMonthKeys', () => {
  it('yields first-of-month keys, oldest first, crossing a year boundary', () => {
    expect(lastNMonthKeys(3, new Date(Date.UTC(2026, 0, 15)), 'UTC')).toEqual([
      '2025-11-01',
      '2025-12-01',
      '2026-01-01',
    ]);
  });

  it('reads "now" in the billing timezone', () => {
    // 22:00 UTC on 30 Sep is already 1 Oct in the Gulf.
    const at = new Date(Date.UTC(2026, 8, 30, 22, 0, 0));
    expect(lastNMonthKeys(1, at, 'Asia/Dubai')).toEqual(['2026-10-01']);
    expect(lastNMonthKeys(1, at, 'UTC')).toEqual(['2026-09-01']);
  });

  it('falls back to UTC on an unknown timezone', () => {
    const at = new Date(Date.UTC(2026, 8, 30, 22, 0, 0));
    expect(lastNMonthKeys(1, at, 'Not/AZone')).toEqual(['2026-09-01']);
  });
});

describe('buildCostReport', () => {
  const months = ['2026-09-01', '2026-10-01'];

  function row(over: Partial<MonthlyCostRow>): MonthlyCostRow {
    return {
      month: '2026-10-01',
      phone_number_id: 'PN1',
      recipient_market: 'AE',
      category: 'marketing',
      delivered: 10,
      billed: 10,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: '0.576',
      ...over,
    };
  }

  it('zero-fills every month in the window and totals across them', () => {
    const report = buildCostReport({
      monthly: [
        row({ month: '2026-09-01', cost_usd: '0.499' }),
        row({ month: '2026-10-01', cost_usd: '0.576' }),
      ],
      quota: [],
      months,
    });
    expect(report.months).toEqual(months);
    expect(report.by_month.map((m) => m.month)).toEqual(months);
    expect(report.totals).toEqual({
      delivered: 20,
      billed: 20,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: 1.075,
    });
    expect(report.current.month).toBe('2026-10-01');
    expect(report.current.cost_usd).toBe(0.576);
    expect(report.usd_aed_peg).toBe(USD_AED_PEG);
  });

  it('keeps an unknown rate out of the total but visible in the counter', () => {
    const report = buildCostReport({
      monthly: [
        row({ cost_usd: '0.576' }),
        row({
          recipient_market: 'UNKNOWN',
          delivered: 3,
          billed: 3,
          unknown_rate: 3,
          cost_usd: null,
        }),
      ],
      quota: [],
      months,
    });
    expect(report.totals.cost_usd).toBe(0.576);
    expect(report.totals.unknown_rate).toBe(3);
    expect(report.totals.delivered).toBe(13);
    const unknown = report.by_market.find((m) => m.market === 'UNKNOWN');
    expect(unknown).toMatchObject({
      delivered: 3,
      cost_usd: 0,
      unknown_rate: 3,
    });
  });

  it('stacks per-month spend by category and sorts breakdowns by spend', () => {
    const report = buildCostReport({
      monthly: [
        row({ category: 'marketing', cost_usd: '0.576' }),
        row({
          category: 'utility',
          delivered: 100,
          billed: 100,
          cost_usd: '1.57',
        }),
        row({
          category: 'service',
          delivered: 50,
          billed: 0,
          quota_free: 50,
          cost_usd: '0',
        }),
      ],
      quota: [],
      months,
    });
    const oct = report.by_month[1];
    expect(oct.by_category).toEqual({
      marketing: 0.576,
      utility: 1.57,
      service: 0,
    });
    expect(report.by_category.map((c) => c.category)).toEqual([
      'utility',
      'marketing',
      'service',
    ]);
    expect(report.totals.quota_free).toBe(50);
  });

  it('attaches the current month free-tier position and label to each number', () => {
    const report = buildCostReport({
      monthly: [
        row({ phone_number_id: 'PN1' }),
        row({ phone_number_id: 'PN2', cost_usd: '0.1' }),
      ],
      quota: [
        {
          phone_number_id: 'PN1',
          month: '2026-10-01',
          service_delivered: 1200,
          free_remaining: 0,
        },
        // Last month's position must not leak into the current tile.
        {
          phone_number_id: 'PN2',
          month: '2026-09-01',
          service_delivered: 900,
          free_remaining: 100,
        },
      ],
      months,
      labels: { PN1: 'Marketing number' },
    });
    const pn1 = report.by_number.find((n) => n.phone_number_id === 'PN1')!;
    const pn2 = report.by_number.find((n) => n.phone_number_id === 'PN2')!;
    expect(pn1).toMatchObject({
      label: 'Marketing number',
      service_delivered: 1200,
      free_remaining: 0,
    });
    expect(pn2).toMatchObject({
      label: null,
      service_delivered: 0,
      free_remaining: SERVICE_FREE_TIER,
    });
    expect(report.by_number[0].phone_number_id).toBe('PN1'); // higher spend first
  });

  it('sums the current-month free-tier position across numbers for the headline tile', () => {
    const report = buildCostReport({
      monthly: [
        // `quota_free` stays 0 before 2026-10-01: a service message is
        // free outright then, not free because of the allowance. The
        // tile must still report what was delivered.
        row({ category: 'service', quota_free: 0, cost_usd: '0' }),
      ],
      quota: [
        {
          phone_number_id: 'PN1',
          month: '2026-10-01',
          service_delivered: 400,
          free_remaining: 600,
        },
        {
          phone_number_id: 'PN2',
          month: '2026-10-01',
          service_delivered: 1200,
          free_remaining: 0,
        },
        // A previous month must not bleed into the current tile.
        {
          phone_number_id: 'PN1',
          month: '2026-09-01',
          service_delivered: 999,
          free_remaining: 1,
        },
      ],
      months,
    });
    expect(report.current.quota_free).toBe(0);
    expect(report.current.service_delivered).toBe(1600);
    expect(report.current.service_free_remaining).toBe(600);
  });

  it('ignores a row outside the requested window instead of mis-bucketing it', () => {
    const report = buildCostReport({
      monthly: [row({ month: '2026-08-01' })],
      quota: [],
      months,
    });
    expect(report.totals.delivered).toBe(0);
  });
});

describe('report shaping against real `whatsapp_cost_monthly` output', () => {
  // Captured verbatim from a Postgres replaying migrations 001–051 and
  // fed the delivery receipts in supabase/ci — including the
  // `business_initiated` category the panel used to drop, and a
  // September service month whose `quota_free` is 0 because service is
  // free outright before 2026-10-01.
  const monthly = [
    {
      month: '2026-09-01',
      phone_number_id: 'PNA',
      recipient_market: 'AE',
      category: 'business_initiated',
      delivered: 1,
      billed: 1,
      quota_free: 0,
      unknown_rate: 1,
      cost_usd: null,
    },
    {
      month: '2026-09-01',
      phone_number_id: 'PNA',
      recipient_market: 'AE',
      category: 'marketing',
      delivered: 1,
      billed: 1,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: '0.049900',
    },
    {
      month: '2026-09-01',
      phone_number_id: 'PNA',
      recipient_market: 'AE',
      category: 'service',
      delivered: 2,
      billed: 0,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: '0.000000',
    },
    {
      month: '2026-09-01',
      phone_number_id: 'PNB',
      recipient_market: 'AE',
      category: 'marketing',
      delivered: 1,
      billed: 1,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: '0.049900',
    },
    {
      month: '2026-09-01',
      phone_number_id: 'PNB',
      recipient_market: 'UNKNOWN',
      category: 'marketing',
      delivered: 1,
      billed: 1,
      quota_free: 0,
      unknown_rate: 1,
      cost_usd: null,
    },
    {
      month: '2026-10-01',
      phone_number_id: 'PNC',
      recipient_market: 'AE',
      category: 'service',
      delivered: 1,
      billed: 0,
      quota_free: 1,
      unknown_rate: 0,
      cost_usd: '0.000000',
    },
    {
      month: '2026-11-01',
      phone_number_id: 'PNA',
      recipient_market: 'AE',
      category: 'service',
      delivered: 1,
      billed: 1,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: '0.015700',
    },
    {
      month: '2026-11-01',
      phone_number_id: 'PNB',
      recipient_market: 'KW',
      category: 'authentication_international',
      delivered: 1,
      billed: 1,
      quota_free: 0,
      unknown_rate: 0,
      cost_usd: '0.120000',
    },
    {
      month: '2026-11-01',
      phone_number_id: 'PNB',
      recipient_market: 'KW',
      category: 'service',
      delivered: 1,
      billed: 0,
      quota_free: 1,
      unknown_rate: 0,
      cost_usd: '0.000000',
    },
  ] as unknown as MonthlyCostRow[];
  const quota = [
    {
      phone_number_id: 'PNA',
      month: '2026-09-01',
      service_delivered: 2,
      free_remaining: 998,
    },
    {
      phone_number_id: 'PNA',
      month: '2026-11-01',
      service_delivered: 1,
      free_remaining: 999,
    },
    {
      phone_number_id: 'PNB',
      month: '2026-11-01',
      service_delivered: 1,
      free_remaining: 999,
    },
    {
      phone_number_id: 'PNC',
      month: '2026-10-01',
      service_delivered: 1,
      free_remaining: 999,
    },
  ] as unknown as ServiceQuotaRow[];
  const months = ['2026-09-01', '2026-10-01', '2026-11-01'];

  it('totals exclude unknown rates and keep them counted', () => {
    const r = buildCostReport({ monthly, quota, months });
    // 0.0499 (PNA marketing) + 0.0499 (PNB marketing)
    //   + 0.12 (KW auth-intl) + 0.0157 (a service message Meta marked
    //   billable, which the free tier therefore did not absorb)
    expect(r.totals.cost_usd).toBeCloseTo(0.2355, 6);
    // business_initiated (AE) and marketing to an unmapped market
    expect(r.totals.unknown_rate).toBe(2);
  });

  it('reports the free-tier position for the current month only', () => {
    const r = buildCostReport({ monthly, quota, months });
    expect(r.current.month).toBe('2026-11-01');
    // PNA + PNB delivered one service message each in November; the
    // September and October rows must not be added in.
    expect(r.current.service_delivered).toBe(2);
    // ...while the ledger flag counts only ONE of them, because Meta
    // marked PNA's billable so the allowance never absorbed it. This
    // gap is exactly why the headline tile cannot read `quota_free`.
    expect(r.current.quota_free).toBe(1);
  });

  it('keeps an unrecognised category in the chart series and names it', () => {
    const r = buildCostReport({ monthly, quota, months });
    const series = orderedCategories(r.by_category);
    expect(series).toContain('business_initiated');
    // Known categories lead, in display order; the stranger goes last.
    expect(series[series.length - 1]).toBe('business_initiated');
    expect(series.indexOf('marketing')).toBeLessThan(series.indexOf('service'));
    expect(humanizeCategory('business_initiated')).toBe('Business initiated');
    // Every category carrying spend is drawable, so the stacked bars
    // add up to the headline total.
    const charted = series.reduce(
      (sum, c) =>
        sum + r.by_month.reduce((s, m) => s + (m.by_category[c] ?? 0), 0),
      0
    );
    expect(charted).toBeCloseTo(r.totals.cost_usd, 6);
  });
});
