import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  NOT_MIGRATED_MESSAGE,
  isMissingFunction,
} from '@/lib/team-activity/db-errors';
import { isValidTimeZone, limitsFromRow } from '@/lib/team-activity/limits';
import { isRangePreset, rangeFor } from '@/lib/team-activity/range';
import { parseTeamActivityReport } from '@/lib/team-activity/report';

/**
 * Team activity (migration 068): who starts WhatsApp chats, how many get
 * an answer, and the sending patterns that get a Whapi number
 * restricted. Team leader and up, like the report function itself
 * (migration 074): a leader gets their own team's figures — the SQL
 * decides the scope, not this route.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notMigrated = () =>
  NextResponse.json({ error: NOT_MIGRATED_MESSAGE }, { status: 503 });

/**
 * GET /api/team-activity?range=7d&channel=<number id>&tz=<IANA zone>
 *   → { report: TeamActivityReport, range: { preset, from, to } }
 *
 * The range is computed here, in the account's zone once an admin has
 * saved one (else the viewer's), so "today" on this page is the same
 * day the limits, the alerts and the block count.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('team_leader');
    const params = new URL(request.url).searchParams;

    const preset = params.get('range') ?? '7d';
    if (!isRangePreset(preset)) {
      return NextResponse.json({ error: 'Unknown range' }, { status: 400 });
    }
    const channel = params.get('channel') || null;
    if (channel && !UUID_RE.test(channel)) {
      return NextResponse.json({ error: 'Unknown number' }, { status: 400 });
    }
    const viewerZone = params.get('tz');

    const { data: limitRows, error: limitsError } = await supabase.rpc(
      'team_activity_limits',
      { p_account: accountId }
    );
    if (limitsError) {
      if (isMissingFunction(limitsError)) return notMigrated();
      console.error('[team-activity] limits failed:', limitsError.message);
      return NextResponse.json(
        { error: 'Failed to load team activity' },
        { status: 500 }
      );
    }
    const saved = limitsFromRow(
      Array.isArray(limitRows)
        ? (limitRows[0] as Record<string, unknown>)
        : null
    );
    const tz =
      saved.timezone ??
      (viewerZone && isValidTimeZone(viewerZone) ? viewerZone : 'UTC');

    const now = new Date();
    const range = rangeFor(preset, now, tz);
    // A request landing on the very millisecond of midnight.
    if (range.to.getTime() <= range.from.getTime()) {
      range.to = new Date(range.from.getTime() + 1000);
    }

    const { data, error } = await supabase.rpc('team_activity_report', {
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
      p_tz: tz,
      p_channel_id: channel,
    });
    if (error) {
      if (isMissingFunction(error)) return notMigrated();
      console.error('[team-activity] report failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to load team activity' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      report: parseTeamActivityReport(data),
      range: {
        preset,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
