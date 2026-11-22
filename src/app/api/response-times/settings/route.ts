// ============================================================
// /api/response-times/settings — Settings -> Response times
// (migration 237). Owner / admin only, the caller's active workspace.
//
// GET  -> { settings: { enabled, timezone, hours, targetMinutes },
//           available }  (the defaults when never saved; available is
//           false before migration 237).
// PUT  { enabled, timezone, hours, targetMinutes } (all required) ->
//      { settings } as stored, through response_settings_set on the
//      caller's RLS client (it re-checks owner/admin). A refusal answers
//      422 { error: <hint> }: invalid_timezone, invalid_hours,
//      invalid_target; 403 not_allowed.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  MAX_TARGET_MINUTES,
  MIN_TARGET_MINUTES,
  parseResponseSettings,
  validateHours,
} from '@/lib/response-times/hours';

const SELECT = 'enabled, timezone, hours, target_minutes';

function isMissingObject(error: { code?: string } | null): boolean {
  return (
    error?.code === 'PGRST205' ||
    error?.code === '42P01' ||
    error?.code === 'PGRST202' ||
    error?.code === '42883'
  );
}

function hintOf(error: unknown): string | null {
  return error && typeof error === 'object' && 'hint' in error
    ? typeof (error as { hint: unknown }).hint === 'string'
      ? (error as { hint: string }).hint
      : null
    : null;
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const { data, error } = await ctx.supabase
      .from('response_settings')
      .select(SELECT)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      if (isMissingObject(error)) {
        return NextResponse.json({
          settings: parseResponseSettings(null),
          available: false,
        });
      }
      console.error('[response-times] settings read failed:', error.message);
      return NextResponse.json({ error: 'load_failed' }, { status: 500 });
    }
    return NextResponse.json({
      settings: parseResponseSettings(data),
      available: true,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }
    const { enabled, timezone, hours, targetMinutes } = body;
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'invalid_enabled' }, { status: 400 });
    }
    if (typeof timezone !== 'string' || !timezone || timezone.length > 64) {
      return NextResponse.json({ error: 'invalid_timezone' }, { status: 422 });
    }
    if (!validateHours(hours)) {
      return NextResponse.json({ error: 'invalid_hours' }, { status: 422 });
    }
    if (
      typeof targetMinutes !== 'number' ||
      !Number.isInteger(targetMinutes) ||
      targetMinutes < MIN_TARGET_MINUTES ||
      targetMinutes > MAX_TARGET_MINUTES
    ) {
      return NextResponse.json({ error: 'invalid_target' }, { status: 422 });
    }

    const { data, error } = await ctx.supabase.rpc('response_settings_set', {
      p_enabled: enabled,
      p_timezone: timezone,
      p_hours: hours,
      p_target_minutes: targetMinutes,
    });
    if (error) {
      if (isMissingObject(error)) {
        return NextResponse.json({ error: 'not_available' }, { status: 503 });
      }
      const hint = hintOf(error);
      if (hint === 'not_allowed') {
        return NextResponse.json({ error: hint }, { status: 403 });
      }
      if (
        hint === 'invalid_timezone' ||
        hint === 'invalid_hours' ||
        hint === 'invalid_target' ||
        hint === 'invalid_enabled'
      ) {
        return NextResponse.json({ error: hint }, { status: 422 });
      }
      console.error('[response-times] settings save failed:', error.message);
      return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    }
    return NextResponse.json({ settings: parseResponseSettings(data) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
