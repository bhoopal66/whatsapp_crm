// ============================================================
// GET /api/pbx/settings/retention?days=N — how many recordings a
// retention period of N days (1 to 3650) would delete on the next
// phone-system cron run (module 015, migration 093) → { days, due }.
//
// Settings asks before it saves a new or shorter period, so the admin
// confirms a deletion they can see. pbx_retention_due runs on the
// caller's own session: it re-checks owner/admin, counts in the
// caller's active workspace only, and uses the retention run's own
// predicate (the call older than the period, not under legal hold, not
// deleted yet). Admin+.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseRetentionDays } from '@/lib/pbx/admin-ui';
import { dbFailure, fail } from '@/lib/pbx/calls';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const raw = new URL(request.url).searchParams.get('days') ?? '';
    const days = parseRetentionDays(raw);
    if (!days.ok || days.value === null)
      return fail('days must be a whole number from 1 to 3650');
    const { data, error } = await ctx.supabase.rpc('pbx_retention_due', {
      p_days: days.value,
    });
    if (error) {
      const refused = dbFailure(error);
      if (refused) return refused;
      throw new Error(`pbx_retention_due failed: ${error.message}`);
    }
    return NextResponse.json(
      { days: days.value, due: Number(data ?? 0) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
