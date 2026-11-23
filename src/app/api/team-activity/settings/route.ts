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
import { staleSaveResponse } from '@/lib/settings/stale';
import {
  limitsFromRow,
  parseLimitsInput,
  rowFromLimits,
} from '@/lib/team-activity/limits';

/**
 * GET /api/team-activity/settings (admin+) → { settings, saved,
 * updatedAt }: the limits (the defaults when never saved, with `saved`
 * false and `updatedAt` null).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('team_activity_settings')
      .select()
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) {
        return NextResponse.json(
          { error: NOT_MIGRATED_MESSAGE },
          { status: 503 }
        );
      }
      console.error('[team-activity/settings] load failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to load the limits' },
        { status: 500 }
      );
    }
    const row = data as Record<string, unknown> | null;
    return NextResponse.json({
      settings: limitsFromRow(row),
      saved: row !== null,
      updatedAt: row?.updated_at ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/team-activity/settings (admin+), body: every limit plus
 * `timezone` → { limits }. With `expectedUpdatedAt` (what the GET
 * answered), 409 STALE when the row was saved since; without it the
 * save is not compared.
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

    const row = rowFromLimits(accountId, parsed.value);
    const expected = (json as { expectedUpdatedAt?: unknown })
      .expectedUpdatedAt;
    const table = supabase.from('team_activity_settings');
    // The version is compared by the write itself.
    const { data, error } = await (
      expected === undefined
        ? table.upsert(row, { onConflict: 'account_id' })
        : expected === null
          ? table.insert(row)
          : table
              .update(row)
              .eq('account_id', accountId)
              .eq('updated_at', String(expected))
    )
      .select()
      .maybeSingle();

    if (error) {
      // 23505: somebody saved the first limits meanwhile.
      // 22007: not a timestamp, so not the version of any row.
      if (
        expected !== undefined &&
        (error.code === '23505' || error.code === '22007')
      ) {
        return staleSaveResponse();
      }
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
      if (expected !== undefined) return staleSaveResponse();
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
