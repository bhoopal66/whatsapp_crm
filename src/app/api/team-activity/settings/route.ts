import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  NOT_MIGRATED_MESSAGE,
  isMissingTable,
} from '@/lib/team-activity/db-errors';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  limitsFromRow,
  parseLimitsInput,
  rowFromLimits,
} from '@/lib/team-activity/limits';

/**
 * PUT /api/team-activity/settings (admin+), body: every limit plus
 * `timezone` → { limits }
 *
 * The account's Team activity limits (migration 068). One row per
 * account; who saved it and when are stamped by the table's trigger,
 * which also refuses a time zone Postgres does not know.
 */
export async function PUT(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `team-activity-settings:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = parseLimitsInput(json);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('team_activity_settings')
      .upsert(rowFromLimits(accountId, parsed.value), {
        onConflict: 'account_id',
      })
      .select()
      .maybeSingle();

    if (error) {
      // 22023: the trigger did not recognise the time zone.
      if (error.code === '22023') {
        return NextResponse.json(
          { error: 'timezone must be a valid IANA time zone.' },
          { status: 400 }
        );
      }
      if (isMissingTable(error)) {
        return NextResponse.json(
          { error: NOT_MIGRATED_MESSAGE },
          { status: 503 }
        );
      }
      console.error('[team-activity/settings] save failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to save the limits' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Failed to save the limits' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      limits: limitsFromRow(data as Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
