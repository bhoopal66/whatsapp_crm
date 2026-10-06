import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  buildCostReport,
  lastNMonthKeys,
  type MonthlyCostRow,
  type ServiceQuotaRow,
} from '@/lib/whatsapp/message-costs';

const DEFAULT_MONTHS = 6;
const MAX_MONTHS = 24;

/**
 * GET /api/whatsapp/costs?months=6  (admin+)
 *
 * Meta Cloud API message spend for the account over the last `months`
 * billing months (1–24, default 6): totals, the current month on its
 * own, and per-month / per-category / per-market / per-number
 * breakdowns, with each number's position against the free service
 * tier. Read from the `whatsapp_cost_monthly` and
 * `whatsapp_service_quota` views (migration 051), which aggregate in
 * the database so a busy account's ledger never has to be paged into
 * the route.
 *
 * Admin-only, mirroring the ledger's SELECT policy — spend is
 * billing-class. The views are `security_invoker`, so the RLS-scoped
 * client sees only this account's rows even before the explicit
 * `.eq('account_id')`.
 *
 * `cost_usd` is in USD because that is what Meta bills in; `usd_aed_peg`
 * lets the client show dirhams for a Gulf account without a second
 * source of truth for the rate.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const url = new URL(request.url);
    const rawMonths = Number(url.searchParams.get('months'));
    const months =
      Number.isFinite(rawMonths) && rawMonths >= 1
        ? Math.min(MAX_MONTHS, Math.floor(rawMonths))
        : DEFAULT_MONTHS;

    const monthKeys = lastNMonthKeys(months);
    const since = monthKeys[0];

    const [monthlyRes, quotaRes, channelsRes] = await Promise.all([
      supabase
        .from('whatsapp_cost_monthly')
        .select(
          'month, phone_number_id, recipient_market, category, delivered, billed, quota_free, unknown_rate, cost_usd'
        )
        .eq('account_id', accountId)
        .gte('month', since),
      supabase
        .from('whatsapp_service_quota')
        .select('phone_number_id, month, service_delivered, free_remaining')
        .eq('account_id', accountId)
        .gte('month', since),
      supabase
        .from('whatsapp_config')
        .select('phone_number_id, label')
        .eq('account_id', accountId)
        .eq('provider', 'meta'),
    ]);

    if (monthlyRes.error || quotaRes.error) {
      console.error(
        '[whatsapp/costs GET] fetch error:',
        monthlyRes.error ?? quotaRes.error
      );
      return NextResponse.json(
        { error: 'Failed to load message costs' },
        { status: 500 }
      );
    }

    const labels: Record<string, string | null> = {};
    for (const c of channelsRes.data ?? []) {
      if (c.phone_number_id) labels[c.phone_number_id] = c.label ?? null;
    }

    const report = buildCostReport({
      monthly: (monthlyRes.data ?? []) as MonthlyCostRow[],
      quota: (quotaRes.data ?? []) as ServiceQuotaRow[],
      months: monthKeys,
      labels,
    });

    return NextResponse.json({
      ...report,
      // Whether any Meta number is connected at all — lets the panel
      // explain an empty ledger correctly (no Meta number vs. no
      // deliveries yet).
      meta_connected: (channelsRes.data ?? []).length > 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
