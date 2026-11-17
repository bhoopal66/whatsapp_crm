import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  UNLOCKS_UNAVAILABLE_MESSAGE,
  isMissingObject,
} from '@/lib/team-activity/db-errors';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 92;

/**
 * GET /api/team-activity/blocks?from=ISO&to=ISO → { blocks }
 *
 * Sends the restriction layer refused (migration 204), newest first,
 * 500 at most. The caller's RLS client decides whose rows come back.
 * Default range is the last 7 days, at most 92.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireRole('agent');
    const params = new URL(request.url).searchParams;

    const toRaw = params.get('to');
    const fromRaw = params.get('from');
    const to = toRaw ? new Date(toRaw) : new Date();
    const from = fromRaw
      ? new Date(fromRaw)
      : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);
    if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
      return NextResponse.json(
        { error: 'Invalid date range' },
        { status: 400 }
      );
    }
    if (to.getTime() <= from.getTime()) {
      return NextResponse.json(
        { error: '"from" must be before "to"' },
        { status: 400 }
      );
    }
    if (to.getTime() - from.getTime() > MAX_DAYS * DAY_MS) {
      return NextResponse.json(
        { error: `The range can be at most ${MAX_DAYS} days` },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('team_activity_blocks')
      .select(
        'id, user_id, conversation_id, channel_id, rule, source, detail, created_at'
      )
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString())
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) {
      if (isMissingObject(error)) {
        return NextResponse.json(
          { error: UNLOCKS_UNAVAILABLE_MESSAGE },
          { status: 503 }
        );
      }
      console.error('[team-activity/blocks] read failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to load blocks' },
        { status: 500 }
      );
    }

    return NextResponse.json({ blocks: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
