import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getDecisionLayer } from '@/lib/typesafe';
import {
  SETTINGS_COLUMNS,
  actsLive,
  parseSettingsUpdate,
  rowFromUpdate,
  serverStatus,
  settingsFromRow,
  type ActivePolicyRow,
  type SettingsRow,
} from '@/lib/typesafe/admin';
import type {
  TsSettingsConflict,
  TsSettingsResponse,
} from '@/lib/typesafe/admin-types';
import { switchesFromRow } from '@/lib/typesafe/store';

/**
 * Settings → AI safety checks: the account's TypeSafe switches (migration
 * 064) and what this server can offer. Admin-only, like the table's RLS.
 */

async function body(
  supabase: SupabaseClient,
  accountId: string,
  row: SettingsRow | null
): Promise<TsSettingsResponse> {
  const [name, policies] = await Promise.all([
    row?.updated_by ? displayName(supabase, row.updated_by) : null,
    activePolicies(supabase, accountId),
  ]);
  return {
    settings: settingsFromRow(row, name),
    status: serverStatus(accountId, policies),
  };
}

async function displayName(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('user_id', userId)
    .maybeSingle();
  const p = data as { full_name: string | null; email: string | null } | null;
  return p?.full_name?.trim() || p?.email || null;
}

async function activePolicies(
  supabase: SupabaseClient,
  accountId: string
): Promise<ActivePolicyRow[]> {
  const { data, error } = await supabase
    .from('ts_policy')
    .select(
      'check_name, version, model_id, question_set_version, thresholds, shadow'
    )
    .eq('account_id', accountId)
    .eq('status', 'active');
  if (error) {
    console.error('[typesafe/settings] policy read failed:', error.message);
    return [];
  }
  return (data ?? []) as ActivePolicyRow[];
}

async function readRow(
  supabase: SupabaseClient,
  accountId: string
): Promise<{ row: SettingsRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from('ts_account_settings')
    .select(SETTINGS_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  return {
    row: (data as SettingsRow | null) ?? null,
    error: error?.message ?? null,
  };
}

async function conflict(
  supabase: SupabaseClient,
  accountId: string,
  reason: TsSettingsConflict['reason']
): Promise<NextResponse> {
  const { row } = await readRow(supabase, accountId);
  const payload: TsSettingsConflict = {
    error:
      reason === 'changed'
        ? 'Someone else changed these settings. The latest are shown now.'
        : 'Turning on Live needs confirmation.',
    reason,
    current: await body(supabase, accountId, row),
  };
  return NextResponse.json(payload, { status: 409 });
}

const loadFailed = () =>
  NextResponse.json(
    { error: 'Failed to load the AI safety settings' },
    { status: 500 }
  );

/** GET /api/typesafe/settings (admin+) → TsSettingsResponse */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { row, error } = await readRow(supabase, accountId);
    if (error) {
      console.error('[typesafe/settings GET] fetch error:', error);
      return loadFailed();
    }
    return NextResponse.json(await body(supabase, accountId, row));
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/typesafe/settings (admin+), body TsSettingsPut
 *   → TsSettingsResponse, or 409 TsSettingsConflict
 *
 * Saved against the version the admin was looking at: if anyone saved
 * since, nothing is written and the current settings come back, so one
 * admin's stale screen cannot undo another's change (or quietly turn
 * Live back on). Making the layer act where it did not also needs
 * `confirmLive`, which only the panel's confirmation dialog sets.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `ts-settings:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = parseSettingsUpdate(json);
    if (!parsed.ok)
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    const put = parsed.value;

    const { row: current, error: readError } = await readRow(
      supabase,
      accountId
    );
    if (readError) {
      console.error('[typesafe/settings PUT] fetch error:', readError);
      return loadFailed();
    }
    if ((current?.updated_at ?? null) !== put.expectedUpdatedAt)
      return conflict(supabase, accountId, 'changed');
    const wasLive = current
      ? actsLive({
          enabled: current.enabled,
          mode: current.mode === 'live' ? 'live' : 'monitor',
        })
      : false;
    if (actsLive(put) && !wasLive && !put.confirmLive)
      return conflict(supabase, accountId, 'confirm_live');

    // updated_by / updated_at are stamped by the table's trigger. The
    // update is conditional on the version read above, and a first
    // insert racing another fails on the primary key: either way, 409.
    const values = rowFromUpdate(accountId, put);
    const write = current
      ? supabase
          .from('ts_account_settings')
          .update(values)
          .eq('account_id', accountId)
          .eq('updated_at', current.updated_at)
          .select(SETTINGS_COLUMNS)
          .maybeSingle()
      : supabase
          .from('ts_account_settings')
          .insert(values)
          .select(SETTINGS_COLUMNS)
          .maybeSingle();
    const { data, error } = await write;
    if (error?.code === '23505' || (!error && !data))
      return conflict(supabase, accountId, 'changed');
    if (error) {
      console.error('[typesafe/settings PUT] save error:', error.message);
      return NextResponse.json(
        { error: 'Failed to save the AI safety settings' },
        { status: 500 }
      );
    }
    const saved = data as SettingsRow;
    // Applied on this process at once, whatever reads are in flight;
    // other processes pick it up within their 30 s cache.
    getDecisionLayer()?.switches.set(accountId, switchesFromRow(saved));
    console.info(
      `[ts013] settings changed for account ${accountId} by ${userId}: ` +
        JSON.stringify(rowFromUpdate(accountId, put))
    );
    return NextResponse.json(await body(supabase, accountId, saved));
  } catch (err) {
    return toErrorResponse(err);
  }
}
