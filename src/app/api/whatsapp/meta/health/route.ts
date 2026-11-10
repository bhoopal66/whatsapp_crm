import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  parseAssessedState,
  parseCostPerWonCase,
  parseReasons,
  utcDay,
} from '@/lib/whatsapp/meta-health/view';

const SPEND_WINDOW_DAYS = 30;
const RECENT_EVENTS = 20;

/**
 * GET /api/whatsapp/meta/health  (admin+)
 *
 * Meta number health (migration 188), read-only and WATCH-ONLY: the
 * assessed state of the account's Meta number, template quality,
 * marketing templates sent today (UTC, the day the SQL counts) against
 * the advisory cap, Meta spend per won case over the last 30 days, and
 * the latest webhook events (kind and time only, never the payload).
 * `meta_protection_settings.enforce` is deliberately not read: nothing
 * acts on it yet, and showing it would suggest something does.
 *
 * The tables are read on the caller's RLS client (188's policies:
 * owners/admins of the account). The two functions are granted to the
 * service role only, so they run on it after the role check, scoped to
 * this account's own row.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('id, label')
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .maybeSingle();
    if (configError) {
      console.error('[meta/health GET] config:', configError.message);
      return NextResponse.json(
        { error: 'Failed to load number health' },
        { status: 500 }
      );
    }
    if (!config) return NextResponse.json({ connected: false });
    const configId = (config as { id: string }).id;

    const now = new Date();
    const from = new Date(now.getTime() - SPEND_WINDOW_DAYS * 86_400_000);
    const day = utcDay(now);
    const admin = supabaseAdmin();

    const [stateRes, templatesRes, eventsRes, settingsRes, sentRes, costRes] =
      await Promise.all([
        supabase
          .from('meta_number_state')
          .select(
            'quality_rating, messaging_limit_tier, account_status, assessed_state, reasons, updated_at'
          )
          .eq('account_id', accountId)
          .eq('config_id', configId)
          .maybeSingle(),
        supabase
          .from('meta_template_health')
          .select(
            'template_name, language, quality, status, paused_until, updated_at'
          )
          .eq('account_id', accountId)
          .order('template_name', { ascending: true })
          .order('language', { ascending: true }),
        supabase
          .from('meta_health_events')
          .select('id, kind, received_at')
          .eq('account_id', accountId)
          .order('received_at', { ascending: false })
          .limit(RECENT_EVENTS),
        supabase
          .from('meta_protection_settings')
          .select('daily_marketing_cap')
          .eq('account_id', accountId)
          .maybeSingle(),
        admin.rpc('meta_marketing_sent_today', {
          p_config: configId,
          p_day: day,
        }),
        admin.rpc('meta_cost_per_won_case', {
          p_account: accountId,
          p_from: from.toISOString(),
          p_to: now.toISOString(),
        }),
      ]);

    const failed = [stateRes, templatesRes, eventsRes, settingsRes].find(
      (r) => r.error
    );
    if (failed?.error) {
      console.error('[meta/health GET] read:', failed.error.message);
      return NextResponse.json(
        { error: 'Failed to load number health' },
        { status: 500 }
      );
    }
    // The figures are a convenience: a failed function call shows as
    // unavailable rather than failing the whole card.
    if (sentRes.error) {
      console.error('[meta/health GET] sent today:', sentRes.error.message);
    }
    if (costRes.error) {
      console.error('[meta/health GET] cost per case:', costRes.error.message);
    }

    const state = stateRes.data as Record<string, unknown> | null;
    const cap = (settingsRes.data as { daily_marketing_cap?: unknown } | null)
      ?.daily_marketing_cap;

    return NextResponse.json({
      connected: true,
      number: { label: (config as { label?: string | null }).label ?? null },
      state: state
        ? {
            quality_rating: (state.quality_rating as string | null) ?? null,
            messaging_limit_tier:
              (state.messaging_limit_tier as string | null) ?? null,
            account_status: (state.account_status as string | null) ?? null,
            assessed_state: parseAssessedState(state.assessed_state),
            reasons: parseReasons(state.reasons),
            updated_at: (state.updated_at as string | null) ?? null,
          }
        : null,
      templates: templatesRes.data ?? [],
      events: eventsRes.data ?? [],
      marketing: {
        day,
        sent_today: sentRes.error ? null : Number(sentRes.data ?? 0),
        daily_cap: typeof cap === 'number' ? cap : null,
      },
      spend: {
        days: SPEND_WINDOW_DAYS,
        figures: costRes.error ? null : parseCostPerWonCase(costRes.data),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
