import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  insightsAvailable,
  setCachedInsightSettings,
} from '@/lib/insights/settings';
import {
  INSIGHT_SETTINGS_COLUMNS,
  parseInsightSettingsPut,
  rowFromValues,
  settingsFromRow,
  type InsightSettingsResponse,
  type InsightSettingsRow,
} from '@/lib/insights/settings-shape';

/**
 * Settings → Smart insights: the account's switches (migration 147).
 * Every staff member reads them (the inbox and composer need to know
 * what is on); admins write them, like the table's RLS. Both go
 * through the caller's RLS client.
 */

async function readRow(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ row: InsightSettingsRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from('ai_insight_settings')
    .select(INSIGHT_SETTINGS_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  return {
    row: (data as InsightSettingsRow | null) ?? null,
    error: error?.message ?? null,
  };
}

const loadFailed = () =>
  NextResponse.json(
    { error: 'Failed to load the Smart insights settings' },
    { status: 500 }
  );

const changed = () =>
  NextResponse.json(
    { error: 'Someone else changed these settings. Reload to see the latest.' },
    { status: 409 }
  );

/** GET /api/insights/settings (staff) → InsightSettingsResponse */
export async function GET() {
  try {
    // 'viewer' leaves bank guests out.
    const { supabase, accountId, role } = await requireRole('viewer');
    const { row, error } = await readRow(supabase, accountId);
    if (error) {
      console.error('[insights/settings GET] fetch error:', error);
      return loadFailed();
    }
    const payload: InsightSettingsResponse = {
      settings: settingsFromRow(row),
      available: insightsAvailable(accountId),
      canEdit: canEditSettings(role),
    };
    return NextResponse.json(payload);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/insights/settings (admin+), body InsightSettingsPut
 *   → InsightSettingsResponse, or 409 { error } when someone saved
 *   since the version the admin was looking at (nothing is written).
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('admin');

    const limit = checkRateLimit(
      `insight-settings:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = parseInsightSettingsPut(json);
    if (!parsed.ok)
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { expectedUpdatedAt, ...values } = parsed.value;

    const { row: current, error: readError } = await readRow(
      supabase,
      accountId
    );
    if (readError) {
      console.error('[insights/settings PUT] fetch error:', readError);
      return loadFailed();
    }
    if ((current?.updated_at ?? null) !== expectedUpdatedAt) return changed();

    // Conditional on the version read above; a first insert racing
    // another fails on the primary key. Either way, 409.
    const record = rowFromValues(accountId, userId, values);
    const write = current
      ? supabase
          .from('ai_insight_settings')
          .update(record)
          .eq('account_id', accountId)
          .eq('updated_at', current.updated_at)
          .select(INSIGHT_SETTINGS_COLUMNS)
          .maybeSingle()
      : supabase
          .from('ai_insight_settings')
          .insert(record)
          .select(INSIGHT_SETTINGS_COLUMNS)
          .maybeSingle();
    const { data, error } = await write;
    if (error?.code === '23505' || (!error && !data)) return changed();
    if (error) {
      console.error('[insights/settings PUT] save error:', error.message);
      // 23503: the tag is gone; 23514: a sub-tag or another account's (165).
      if (error.code === '23503' || error.code === '23514')
        return NextResponse.json(
          { error: 'Choose one of your main chat tags' },
          { status: 400 }
        );
      return NextResponse.json(
        { error: 'Failed to save the Smart insights settings' },
        { status: 500 }
      );
    }
    const settings = settingsFromRow(data as InsightSettingsRow);
    // Applied on this process at once; others within their 30 s cache.
    setCachedInsightSettings(accountId, settings);
    const payload: InsightSettingsResponse = {
      settings,
      available: insightsAvailable(accountId),
      canEdit: canEditSettings(role),
    };
    return NextResponse.json(payload);
  } catch (err) {
    return toErrorResponse(err);
  }
}
